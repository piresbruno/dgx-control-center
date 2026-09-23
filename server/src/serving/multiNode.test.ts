import { describe, expect, it } from "vitest";
import { checkMultiNode, type PeerNode } from "./multiNode.js";

const dgx1: PeerNode = { id: "dgx1", lanIp: "100.95.7.60", kind: "spark", role: "head" };
const dgx2: PeerNode = { id: "dgx2", lanIp: "100.122.3.115", kind: "spark", role: "worker" };
const nas1: PeerNode = { id: "nas1", lanIp: "10.0.0.30", kind: "nas", role: "standalone" };

const CLUSTER = [dgx1, dgx2, nas1];

describe("checkMultiNode", () => {
  it("passes single-node recipes with no declared worker", () => {
    expect(checkMultiNode({ nnodes: 1, workerIp: null, headIp: null }, CLUSTER)).toEqual({ ok: true });
  });

  it("passes an exact 2-node declaration matching the configured pair", () => {
    expect(checkMultiNode({ nnodes: 2, workerIp: "100.122.3.115", headIp: null }, CLUSTER)).toEqual({ ok: true });
  });

  it("refuses when NNODES>1 but the probe found no WORKER_IP", () => {
    const r = checkMultiNode({ nnodes: 2, workerIp: null, headIp: null }, CLUSTER);
    expect(r).toMatchObject({ ok: false, code: "no-worker-declared", delta: 1 });
  });

  it("refuses a declared worker that matches no configured node, listing configured IPs", () => {
    const r = checkMultiNode({ nnodes: 2, workerIp: "10.9.9.9", headIp: null }, CLUSTER);
    expect(r).toMatchObject({ ok: false, code: "worker-unmatched", delta: 1 });
    expect(r.ok === false && r.reason).toContain("100.122.3.115");
  });

  it("reports the exact node-count delta", () => {
    // Recipe wants 3 nodes (2 workers) but only one is configured.
    const r = checkMultiNode({ nnodes: 3, workerIp: "100.122.3.115,10.9.9.9", headIp: null }, CLUSTER);
    expect(r).toMatchObject({ ok: false, code: "worker-unmatched", delta: 1 });
  });

  it("reports a positive delta when fewer workers are configured than declared", () => {
    const r = checkMultiNode({ nnodes: 3, workerIp: "100.122.3.115", headIp: null }, CLUSTER);
    expect(r).toMatchObject({ ok: false, code: "node-count-delta", delta: 1, declaredNodes: 3 });
  });

  it("refuses when the declared HEAD_IP is not the configured head", () => {
    const r = checkMultiNode({ nnodes: 2, workerIp: "100.122.3.115", headIp: "10.0.0.1" }, CLUSTER);
    expect(r).toMatchObject({ ok: false, code: "head-ip-mismatch" });
  });

  it("ignores nas nodes as worker candidates", () => {
    const r = checkMultiNode({ nnodes: 2, workerIp: "10.0.0.30", headIp: null }, CLUSTER);
    expect(r).toMatchObject({ ok: false, code: "worker-unmatched" });
  });
});
