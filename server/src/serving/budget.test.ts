import { describe, expect, it } from "vitest";
import { estimateBudget, worstMargin, ACTIVATION_OVERHEAD, OS_RESERVE } from "./budget.js";

const GIB = 2 ** 30;
// GB10: 128 GiB unified, ~30 GiB in use by OS/desktop baseline.
const NODE = { id: "dgx1", memoryTotalBytes: 128 * GIB, memoryUsedBytes: 30 * GIB };

describe("estimateBudget", () => {
  it("refuses unknown model sizes, bad tp, and no nodes", () => {
    expect(estimateBudget({ modelBytes: 0, tp: 1, nodes: [NODE] })).toMatchObject({ ok: false });
    expect(estimateBudget({ modelBytes: GIB, tp: 0, nodes: [NODE] })).toMatchObject({ ok: false });
    expect(estimateBudget({ modelBytes: GIB, tp: 1, nodes: [] })).toMatchObject({ ok: false });
  });

  it("requires exactly tp participating nodes", () => {
    const r = estimateBudget({ modelBytes: GIB, tp: 2, nodes: [NODE] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("exactly 2");
  });

  it("fits a small model with a positive margin on one node", () => {
    const r = estimateBudget({ modelBytes: 20 * GIB, tp: 1, nodes: [NODE] });
    expect(r.ok).toBe(true);
    if (r.ok && r.fits) {
      const p = r.perNode[0]!;
      expect(p.modelBytes).toBe(20 * GIB);
      expect(p.overheadBytes).toBe(Math.ceil(20 * GIB * ACTIVATION_OVERHEAD));
      expect(p.availableBytes).toBe(Math.floor(128 * GIB * (1 - OS_RESERVE)) - 30 * GIB);
      expect(p.fits).toBe(true);
      expect(worstMargin(r)).toBe(p.marginBytes);
    }
  });

  it("splits weights evenly across a TP=2 pair", () => {
    const r = estimateBudget({ modelBytes: 200 * GIB, tp: 2, nodes: [NODE, { ...NODE, id: "dgx2" }] });
    expect(r.ok).toBe(true);
    if (r.ok && r.fits) {
      expect(r.perNode[0]!.modelBytes).toBe(100 * GIB);
      expect(r.perNode[1]!.modelBytes).toBe(100 * GIB);
    }
  });

  it("refuses when the node cannot hold its share, naming the worst node", () => {
    const r = estimateBudget({ modelBytes: 250 * GIB, tp: 2, nodes: [NODE, { ...NODE, id: "dgx2", memoryUsedBytes: 100 * GIB }] });
    expect(r.ok).toBe(true);
    if (r.ok && !r.fits) expect(r.reason).toContain("dgx2");
    else if (r.ok) throw new Error("expected budget refusal");
  });

  it("includes the explicit KV reserve in the per-node need", () => {
    const r = estimateBudget({ modelBytes: 20 * GIB, tp: 1, kvBytesPerNode: 8 * GIB, nodes: [NODE] });
    if (r.ok) expect(r.perNode[0]!.needBytes).toBe(20 * GIB + Math.ceil(20 * GIB * ACTIVATION_OVERHEAD) + 8 * GIB);
  });
});
