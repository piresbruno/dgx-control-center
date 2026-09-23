/**
 * Placement planner (M2): rank candidate nodes for hosting a model and
 * estimate transfer times for the two routes modelctl offers:
 *   - nas → node   (`modelctl sync-local`, store mounted over LAN)
 *   - node → node  (`modelctl push`, direct node-to-node link)
 *
 * Pure math, no I/O — callers supply free disk bytes (inventory + statfs via
 * jobs) and the engine budgets refine feasibility at M3.
 */

/** Practical transfer rates (MB/s). Defaults are conservative; tune via settings later. */
export const NAS_LINK_MB_S = 110; // 1 GbE SMB/NFS practical
export const NODE_LINK_MB_S = 2_500; // ConnectX-7 under ssh+rsync practical

/** Keep this fraction of the destination disk free after a sync. */
export const DISK_HEADROOM = 0.9;

export type PlacementRoute = "sync-local" | "push";

export interface PlacementCandidate {
  nodeId: string;
  freeBytes: number;
}

export interface PlacementPlanEntry {
  nodeId: string;
  route: PlacementRoute;
  /** Estimated transfer seconds (null when unroutable from the source). */
  etaSeconds: number | null;
  feasible: boolean;
  reason: string | null;
}

export interface PlacementPlan {
  modelBytes: number;
  source: "nas" | string;
  entries: PlacementPlanEntry[];
}

const MB = 1024 * 1024;

export function routeSpeedMbS(route: PlacementRoute): number {
  return route === "sync-local" ? NAS_LINK_MB_S : NODE_LINK_MB_S;
}

export function etaSeconds(modelBytes: number, route: PlacementRoute): number {
  return Math.ceil(modelBytes / (routeSpeedMbS(route) * MB));
}

/**
 * Rank candidates. Feasibility: destination must hold the model with 10%
 * headroom. Route: NAS source → sync-local everywhere; node source → push.
 */
export function planPlacement(input: {
  modelBytes: number;
  source: "nas" | string;
  candidates: PlacementCandidate[];
}): PlacementPlan {
  const entries = input.candidates.map<PlacementPlanEntry>((candidate) => {
    const route: PlacementRoute = input.source === "nas" ? "sync-local" : "push";
    if (input.source === candidate.nodeId) {
      return { nodeId: candidate.nodeId, route, etaSeconds: null, feasible: false, reason: "model already on this node" };
    }
    // The model may occupy at most 90% of the destination's free space.
    const minFreeBytes = Math.ceil(input.modelBytes / DISK_HEADROOM);
    if (candidate.freeBytes < minFreeBytes) {
      return {
        nodeId: candidate.nodeId,
        route,
        etaSeconds: etaSeconds(input.modelBytes, route),
        feasible: false,
        reason: `needs ${Math.ceil((minFreeBytes - candidate.freeBytes) / MB)} MB more free disk`,
      };
    }
    return { nodeId: candidate.nodeId, route, etaSeconds: etaSeconds(input.modelBytes, route), feasible: true, reason: null };
  });

  entries.sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    return (a.etaSeconds ?? Number.POSITIVE_INFINITY) - (b.etaSeconds ?? Number.POSITIVE_INFINITY);
  });

  return { modelBytes: input.modelBytes, source: input.source, entries };
}
