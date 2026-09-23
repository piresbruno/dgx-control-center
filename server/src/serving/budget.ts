/**
 * VRAM/UMA budget estimator (M3). DGX Spark GB10 is unified memory: the GPU
 * shares the system DRAM pool, so "VRAM fit" is a system-memory computation.
 *
 * Per node: need = ceil(modelBytes / tp) inflated by an activation/NCCL
 * overhead, plus an explicit KV reserve when known; available = total minus an
 * OS reserve minus current non-model usage. fits = need <= available on EVERY
 * participating node (TP splits weights evenly).
 */

/** Fraction of total unified memory reserved for OS/desktop (GB10 ≈ 8%). */
export const OS_RESERVE = 0.08;
/**
 * Multiplier over raw model weights for activations, CUDA graphs and NCCL
 * buffers at serving time (vLLM observed range 10–20%; conservative 15%).
 */
export const ACTIVATION_OVERHEAD = 0.15;

export interface BudgetNode {
  id: string;
  /** Unified-memory total in bytes (from the node's memory metrics). */
  memoryTotalBytes: number;
  /** Current used bytes (non-model baseline at estimate time). */
  memoryUsedBytes: number;
}

export interface BudgetInput {
  modelBytes: number;
  /** Tensor-parallel width sharing the weights across nodes. */
  tp: number;
  /** Explicit KV-cache reserve per node in bytes (optional). */
  kvBytesPerNode?: number;
  nodes: BudgetNode[];
}

export interface BudgetNodeResult {
  nodeId: string;
  modelBytes: number;
  overheadBytes: number;
  kvBytes: number;
  needBytes: number;
  availableBytes: number;
  marginBytes: number;
  fits: boolean;
}

export type BudgetResult =
  | {
      ok: true;
      fits: true;
      tp: number;
      perNode: BudgetNodeResult[];
    }
  | {
      ok: true;
      fits: false;
      tp: number;
      perNode: BudgetNodeResult[];
      reason: string;
    }
  | { ok: false; reason: string };

export function estimateBudget(input: BudgetInput): BudgetResult {
  const { modelBytes, tp, kvBytesPerNode = 0, nodes } = input;
  if (!Number.isFinite(modelBytes) || modelBytes <= 0) return { ok: false, reason: "model size unknown — no bytes in inventory" };
  if (!Number.isInteger(tp) || tp < 1) return { ok: false, reason: "tp must be a positive integer" };
  if (nodes.length === 0) return { ok: false, reason: "no target nodes" };
  if (tp > 1 && nodes.length !== tp) {
    return { ok: false, reason: `tp=${tp} requires exactly ${tp} participating nodes (got ${nodes.length})` };
  }

  const modelShare = Math.ceil(modelBytes / tp);
  const overhead = Math.ceil(modelShare * ACTIVATION_OVERHEAD);
  const perNode = nodes.map((n) => {
    const available = Math.floor(n.memoryTotalBytes * (1 - OS_RESERVE)) - n.memoryUsedBytes;
    const need = modelShare + overhead + kvBytesPerNode;
    return {
      nodeId: n.id,
      modelBytes: modelShare,
      overheadBytes: overhead,
      kvBytes: kvBytesPerNode,
      needBytes: need,
      availableBytes: available,
      marginBytes: available - need,
      fits: need <= available,
    };
  });

  const unfit = perNode.filter((p) => !p.fits);
  if (unfit.length > 0) {
    const worst = unfit.reduce((a, b) => (a.marginBytes <= b.marginBytes ? a : b));
    return {
      ok: true,
      fits: false,
      tp,
      perNode,
      reason: `${worst.nodeId} needs ${(worst.needBytes / 2 ** 30).toFixed(1)} GiB but only ${(worst.availableBytes / 2 ** 30).toFixed(1)} GiB is available (over OS reserve + current use)`,
    };
  }
  return { ok: true, fits: true, tp, perNode };
}

/** Tightest margin across nodes (UI bar width / sort key). */
export function worstMargin(result: Extract<BudgetResult, { ok: true }>): number {
  return result.perNode.reduce((min, p) => Math.min(min, p.marginBytes), Number.POSITIVE_INFINITY);
}
