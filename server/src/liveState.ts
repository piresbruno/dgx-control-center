import type { AgentToServer, MetricsMsg, NodeState } from "@cc/shared";

/**
 * LiveState (F1a): server-held latest view of every node — fed by agent
 * messages and reconciler state changes; served to browsers as an immediate
 * snapshot on connect plus deltas afterwards.
 */

export interface LiveNode {
  sparkId: string;
  name: string;
  kind: string;
  role: string;
  state: NodeState;
  /** Latest metrics per domain (raw domain payloads, latest-wins). */
  domains: Record<string, unknown>;
  lastMetricsTs: number | null;
}

export interface LiveSnapshot {
  version: 1;
  nodes: LiveNode[];
}

export interface LiveStateDeps {
  /** name/kind/role resolution for nodes the directory knows. */
  describe(sparkId: string): { name: string; kind: string; role: string } | null;
  stateOf(sparkId: string): NodeState;
}

export class LiveState {
  private nodes = new Map<string, { domains: Record<string, unknown>; lastMetricsTs: number | null }>();

  constructor(private readonly deps: LiveStateDeps) {}

  observeMessage(sparkId: string, msg: AgentToServer): void {
    if (msg.type === "metrics") this.observeMetrics(sparkId, msg);
  }

  observeMetrics(sparkId: string, msg: Pick<MetricsMsg, "ts" | "domains">): void {
    const node = this.nodes.get(sparkId) ?? { domains: {}, lastMetricsTs: null };
    for (const [domain, data] of Object.entries(msg.domains)) node.domains[domain] = data;
    node.lastMetricsTs = msg.ts;
    this.nodes.set(sparkId, node);
  }

  snapshot(): LiveSnapshot {
    const nodes: LiveNode[] = [];
    for (const [sparkId, node] of this.nodes) {
      const meta = this.deps.describe(sparkId);
      nodes.push({
        sparkId,
        name: meta?.name ?? sparkId,
        kind: meta?.kind ?? "spark",
        role: meta?.role ?? "standalone",
        state: this.deps.stateOf(sparkId),
        domains: node.domains,
        lastMetricsTs: node.lastMetricsTs,
      });
    }
    return { version: 1, nodes };
  }
}
