import WebSocket from "ws";
import { FakeNode, wireFakeNodeOverWs, type AgentToServer } from "@cc/shared";
import type { AgentHubDeps } from "./agentHub.js";

/**
 * --fake-fleet dev mode (F1a): a real WebSocket fleet of three scripted
 * nodes driving the live hub — full-stack demo and Playwright target with
 * zero GPUs. Faults stay configurable per node via `handle.nodes`.
 */

export const FLEET_TOKEN = "dev-fleet-token";

export const FLEET_NODE_IDS = ["dgx1", "dgx2", "nas1"] as const;

export function fakeFleetHubDeps(sink?: (sparkId: string, msg: AgentToServer) => void): AgentHubDeps {
  return {
    validToken: (t) => t === FLEET_TOKEN,
    isKnownNode: (id) => (FLEET_NODE_IDS as readonly string[]).includes(id),
    nodeConfig: (id) => ({
      intervals: { system: 1000 },
      llmPorts: id === "dgx1" ? [8888] : id === "dgx2" ? [8889] : [],
      role: id === "dgx1" ? "head" : id === "dgx2" ? "worker" : "standalone",
    }),
    minAgentVersion: "0.1.0",
    onAgentMessage: sink ?? (() => {}),
  };
}

export interface FakeFleetHandle {
  nodes: FakeNode[];
  stop(): void;
}

export async function startFakeFleet(agentWsUrl: string, intervalMs = 1000): Promise<FakeFleetHandle> {
  const timers: NodeJS.Timeout[] = [];
  const sockets: WebSocket[] = [];

  const nodes = [
    new FakeNode({
      sparkId: "dgx1",
      token: FLEET_TOKEN,
      role: "head",
      llmPorts: [{ port: 8888, backend: "vllm", modelId: "glm-5.3-flash" }],
    }),
    new FakeNode({
      sparkId: "dgx2",
      token: FLEET_TOKEN,
      role: "worker",
      llmPorts: [{ port: 8889, backend: "llama.cpp", modelId: "qwen3.6-27b" }],
    }),
    new FakeNode({ sparkId: "nas1", token: FLEET_TOKEN, role: "standalone" }),
  ];

  for (const node of nodes) {
    const socket = new WebSocket(agentWsUrl);
    sockets.push(socket);
    wireFakeNodeOverWs(node, socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    node.connect();
    const tick = setInterval(() => {
      node.pushMetrics();
      if (node.sent.filter((m) => m.type === "metrics").length % 3 === 0) node.pushLlm();
    }, intervalMs);
    timers.push(tick);
  }

  return {
    nodes,
    stop() {
      for (const t of timers) clearInterval(t);
      for (const s of sockets) s.close();
    },
  };
}
