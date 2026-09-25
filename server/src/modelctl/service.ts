import { z } from "zod";

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
  /**
   * Execution backend (ADR-0009): inventories always run somewhere else than
   * the dashboard process — the store catalog dispatches to a node via the
   * agent job channel, node-local inventories run over the node SSH seam.
   */
  runner: ModelctlRunner;
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
  private readonly runner: ModelctlRunner;
  private readonly now: () => number;

  constructor(opts: ModelctlOpts) {
    this.runner = opts.runner;
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
    const runner = target.runner ?? this.runner;
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
}

