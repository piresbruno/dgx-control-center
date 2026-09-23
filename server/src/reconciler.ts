import type { NodeState, ServerToAgent } from "@cc/shared";
import type { NodeRuntimeConfig } from "./agentHub.js";
import type { DesiredStateStore } from "./desiredState.js";
import type { NodeDirectory } from "./nodeDirectory.js";

/** Transport port: only what reconciliation needs from the hub. */
export interface AgentTransport {
  isConnected(sparkId: string): boolean;
  send(sparkId: string, msg: ServerToAgent): boolean;
}

/**
 * Reconciler (F1a): desired (store) vs actual (hub) per node, evaluated on a
 * tick plus event hooks. Drift ⇒ config-update push; staleness ⇒ degraded.
 * `computeNodeState` is pure — the bulk of the test surface.
 */

export interface ReconcileFacts {
  known: boolean;
  connected: boolean;
  everConnected: boolean;
  /** Wall-clock of the last metrics snapshot from this node (null = none yet). */
  lastMetricsTs: number | null;
  /** Metric cadence used for staleness math (system domain). */
  intervalMs: number;
  now: number;
  desiredConfig: NodeRuntimeConfig;
  /** Config last pushed to this agent (null = never pushed). */
  lastSentConfig: NodeRuntimeConfig | null;
  /** True while a config-update is in flight (until metrics confirm life). */
  applyingSince: number | null;
}

export interface ReconcileInputs extends ReconcileFacts {
  staleMultiplier: number;
}

/** Pure state machine: provisioning | reconciling | drifted | degraded | offline | consistent. */
export function computeNodeState(input: ReconcileInputs): NodeState {
  const { connected, everConnected, applyingSince, desiredConfig, lastSentConfig } = input;
  if (!connected) return everConnected ? "offline" : "provisioning";
  if (applyingSince !== null) return "reconciling";
  if (lastSentConfig !== null && JSON.stringify(desiredConfig) !== JSON.stringify(lastSentConfig)) {
    return "drifted";
  }
  const staleAfter = Math.max(input.intervalMs * input.staleMultiplier, 5_000);
  if (input.lastMetricsTs !== null && input.now - input.lastMetricsTs > staleAfter) return "degraded";
  if (input.lastMetricsTs === null) return "degraded";
  return "consistent";
}

export interface ReconcilerDeps {
  directory: NodeDirectory;
  desired: DesiredStateStore;
  registry: AgentTransport;
  /** Staleness multiplier (default 3× cadence). */
  staleMultiplier?: number;
  onStateChange?(sparkId: string, from: NodeState, to: NodeState): void;
  onConfigUpdate?(sparkId: string, config: NodeRuntimeConfig): void;
  now?: () => number;
}

interface NodeRuntime {
  lastMetricsTs: number | null;
  everConnected: boolean;
  lastSentConfig: NodeRuntimeConfig | null;
  applyingSince: number | null;
  state: NodeState;
}

export class Reconciler {
  private readonly runtime = new Map<string, NodeRuntime>();

  constructor(private readonly deps: ReconcilerDeps) {}

  /** Hub message hook: metrics confirm life and complete a config apply. */
  observeMessage(sparkId: string, msg: { type: string }): void {
    const rt = this.runtime.get(sparkId);
    if (!rt) return;
    rt.everConnected = true;
    if (msg.type === "metrics") {
      rt.lastMetricsTs = (this.deps.now ?? Date.now)();
      rt.applyingSince = null;
    }
  }

  /** Evaluate every known node; returns the new state map. */
  tick(now: number = (this.deps.now ?? Date.now)()): Map<string, NodeState> {
    const result = new Map<string, NodeState>();
    for (const node of this.deps.directory.list()) {
      const rt = this.ensureRuntime(node.id);
      const connected = this.deps.registry.isConnected(node.id);
      const desired = this.deps.desired.toRuntimeConfig(node.id);

      if (connected && !rt.everConnected) {
        rt.everConnected = true;
      }
      const lastSent = rt.lastSentConfig;
      const drift = lastSent !== null && JSON.stringify(desired) !== JSON.stringify(lastSent);
      if (connected && drift) {
        // Push desired config; reconciling until metrics confirm life.
        this.deps.registry.send(node.id, { type: "config-update", config: desired });
        this.deps.onConfigUpdate?.(node.id, desired);
        rt.lastSentConfig = desired;
        rt.applyingSince = now;
      }
      if (connected && lastSent === null) {
        // First contact after boot: seed the agent with the desired config.
        this.deps.registry.send(node.id, { type: "config-update", config: desired });
        this.deps.onConfigUpdate?.(node.id, desired);
        rt.lastSentConfig = desired;
      }

      const record = this.deps.directory.get(node.id);
      const cadences = Object.values(record?.intervals ?? desired.intervals).filter((v) => v > 0);
      const intervalMs = cadences.length ? Math.min(...cadences) : 1_000;
      const state = computeNodeState({
        known: true,
        connected,
        everConnected: rt.everConnected,
        lastMetricsTs: rt.lastMetricsTs,
        intervalMs,
        now,
        desiredConfig: desired,
        lastSentConfig: rt.lastSentConfig,
        applyingSince: rt.applyingSince,
        staleMultiplier: this.deps.staleMultiplier ?? 3,
      });
      if (state !== rt.state) {
        this.deps.onStateChange?.(node.id, rt.state, state);
        rt.state = state;
      }
      result.set(node.id, state);
    }
    return result;
  }

  stateOf(sparkId: string): NodeState {
    return this.runtime.get(sparkId)?.state ?? "provisioning";
  }

  private ensureRuntime(sparkId: string): NodeRuntime {
    let rt = this.runtime.get(sparkId);
    if (!rt) {
      rt = { lastMetricsTs: null, everConnected: false, lastSentConfig: null, applyingSince: null, state: "provisioning" };
      this.runtime.set(sparkId, rt);
    }
    return rt;
  }
}
