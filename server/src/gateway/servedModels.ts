/**
 * Served-models router core (M4/F4): maps model aliases → ordered deployment
 * target chains, healthy-first, with round-robin inside a health class and a
 * 404-style unknown-alias report carrying the live served-name list.
 *
 * Pure routing here; the gateway proxy, auth injection and request recording
 * are separate layers. Targets address engines directly (nodeId + port) so a
 * chain survives deployment-record re-creation; health is injected.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";

export interface ServedModelTarget {
  nodeId: string;
  port: number;
  /** Upstream model id to send (defaults to the alias). */
  modelId?: string | null;
}

export interface ServedModelConfig {
  id: string;
  /** Public model name clients request. */
  alias: string;
  /** Ordered fallback chain; healthy-first ranking reorders at request time. */
  targets: ServedModelTarget[];
  /** Router-managed (llama-swap parity): spin up on first request, stop on idle. */
  onDemand?: { recipeId: string; idleStopS?: number | null } | null;
  /** Vision-capable upstream: chat attachments route here. */
  vision?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Health grade of one target; lower ranks first. */
export type TargetHealth = "healthy" | "degraded" | "down" | "unknown";

const HEALTH_RANK: Record<TargetHealth, number> = { healthy: 0, degraded: 1, unknown: 2, down: 3 };

export interface RankedTarget extends ServedModelTarget {
  health: TargetHealth;
}

/**
 * Healthy-first stable ranking; round-robin inside the same health class via
 * a per-alias counter (caller-owned so this stays pure).
 */
export function rankTargets(
  targets: ServedModelTarget[],
  healthOf: (t: ServedModelTarget) => TargetHealth,
  rrCounter = 0,
): RankedTarget[] {
  const graded = targets.map((t) => ({ ...t, health: healthOf(t) }));
  const byClass = new Map<TargetHealth, RankedTarget[]>();
  for (const t of graded) {
    const list = byClass.get(t.health) ?? [];
    list.push(t);
    byClass.set(t.health, list);
  }
  const order: TargetHealth[] = ["healthy", "degraded", "unknown", "down"];
  const out: RankedTarget[] = [];
  for (const cls of order) {
    const list = byClass.get(cls) ?? [];
    if (list.length > 1) {
      const shift = rrCounter % list.length;
      out.push(...list.slice(shift), ...list.slice(0, shift));
    } else {
      out.push(...list);
    }
  }
  return out;
}

export interface RouteResult {
  alias: string;
  /** Ranked candidate chain (try in order). */
  chain: RankedTarget[];
  /** Router-managed models spin up on first request when all targets are down. */
  onDemand: boolean;
}

export type RouteFailure = { error: "unknown-alias"; servedNames: string[] } | { error: "no-targets"; alias: string };

export function resolveRoute(
  configs: ServedModelConfig[],
  alias: string,
  healthOf: (t: ServedModelTarget) => TargetHealth,
  rrCounter = 0,
): RouteResult | RouteFailure {
  const cfg = configs.find((c) => c.alias === alias);
  if (!cfg) {
    return { error: "unknown-alias", servedNames: configs.map((c) => c.alias).sort() };
  }
  if (cfg.targets.length === 0 && !cfg.onDemand) {
    return { error: "no-targets", alias };
  }
  // Router-managed + all-down: the chain is still returned ranked; the gateway
  // checks `onDemand` and spins the recipe up before retrying (later M4 task).
  const chain = rankTargets(cfg.targets, healthOf, rrCounter);
  return { alias, chain, onDemand: Boolean(cfg.onDemand) };
}

// ─── Store ─────────────────────────────────────────────────

const targetSchema = z.object({
  nodeId: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  modelId: z.string().min(1).nullable().default(null),
});

const configSchema = z.object({
  id: z.string().min(1),
  alias: z.string().min(1).max(120),
  targets: z.array(targetSchema).default([]),
  onDemand: z.object({ recipeId: z.string().min(1), idleStopS: z.number().int().min(5).nullable().default(null) }).nullable().default(null),
  vision: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ServedModelRecord = z.infer<typeof configSchema>;

export interface ServedModelsStoreDeps {
  filePath: string;
  now?: () => number;
}

/** JSON-file store of alias → target-chain configs; aliases unique. */
export class ServedModelsStore {
  private readonly models = new Map<string, ServedModelRecord>();
  private readonly file: string;
  private readonly now: () => number;

  constructor(deps: ServedModelsStoreDeps) {
    this.file = deps.filePath;
    this.now = deps.now ?? Date.now;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const m of raw.models ?? []) {
        const parsed = configSchema.safeParse(m);
        if (parsed.success) this.models.set(parsed.data.id, parsed.data);
      }
    } catch (err) {
      console.error("[served-models] failed to load state:", err instanceof Error ? err.message : err);
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    const models = [...this.models.values()].sort((a, b) => a.alias.localeCompare(b.alias));
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, models }, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[served-models] failed to persist state:", err instanceof Error ? err.message : err);
    }
  }

  list(): ServedModelRecord[] {
    return [...this.models.values()];
  }

  get(id: string): ServedModelRecord | null {
    return this.models.get(id) ?? null;
  }

  byAlias(alias: string): ServedModelRecord | null {
    for (const m of this.models.values()) if (m.alias === alias) return m;
    return null;
  }

  upsert(input: {
    id?: string;
    alias: string;
    targets: ServedModelTarget[];
    onDemand?: { recipeId: string; idleStopS?: number | null } | null;
    vision?: boolean;
  }): ServedModelRecord {
    const aliasTaken = [...this.models.values()].find((m) => m.alias === input.alias && m.id !== input.id);
    if (aliasTaken) throw new Error(`alias already served by ${aliasTaken.id}`);
    const id = input.id ?? this.byAlias(input.alias)?.id ?? `sm-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
    const existing = this.models.get(id);
    const rec: ServedModelRecord = {
      id,
      alias: input.alias,
      targets: input.targets.map((t) => ({ nodeId: t.nodeId, port: t.port, modelId: t.modelId ?? null })),
      onDemand: input.onDemand ? { recipeId: input.onDemand.recipeId, idleStopS: input.onDemand.idleStopS ?? null } : null,
      vision: input.vision ?? existing?.vision ?? false,
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
    };
    this.models.set(id, rec);
    this.persist();
    return rec;
  }

  remove(id: string): boolean {
    if (!this.models.delete(id)) return false;
    this.persist();
    return true;
  }
}
