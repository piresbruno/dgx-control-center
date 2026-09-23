import { describe, expect, it } from "vitest";
import { JobsManager } from "./jobsManager.js";
import type { AgentToServer, ServerToAgent } from "@cc/shared";

interface Harness {
  manager: JobsManager;
  sent: ServerToAgent[];
  connected: boolean;
  now(): number;
}

function harness(opts: { maxJobsPerNode?: number; maxOutputBytes?: number } = {}): Harness {
  const state: Harness = {
    sent: [],
    connected: true,
    now: () => 0,
    manager: null as unknown as JobsManager,
  };
  let clock = 1_000;
  state.now = () => clock;
  state.manager = new JobsManager({
    send: (nodeId, msg) => {
      if (!state.connected) return false;
      state.sent.push(msg);
      return true;
    },
    isConnected: () => state.connected,
    now: () => clock,
    genReqId: () => `req-${state.sent.length + 1}`,
    maxJobsPerNode: opts.maxJobsPerNode,
    maxOutputBytes: opts.maxOutputBytes,
  });
  return state;
}

const jobOut = (reqId: string, chunk: string): AgentToServer =>
  ({ type: "job-out", reqId, stream: "out", chunk }) as unknown as AgentToServer;
const jobExit = (reqId: string, code: number | null): AgentToServer =>
  ({ type: "job-exit", reqId, code, signal: null }) as unknown as AgentToServer;

describe("JobsManager", () => {
  it("dispatches job-run, accumulates output, and finalizes on job-exit", () => {
    const h = harness();
    const result = h.manager.dispatch("dgx1", "modelctl-list-local", ["modelctl", "list", "--local", "--json"]);
    expect("reqId" in result && result.reqId).toBe("req-1");
    expect(h.sent[0]).toMatchObject({ type: "job-run", reqId: "req-1" });

    h.manager.observeMessage("dgx1", jobOut("req-1", "partial "));
    h.manager.observeMessage("dgx1", jobOut("req-1", "output\n"));
    h.manager.observeMessage("dgx1", jobExit("req-1", 0));

    const job = h.manager.get("req-1")!;
    expect(job.state).toBe("done");
    expect(job.output).toBe("partial output\n");
    expect(job.exitCode).toBe(0);
  });

  it("rejects dispatch when the node is not connected (503 path)", () => {
    const h = harness();
    h.connected = false;
    expect(h.manager.dispatch("dgx1", "modelctl-version", ["modelctl", "--version"])).toEqual({ error: "not-connected" });
  });

  it("enforces single-flight per node+kind but allows other kinds", () => {
    const h = harness();
    expect(h.manager.dispatch("dgx1", "modelctl-list-local", ["a"])).toHaveProperty("reqId");
    expect(h.manager.dispatch("dgx1", "modelctl-list-local", ["a"])).toEqual({ error: "conflict" });
    expect(h.manager.dispatch("dgx1", "uv-version", ["uv", "--version"])).toHaveProperty("reqId");
    expect(h.manager.dispatch("dgx2", "modelctl-list-local", ["a"])).toHaveProperty("reqId");
  });

  it("marks non-zero exits failed", () => {
    const h = harness();
    h.manager.dispatch("dgx1", "modelctl-version", ["modelctl", "--version"]);
    h.manager.observeMessage("dgx1", jobExit("req-1", 1));
    expect(h.manager.get("req-1")!.state).toBe("failed");
  });

  it("marks running jobs interrupted on node disconnect", () => {
    const h = harness();
    h.manager.dispatch("dgx1", "modelctl-list-local", ["a"]);
    h.manager.onNodeDisconnected("dgx1");
    expect(h.manager.get("req-1")!.state).toBe("interrupted");
  });

  it("captures output for unknown reqIds as orphan jobs", () => {
    const h = harness();
    h.manager.observeMessage("dgx1", jobOut("ghost-1", "still streaming\n"));
    h.manager.observeMessage("dgx1", jobExit("ghost-1", 0));
    const orphans = h.manager.list({ nodeId: "dgx1" }).filter((j) => j.orphan);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.reqId).toBe("ghost-1");
    expect(orphans[0]!.output).toBe("still streaming\n");
  });

  it("caps output at maxOutputBytes with the truncated flag", () => {
    const h = harness({ maxOutputBytes: 10 });
    h.manager.dispatch("dgx1", "modelctl-list-local", ["a"]);
    h.manager.observeMessage("dgx1", jobOut("req-1", "0123456789"));
    h.manager.observeMessage("dgx1", jobOut("req-1", "EXTRA"));
    const job = h.manager.get("req-1")!;
    expect(job.output).toBe("0123456789");
    expect(job.truncated).toBe(true);
  });

  it("evicts oldest finished jobs beyond the per-node ring, keeping running ones", () => {
    const h = harness({ maxJobsPerNode: 2 });
    h.manager.dispatch("dgx1", "modelctl-version", ["a"]);
    h.manager.observeMessage("dgx1", jobExit("req-1", 0));
    h.manager.dispatch("dgx1", "modelctl-version", ["a"]);
    h.manager.observeMessage("dgx1", jobExit("req-2", 0));
    // req-1 evicted; req-3 (running) pushes req-2 out but keeps req-2 if running-only rule applies
    h.manager.dispatch("dgx1", "modelctl-version", ["a"]);
    expect(h.manager.get("req-1")).toBeUndefined();
    expect(h.manager.get("req-2")).toBeDefined(); // ring keeps newest finished
    expect(h.manager.get("req-3")!.state).toBe("running");
  });
});
