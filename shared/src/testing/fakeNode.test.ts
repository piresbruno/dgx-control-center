import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, VERSION } from "../index.js";
import type { AgentToServer } from "../index.js";
import { FakeNode } from "./fakeNode.js";

function makeNode(overrides: Partial<ConstructorParameters<typeof FakeNode>[0]> = {}) {
  return new FakeNode({ sparkId: "dgx1", ...overrides });
}

/** Collects server-side messages; runs scheduled deliveries synchronously. */
function serverInbox(node: FakeNode) {
  const inbox: AgentToServer[] = [];
  const scheduled: Array<() => void> = [];
  const unwire = node.onServerMessage((msg) => inbox.push(msg));
  return {
    inbox,
    flush: () => {
      while (scheduled.length > 0) scheduled.shift()!();
    },
    pending: () => scheduled.length,
    unwire,
  };
}

describe("FakeNode — lifecycle", () => {
  it("emits a protocol-correct hello on connect", () => {
    const node = makeNode();
    node.connect();
    expect(node.sent[0]).toEqual({
      type: "hello",
      sparkId: "dgx1",
      token: "f".repeat(64),
      proto: PROTOCOL_VERSION,
      agentVersion: VERSION,
    });
  });

  it("supports custom token/version/proto (handshake matrix input)", () => {
    const node = makeNode({ token: "t".repeat(64), version: "0.0.9", proto: 99 });
    node.connect();
    expect(node.sent[0]).toMatchObject({ token: "t".repeat(64), agentVersion: "0.0.9", proto: 99 });
  });

  it("ignores server messages while disconnected; reconnect re-sends hello", () => {
    const node = makeNode();
    const box = serverInbox(node);
    node.feed({ type: "ping" });
    expect(box.inbox).toHaveLength(0);

    node.connect();
    node.feed({ type: "ping" });
    node.disconnect();
    node.feed({ type: "ping" });
    expect(box.inbox.filter((m) => m.type === "pong")).toHaveLength(1);
    expect(box.inbox.some((m) => m.type === "hello")).toBe(true);
  });
});

describe("FakeNode — telemetry", () => {
  it("pushes monotonic atomic snapshots", () => {
    const node = makeNode({ nowMs: () => 1234 });
    node.connect();
    const a = node.pushMetrics();
    const b = node.pushMetrics();
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect([a.ts, b.ts]).toEqual([1234, 1234]);
    expect(b.domains.gpu).toBeDefined();
  });

  it("staleSeq fault replays the same seq (dedup drill)", () => {
    const node = makeNode();
    node.connect();
    node.faults.staleSeq = true;
    const a = node.pushMetrics();
    const b = node.pushMetrics();
    expect(a.seq).toBe(b.seq);
  });

  it("emits llm snapshots for configured ports", () => {
    const node = makeNode({ llmPorts: [{ port: 8888, backend: "vllm", modelId: "glm" }] });
    node.connect();
    const msg = node.pushLlm();
    expect(msg.ports[0]).toMatchObject({ port: 8888, available: true, backend: "vllm", modelId: "glm" });
  });
});

describe("FakeNode — fault injection", () => {
  it("drops every nth emit", () => {
    const node = makeNode();
    node.connect();
    node.faults.dropEveryNth = 2;
    node.pushMetrics();
    node.pushMetrics();
    node.pushMetrics();
    const metrics = node.sent.filter((m) => m.type === "metrics");
    // connect(hello) counts as emit 1, so metrics pushes 2 and 4 drop → 1 delivered
    expect(metrics).toHaveLength(1);
  });

  it("defers delivery under latency until the scheduler runs", () => {
    const scheduled: Array<() => void> = [];
    const node = makeNode({ schedule: (fn) => scheduled.push(fn) });
    const box = serverInbox(node);
    node.connect();
    box.flush();
    expect(box.inbox.some((m) => m.type === "hello")).toBe(true);

    node.faults.latencyMs = 5;
    node.pushMetrics();
    expect(box.inbox.some((m) => m.type === "metrics")).toBe(false);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    expect(box.inbox.some((m) => m.type === "metrics")).toBe(true);
  });

  it("goes watchdog-deaf under the fault, normal otherwise", () => {
    const node = makeNode();
    node.connect();
    const box = serverInbox(node);
    node.feed({ type: "ping" });
    expect(box.inbox.some((m) => m.type === "pong")).toBe(true);

    node.faults.watchdogDeaf = true;
    node.feed({ type: "ping" });
    expect(box.inbox.filter((m) => m.type === "pong")).toHaveLength(1);
  });

  it("auto-disconnects after N emits (cable-pull drill)", () => {
    const node = makeNode();
    const box = serverInbox(node);
    node.faults.disconnectAfterEmits = 2;
    node.connect(); // emit 1: hello
    node.pushMetrics(); // emit 2: ok
    node.pushMetrics(); // emit 3: triggers disconnect, not delivered
    expect(node.isConnected).toBe(false);
    expect(box.inbox.filter((m) => m.type === "metrics")).toHaveLength(1);
    node.feed({ type: "ping" });
    expect(box.inbox.some((m) => m.type === "pong")).toBe(false);
  });
});

describe("FakeNode — jobs and serving", () => {
  it("streams job output then exits with the scripted code", () => {
    const node = makeNode();
    node.connect();
    const box = serverInbox(node);
    node.setJobBehavior("j1", { exitCode: 3, output: ["line1", "line2"] });
    node.feed({ type: "job-run", reqId: "j1", argv: ["modelctl", "list"] });
    const outs = box.inbox.filter((m) => m.type === "job-out");
    expect(outs).toHaveLength(2);
    const exit = box.inbox.find((m) => m.type === "job-exit");
    expect(exit).toMatchObject({ type: "job-exit", reqId: "j1", code: 3 });
  });

  it("default job exits 0 with one output line", () => {
    const node = makeNode();
    node.connect();
    const box = serverInbox(node);
    node.feed({ type: "job-run", reqId: "j2", argv: ["true"] });
    expect(box.inbox.some((m) => m.type === "job-exit" && m.code === 0)).toBe(true);
  });

  it("hang jobs only terminate via job-kill (SIGKILL, null code)", () => {
    const node = makeNode();
    node.connect();
    const box = serverInbox(node);
    node.setJobBehavior("j3", { exitCode: 0, hang: true });
    node.feed({ type: "job-run", reqId: "j3", argv: ["sleep", "999"] });
    expect(box.inbox.some((m) => m.type === "job-exit")).toBe(false);
    node.feed({ type: "job-kill", reqId: "j3" });
    const exit = box.inbox.find((m) => m.type === "job-exit");
    expect(exit).toMatchObject({ code: null, signal: "SIGKILL" });
  });

  it("serve status/start/stop follow the scripted state", () => {
    const node = makeNode();
    node.connect();
    const box = serverInbox(node);
    node.feed({ type: "serve", reqId: "s1", action: "status", scriptId: "glm" });
    node.feed({ type: "serve", reqId: "s2", action: "start", scriptId: "glm" });
    node.feed({ type: "serve", reqId: "s3", action: "status", scriptId: "glm" });
    node.feed({ type: "serve", reqId: "s4", action: "stop", scriptId: "glm" });

    const first = box.inbox.find((m) => m.type === "resp" && m.reqId === "s1");
    expect(first).toMatchObject({ ok: true, payload: { running: false } });
    expect(box.inbox.some((m) => m.type === "serve-log" && m.scriptId === "glm")).toBe(true);
    const running = box.inbox.find((m) => m.type === "resp" && m.reqId === "s3");
    expect(running).toMatchObject({ ok: true, payload: { running: true } });
    const stopped = box.inbox.find((m) => m.type === "resp" && m.reqId === "s4");
    expect(stopped).toMatchObject({ ok: true });
  });

  it("reports pre-existing serve state (reconnect re-attach scenario)", () => {
    const node = makeNode();
    node.connect();
    const box = serverInbox(node);
    node.setServeStatus("glm", { running: true, pid: 4242, startedAt: 42 });
    node.feed({ type: "serve", reqId: "s9", action: "status", scriptId: "glm" });
    const resp = box.inbox.find((m) => m.type === "resp" && m.reqId === "s9");
    expect(resp).toMatchObject({ ok: true, payload: { running: true, pid: 4242, startedAt: 42 } });
  });
});
