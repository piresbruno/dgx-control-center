/**
 * Thermal guard (M5): auto-derate spark nodes whose GPU temperature crosses
 * the derate threshold (apply the quiet caps), with hysteresis — recovery
 * only after the temperature stays below the recovery threshold for a hold
 * window, then the node's desired profile is re-applied. Events ring capped.
 */
import fs from "node:fs";
import { z } from "zod";

export interface ThermalGuardConfig {
  /** GPU temperature that triggers auto-derate (°C). */
  derateTempC: number;
  /** Temperature below which recovery counting starts (°C). */
  recoverTempC: number;
  /** Continuous time below recoverTempC before reverting. */
  recoverHoldMs: number;
}

export const DEFAULT_THERMAL_CONFIG: ThermalGuardConfig = {
  derateTempC: 80,
  recoverTempC: 75,
  recoverHoldMs: 5 * 60_000,
};

export type ThermalState = "nominal" | "derated";

export interface ThermalEvent {
  ts: number;
  sparkId: string;
  kind: "derate" | "recover";
  tempC: number | null;
}

export interface ThermalSample {
  sparkId: string;
  gpuTempC: number | null;
}

const stateSchema = z.object({
  version: z.literal(1).default(1),
  nodes: z
    .record(
      z.string(),
      z.object({
        state: z.enum(["nominal", "derated"]).default("nominal"),
        /** When recovery counting started (ms epoch); null while above threshold. */
        belowSince: z.number().nullable().default(null),
      }),
    )
    .default({}),
  events: z.array(thermalEventSchemaDef()).default([]),
});

function thermalEventSchemaDef() {
  return z.object({
    ts: z.number(),
    sparkId: z.string(),
    kind: z.enum(["derate", "recover"]),
    tempC: z.number().nullable(),
  });
}

export interface ThermalGuardDeps {
  filePath: string;
  now?: () => number;
  config?: Partial<ThermalGuardConfig>;
  /** Max events retained (oldest evicted). */
  maxEvents?: number;
  /** Hooks: derate applies quiet caps, recover re-applies the desired profile. */
  onDerate?: (sparkId: string) => void;
  onRecover?: (sparkId: string) => void;
}

export class ThermalGuard {
  private state: z.infer<typeof stateSchema>;
  private readonly cfg: ThermalGuardConfig;
  private readonly maxEvents: number;

  constructor(private readonly deps: ThermalGuardDeps) {
    this.cfg = { ...DEFAULT_THERMAL_CONFIG, ...deps.config };
    this.maxEvents = deps.maxEvents ?? 100;
    this.state = this.load();
  }

  private load(): z.infer<typeof stateSchema> {
    try {
      if (!fs.existsSync(this.deps.filePath)) return stateSchema.parse({});
      return stateSchema.parse(JSON.parse(fs.readFileSync(this.deps.filePath, "utf8")));
    } catch (err) {
      console.error("[thermal] failed to load state:", err instanceof Error ? err.message : err);
      return stateSchema.parse({});
    }
  }

  private persist(): void {
    const tmp = `${this.deps.filePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, this.deps.filePath);
    } catch (err) {
      console.error("[thermal] failed to persist state:", err instanceof Error ? err.message : err);
    }
  }

  private pushEvent(event: ThermalEvent): void {
    this.state.events.unshift(event);
    if (this.state.events.length > this.maxEvents) this.state.events.length = this.maxEvents;
  }

  stateFor(sparkId: string): ThermalState {
    return this.state.nodes[sparkId]?.state ?? "nominal";
  }

  events(sparkId?: string): ThermalEvent[] {
    const all = [...this.state.events];
    return sparkId ? all.filter((e) => e.sparkId === sparkId) : all;
  }

  /**
   * Evaluate one tick of samples. Returns the events emitted this tick —
   * derate/recover hooks fire exactly on the transition.
   */
  tick(samples: ThermalSample[]): ThermalEvent[] {
    const now = this.deps.now?.() ?? Date.now();
    const emitted: ThermalEvent[] = [];
    for (const s of samples) {
      const node = this.state.nodes[s.sparkId] ?? { state: "nominal" as ThermalState, belowSince: null };
      if (s.gpuTempC == null) {
        this.state.nodes[s.sparkId] = node; // no data — hold state
        continue;
      }
      if (node.state === "nominal" && s.gpuTempC >= this.cfg.derateTempC) {
        node.state = "derated";
        node.belowSince = null;
        const event: ThermalEvent = { ts: now, sparkId: s.sparkId, kind: "derate", tempC: s.gpuTempC };
        this.pushEvent(event);
        emitted.push(event);
        this.deps.onDerate?.(s.sparkId);
      } else if (node.state === "derated") {
        if (s.gpuTempC < this.cfg.recoverTempC) {
          node.belowSince ??= now;
          if (now - node.belowSince >= this.cfg.recoverHoldMs) {
            node.state = "nominal";
            node.belowSince = null;
            const event: ThermalEvent = { ts: now, sparkId: s.sparkId, kind: "recover", tempC: s.gpuTempC };
            this.pushEvent(event);
            emitted.push(event);
            this.deps.onRecover?.(s.sparkId);
          }
        } else {
          node.belowSince = null; // hysteresis broken — restart the hold window
        }
      }
      this.state.nodes[s.sparkId] = node;
    }
    this.persist();
    return emitted;
  }
}
