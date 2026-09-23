import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

/** One active model in a modelctl inventory (NAS store or node-local cache). */
export const modelRow = z.object({
  name: z.string().min(1),
  repository: z.string().min(1),
  runtime: z.string().min(1).optional(),
  bytes: z.number().nonnegative().optional(),
});
export type ModelRow = z.infer<typeof modelRow>;

const listPayload = z.array(modelRow);

export type ModelctlRunner = (args: string[]) => Promise<string>;

/** Cache policy (sparkControl parity): NAS 60 s, node 30 s, stale 5× TTL. */
export const NAS_TTL_MS = 60_000;
export const NODE_TTL_MS = 30_000;
export const STALE_MULTIPLIER = 5;
export const VERSION_TTL_MS = 5 * 60_000;

export interface InventorySnapshot {
  targetId: string;
  models: ModelRow[];
  fetchedAt: number;
  stale: boolean;
  error: string | null;
}

interface CacheEntry {
  models: ModelRow[];
  fetchedAt: number;
}

export interface InventoryTarget {
  targetId: string;
  args: string[];
  ttlMs: number;
  runner?: ModelctlRunner;
}

export interface ModelctlOpts {
  /** Default runner for targets without an explicit one. */
  runner?: ModelctlRunner;
  modelctlPath?: string;
  now?: () => number;
}

/**
 * Runs modelctl inventories per target with TTL caching. Last good result is
 * served (marked stale) for STALE_MULTIPLIER × TTL; after that, or before the
 * first success, errors surface as a snapshot with error set.
 */
export class ModelctlService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lastGood = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<InventorySnapshot>>();
  private readonly versionCache: { value: string | null; fetchedAt: number } = {
    value: null,
    fetchedAt: Number.NEGATIVE_INFINITY,
  };
  private readonly defaultRunner: ModelctlRunner;
  private readonly modelctlPath: string;
  private readonly now: () => number;

  constructor(opts: ModelctlOpts = {}) {
    this.defaultRunner =
      opts.runner ??
      (async (args) => {
        const { stdout } = await execFileAsync(this.modelctlPath, args, {
          timeout: 30_000,
          maxBuffer: 32 * 1024 * 1024,
        });
        return stdout;
      });
    this.modelctlPath = opts.modelctlPath ?? "modelctl";
    this.now = opts.now ?? Date.now;
  }

  /** Fetch (or serve cached) inventory for a target. Never throws. */
  async inventory(target: InventoryTarget): Promise<InventorySnapshot> {
    const cached = this.cache.get(target.targetId);
    if (cached && this.now() - cached.fetchedAt <= target.ttlMs) {
      return { targetId: target.targetId, models: cached.models, fetchedAt: cached.fetchedAt, stale: false, error: null };
    }

    const pending = this.inFlight.get(target.targetId);
    if (pending) return pending;
    const fetch = this.fetch(target).finally(() => this.inFlight.delete(target.targetId));
    this.inFlight.set(target.targetId, fetch);
    return fetch;
  }

  private async fetch(target: InventoryTarget): Promise<InventorySnapshot> {
    const runner = target.runner ?? this.defaultRunner;
    try {
      const stdout = await runner(target.args);
      const parsed = listPayload.parse(JSON.parse(stdout));
      const fetchedAt = this.now();
      this.cache.set(target.targetId, { models: parsed, fetchedAt });
      this.lastGood.set(target.targetId, { models: parsed, fetchedAt });
      return { targetId: target.targetId, models: parsed, fetchedAt, stale: false, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Refresh failed: serve the last good snapshot (stale) within 5× TTL.
      const good = this.lastGood.get(target.targetId);
      if (good && this.now() <= good.fetchedAt + target.ttlMs * STALE_MULTIPLIER) {
        return { targetId: target.targetId, models: good.models, fetchedAt: good.fetchedAt, stale: true, error: message };
      }
      return { targetId: target.targetId, models: [], fetchedAt: this.now(), stale: false, error: message };
    }
  }

  /** `modelctl --version`, cached VERSION_TTL_MS. Null when the binary is absent. */
  async version(): Promise<string | null> {
    const now = this.now();
    if (now - this.versionCache.fetchedAt < VERSION_TTL_MS) return this.versionCache.value;
    try {
      const stdout = await this.defaultRunner(["--version"]);
      this.versionCache.value = stdout.trim() || null;
    } catch {
      this.versionCache.value = null;
    }
    this.versionCache.fetchedAt = now;
    return this.versionCache.value;
  }
}

/** Resolve the modelctl binary: bare PATH name, else the ~/.local/bin fallback. */
export async function resolveModelctlPath(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  for (const candidate of ["modelctl", `${process.env.HOME ?? ""}/.local/bin/modelctl`]) {
    try {
      await execFileAsync(candidate, ["--version"], { timeout: 10_000 });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}
