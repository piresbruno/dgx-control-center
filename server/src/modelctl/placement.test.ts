import { describe, expect, it } from "vitest";
import { DISK_HEADROOM, NAS_LINK_MB_S, NODE_LINK_MB_S, etaSeconds, planPlacement, routeSpeedMbS } from "./placement.js";

const GB = 1024 * 1024 * 1024;

describe("placement math", () => {
  it("computes ETAs from the route speeds", () => {
    expect(routeSpeedMbS("sync-local")).toBe(NAS_LINK_MB_S);
    expect(routeSpeedMbS("push")).toBe(NODE_LINK_MB_S);
    // 110 GB over 1 GbE practical (~110 MB/s) ≈ 1024 s
    expect(etaSeconds(110 * GB, "sync-local")).toBe(Math.ceil((110 * GB) / (NAS_LINK_MB_S * 1024 * 1024)));
  });

  it("ranks NAS-source candidates: feasible first, then fastest ETA", () => {
    const plan = planPlacement({
      modelBytes: 50 * GB,
      source: "nas",
      candidates: [
        { nodeId: "slow", freeBytes: 100 * GB },
        { nodeId: "full", freeBytes: 1 * GB },
      ],
    });
    expect(plan.entries.map((e) => e.nodeId)).toEqual(["slow", "full"]);
    expect(plan.entries[0]).toMatchObject({ feasible: true, route: "sync-local" });
    expect(plan.entries.find((e) => e.nodeId === "full")?.feasible).toBe(false);
  });

  it("uses push routing for node sources and skips the source node", () => {
    const plan = planPlacement({
      modelBytes: 10 * GB,
      source: "dgx1",
      candidates: [
        { nodeId: "dgx1", freeBytes: 500 * GB },
        { nodeId: "dgx2", freeBytes: 500 * GB },
      ],
    });
    expect(plan.entries[0]).toMatchObject({ nodeId: "dgx2", route: "push", feasible: true });
    expect(plan.entries[1]).toMatchObject({ nodeId: "dgx1", feasible: false, reason: "model already on this node" });
  });

  it("flags infeasible with the missing-disk deficit", () => {
    const modelBytes = 100 * GB;
    const plan = planPlacement({
      modelBytes,
      source: "nas",
      candidates: [{ nodeId: "dgx2", freeBytes: 100 * GB }], // exactly modelBytes < modelBytes/0.9
    });
    const entry = plan.entries[0]!;
    expect(entry.feasible).toBe(false);
    expect(entry.reason).toContain("more free disk");
    expect(entry.reason).toContain(`${Math.ceil((Math.ceil(modelBytes / DISK_HEADROOM) - 100 * GB) / (1024 * 1024))}`);
  });
});
