/**
 * On-demand deployments (M4/F4, llama-swap parity): router-managed served
 * models spin their recipe up on first request and stop after an idle
 * timeout. Always-on deployments bypass this layer.
 */
import type { DeploymentStore, DeploymentSupervisor } from "../serving/deployments.js";
import type { ServedModelsStore } from "./servedModels.js";

export interface OnDemandDeps {
  servedModels: ServedModelsStore;
  deployments: Pick<import("../serving/deployments.js").DeploymentStore, "list" | "upsertForRecipe" | "remove">;
  supervisor: Pick<DeploymentSupervisor, "start" | "stop" | "probe">;
  now?: () => number;
  /** How long a router-managed deployment may idle before it is stopped. */
  defaultIdleStopS?: number;
  /** Sweep cadence (ms). */
  sweepIntervalMs?: number;
}

export interface SpinUpOutcome {
  ok: boolean;
  reason: "running" | "started" | "no-config" | "start-failed";
  detail?: string;
}

export class OnDemandManager {
  private readonly lastRequestAt = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** In-flight spin-ups per alias (single-flight). */
  private readonly spinning = new Map<string, Promise<SpinUpOutcome>>();

  constructor(private readonly deps: OnDemandDeps) {}

  /** Register activity for idle accounting. */
  touch(alias: string): void {
    this.lastRequestAt.set(alias, this.deps.now?.() ?? Date.now());
  }

  /** Ensure the router-managed model's recipe deployment is running. */
  ensureUp(alias: string): Promise<SpinUpOutcome> {
    const inflight = this.spinning.get(alias);
    if (inflight) return inflight;
    const run = this.spinUp(alias).finally(() => this.spinning.delete(alias));
    this.spinning.set(alias, run);
    return run;
  }

  private async spinUp(alias: string): Promise<SpinUpOutcome> {
    const cfg = this.deps.servedModels.byAlias(alias);
    if (!cfg?.onDemand) return { ok: false, reason: "no-config" };
    const recipeId = cfg.onDemand.recipeId;
    let dep = this.deps.deployments.list().find((d) => d.recipeId === recipeId) ?? null;
    if (dep?.desired === "running" && dep.jobState === "done") {
      this.touch(alias);
      return { ok: true, reason: "running" };
    }
    if (!dep) {
      dep = this.deps.deployments.upsertForRecipe(recipeId, { sparkId: cfg.targets[0]?.nodeId ?? "", entry: null, port: null, servedName: alias });
    }
    const result = this.deps.supervisor.start(dep.id);
    if ("error" in result) return { ok: false, reason: "start-failed", detail: result.error };
    this.touch(alias);
    return { ok: true, reason: "started" };
  }

  /**
   * Stop router-managed deployments idle beyond their idleStopS. Called on a
   * timer; also exported for tests. Returns stopped deployment ids.
   */
  sweepIdle(): string[] {
    const now = this.deps.now?.() ?? Date.now();
    const stopped: string[] = [];
    for (const cfg of this.deps.servedModels.list()) {
      if (!cfg.onDemand) continue;
      const idleS = cfg.onDemand.idleStopS ?? this.deps.defaultIdleStopS ?? 300;
      const last = this.lastRequestAt.get(cfg.alias);
      if (last == null) continue; // never used — leave alone
      const dep = this.deps.deployments.list().find((d) => d.recipeId === cfg.onDemand!.recipeId);
      if (!dep || dep.desired !== "running") continue;
      if (now - last > idleS * 1000) {
        const r = this.deps.supervisor.stop(dep.id);
        if (!("error" in r)) stopped.push(dep.id);
      }
    }
    return stopped;
  }

  /** Start the idle sweeper; returns a stop function. */
  startSweeper(): () => void {
    const ms = this.deps.sweepIntervalMs ?? 30_000;
    this.sweepTimer = setInterval(() => this.sweepIdle(), ms);
    return () => {
      if (this.sweepTimer) clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    };
  }
}
