import { describe, expect, it, vi } from "vitest";
import { VERSION } from "@cc/shared";
import WebSocket from "ws";
import { buildApp } from "./app.js";
import {
  CLOSE_BAD_TOKEN,
  CLOSE_PROTO_MISMATCH,
  CLOSE_UNKNOWN_NODE,
  CLOSE_VERSION_FLOOR,
  registerAgentHub,
  type AgentHubDeps,
} from "./agentHub.js";
import { FakeNode } from "../../shared/src/testing/fakeNode.js";
import { wireFakeNodeOverWs } from "../../shared/src/testing/wireFakeNode.js";

const TOKEN = "a".repeat(64);

function makeDeps(overrides: Partial<AgentHubDeps> = {}): AgentHubDeps {
  return {
    validToken: (t) => t === TOKEN,
    isKnownNode: (id) => ["dgx1", "dgx2"].includes(id),
    nodeConfig: (id) => ({
      intervals: { system: 1000 },
      llmPorts: id === "dgx1" ? [8888] : [],
      role: id === "dgx1" ? "head" : "worker",
    }),
    minAgentVersion: "0.1.0",
    onAgentMessage: () => {},
    ...overrides,
  };
}

async function startHub(deps: AgentHubDeps = makeDeps()) {
  const app = buildApp();
  const registry = registerAgentHub(app, deps);
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const url = address.replace("[::1]", "127.0.0.1").replace("[::]", "127.0.0.1") + "/agent-ws";
  return { app, registry, url, deps };
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  ws.once("message", (raw: Buffer) => resolve(JSON.parse(raw.toString())));
  return promise;
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number; reason: string }>();
  ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  return promise;
}

describe("agent hub handshake", () => {
  it("welcomes a valid agent with its runtime config", async () => {
    const hub = await startHub();
    const ws = await connect(hub.url);
    ws.send(JSON.stringify({ type: "hello", sparkId: "dgx1", token: TOKEN, proto: 1, agentVersion: VERSION }));
    const welcome = (await nextMessage(ws)) as { type: string; config: { role: string; llmPorts: number[] } };
    expect(welcome).toMatchObject({ type: "welcome", proto: 1, config: { role: "head", llmPorts: [8888] } });
    expect(hub.registry.isConnected("dgx1")).toBe(true);
    ws.close();
    await hub.app.close();
  });

  it.each([
    ["bad token", { type: "hello", sparkId: "dgx1", token: "b".repeat(64), proto: 1, agentVersion: VERSION }, CLOSE_BAD_TOKEN],
    ["unknown node", { type: "hello", sparkId: "dgxX", token: TOKEN, proto: 1, agentVersion: VERSION }, CLOSE_UNKNOWN_NODE],
    ["proto mismatch", { type: "hello", sparkId: "dgx1", token: TOKEN, proto: 99, agentVersion: VERSION }, CLOSE_PROTO_MISMATCH],
    [
      "below version floor",
      { type: "hello", sparkId: "dgx1", token: TOKEN, proto: 1, agentVersion: "0.0.9" },
      CLOSE_VERSION_FLOOR,
    ],
  ])("refuses %s with close code %i", async (_name, hello, expectedCode) => {
    const hub = await startHub();
    const ws = await connect(hub.url);
    const closed = nextClose(ws);
    ws.send(JSON.stringify(hello));
    const { code, reason } = await closed;
    expect(code, `close reason: "${reason}"`).toBe(expectedCode);
    await hub.app.close();
  });

  it("closes sockets whose first message is not a hello", async () => {
    const hub = await startHub();
    const ws = await connect(hub.url);
    const closed = nextClose(ws);
    ws.send(JSON.stringify({ type: "metrics", seq: 1, ts: 1, domains: {} }));
    const { code, reason } = await closed;
    expect(code, `close reason: "${reason}"`).toBe(CLOSE_PROTO_MISMATCH);
    await hub.app.close();
  });
});

describe("agent hub telemetry + rpc", () => {
  it("routes validated FakeNode metrics to the deps sink and subscribers", async () => {
    const received: Array<{ sparkId: string; type: string; seq?: number }> = [];
    const hub = await startHub(makeDeps({ onAgentMessage: (sparkId, msg) => received.push({ sparkId, type: msg.type, seq: msg.type === "metrics" ? msg.seq : undefined }) }));

    const node = new FakeNode({ sparkId: "dgx1", token: TOKEN });
    const ws = await connect(hub.url);
    wireFakeNodeOverWs(node, ws);
    node.connect();

    const welcome = (await nextMessage(ws)) as { type: string };
    expect(welcome.type).toBe("welcome");

    const pushed = node.pushMetrics();
    await vi.waitFor(() => {
      expect(received.find((r) => r.type === "metrics")).toMatchObject({ sparkId: "dgx1", seq: pushed.seq });
    });

    let subscriberSeq: number | undefined;
    const off = hub.registry.onMessage("dgx1", (msg) => {
      if (msg.type === "metrics") subscriberSeq = msg.seq;
    });
    node.pushMetrics();
    await vi.waitFor(() => expect(subscriberSeq).toBe(pushed.seq + 1));
    off();
    ws.close();
    await hub.app.close();
  });

  it("request() correlates a serve-status resp through FakeNode", async () => {
    const hub = await startHub();
    const node = new FakeNode({ sparkId: "dgx2", token: TOKEN });
    node.setServeStatus("glm", { running: true, pid: 4242 });
    const ws = await connect(hub.url);
    wireFakeNodeOverWs(node, ws);
    node.connect();
    await nextMessage(ws); // welcome

    const payload = await hub.registry.request<{ running: boolean; pid: number }>("dgx2", {
      type: "serve",
      reqId: "srv-1",
      action: "status",
      scriptId: "glm",
    });
    expect(payload).toMatchObject({ running: true, pid: 4242 });
    ws.close();
    await hub.app.close();
  });

  it("replaces a stale connection when the same node reconnects", async () => {
    const hub = await startHub();
    const first = await connect(hub.url);
    first.send(JSON.stringify({ type: "hello", sparkId: "dgx1", token: TOKEN, proto: 1, agentVersion: VERSION }));
    await nextMessage(first);

    const second = await connect(hub.url);
    second.send(JSON.stringify({ type: "hello", sparkId: "dgx1", token: TOKEN, proto: 1, agentVersion: VERSION }));
    await nextMessage(second);
    await vi.waitFor(() => expect(hub.registry.connectedIds()).toEqual(["dgx1"]));

    const firstClosed = Promise.withResolvers<number>();
    first.once("close", (c) => firstClosed.resolve(c));
    expect(await firstClosed.promise).toBe(CLOSE_UNKNOWN_NODE);
    first.terminate();
    second.close();
    await hub.app.close();
  });

  it("sweep() drops nodes silent beyond the pong timeout (watchdog)", async () => {
    const hub = await startHub();
    const node = new FakeNode({ sparkId: "dgx1", token: TOKEN });
    const ws = await connect(hub.url);
    wireFakeNodeOverWs(node, ws);
    node.connect();
    await nextMessage(ws);

    const before = Date.now();
    expect(hub.registry.sweep(before, 30_000)).toEqual([]); // fresh node stays
    const dropped = hub.registry.sweep(before + 31_000, 30_000);
    expect(dropped).toEqual(["dgx1"]);
    expect(hub.registry.isConnected("dgx1")).toBe(false);
    ws.close();
    await hub.app.close();
  });
});
