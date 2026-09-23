/**
 * Multi-node recipe guard (M3): "start refuses with an exact-delta dialog
 * unless declared worker matches configured cluster worker" (PLAN).
 *
 * A multi-node recipe declares its topology in .env (NNODES, WORKER_USER,
 * WORKER_IP, HEAD_IP). Before dispatching `start`, the declared topology must
 * match the configured cluster EXACTLY — one matched spark worker per
 * declared worker IP, head pinned when the recipe sets HEAD_IP. Any delta
 * refuses the start and reports the numbers for the UI dialog.
 */

export interface RecipeTopology {
  nnodes: number;
  workerIp: string | null;
  headIp: string | null;
}

export interface PeerNode {
  id: string;
  lanIp: string | null;
  kind: string;
  role: string;
}

export type MultiNodeCheck =
  | { ok: true }
  | {
      ok: false;
      code:
        | "single-node"
        | "no-worker-declared"
        | "head-role-required"
        | "head-ip-mismatch"
        | "worker-unmatched"
        | "node-count-delta";
      reason: string;
      declaredNodes: number;
      matchedWorkers: string[];
      delta: number;
    };

export function checkMultiNode(recipe: RecipeTopology, peers: PeerNode[]): MultiNodeCheck {
  if (recipe.nnodes <= 1 && !recipe.workerIp) return { ok: true };

  if (recipe.nnodes > 1 && !recipe.workerIp) {
    return {
      ok: false,
      code: "no-worker-declared",
      reason: "recipe declares NNODES>1 but no WORKER_IP — probe found no worker",
      declaredNodes: recipe.nnodes,
      matchedWorkers: [],
      delta: recipe.nnodes - 1,
    };
  }

  const sparkPeers = peers.filter((p) => p.kind === "spark");
  const declaredWorkers = recipe.workerIp
    ? String(recipe.workerIp)
        .split(/[,\s]+/)
        .filter(Boolean)
    : [];

  // Each declared worker IP must match a configured spark worker node exactly.
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const ip of declaredWorkers) {
    const hit = sparkPeers.find((p) => p.role === "worker" && p.lanIp === ip);
    if (hit) matched.push(hit.id);
    else unmatched.push(ip);
  }
  if (unmatched.length > 0) {
    const configured = sparkPeers.filter((p) => p.role === "worker").map((p) => `${p.id}(${p.lanIp ?? "?"})`);
    return {
      ok: false,
      code: "worker-unmatched",
      reason: `declared WORKER_IP ${unmatched.join(", ")} matches no configured spark worker (configured: ${configured.join(", ") || "none"})`,
      declaredNodes: recipe.nnodes,
      matchedWorkers: matched,
      delta: unmatched.length,
    };
  }

  // NNODES exact-delta: matched workers + 1 head must equal the declaration.
  if (recipe.nnodes > 1) {
    const expected = recipe.nnodes - 1;
    if (matched.length !== expected) {
      return {
        ok: false,
        code: "node-count-delta",
        reason: `recipe declares ${recipe.nnodes} nodes but the cluster provides ${matched.length + 1}`,
        declaredNodes: recipe.nnodes,
        matchedWorkers: matched,
        delta: expected - matched.length,
      };
    }
  }

  // Optional head pin: the target head must own the declared HEAD_IP.
  if (recipe.headIp && !peers.some((p) => p.role === "head" && p.lanIp === recipe.headIp)) {
    return {
      ok: false,
      code: "head-ip-mismatch",
      reason: `declared HEAD_IP ${recipe.headIp} does not match any configured head node`,
      declaredNodes: recipe.nnodes,
      matchedWorkers: matched,
      delta: 1,
    };
  }

  // Single-node recipes must not be pointed at a head that has workers pinned
  // in the recipe (workerIp set, nnodes 1) — topology contradiction.
  if (recipe.nnodes <= 1 && declaredWorkers.length > 0 && matched.length === 0) {
    return {
      ok: false,
      code: "worker-unmatched",
      reason: `declared WORKER_IP ${declaredWorkers.join(", ")} matches no configured spark worker`,
      declaredNodes: recipe.nnodes,
      matchedWorkers: [],
      delta: declaredWorkers.length,
    };
  }

  return { ok: true };
}
