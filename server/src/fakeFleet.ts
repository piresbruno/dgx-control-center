import http from "node:http";
import WebSocket from "ws";
import { FakeNode, wireFakeNodeOverWs, type AgentToServer, type JobBehavior, type ServerToAgent } from "@cc/shared";
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
    agentToken: () => FLEET_TOKEN,
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
  /** Loopback ports actually bound to a stub engine this process owns. */
  engines: number[];
  stop(): void;
}

/** Argv-keyed job behavior (mockData.fakeJobBehavior); null ⇒ FakeNode default. */
export type JobRouter = (sparkId: string, argv: string[]) => JobBehavior | null;

/** Server-side subclass: consults the router at dispatch time, then defers. */
class RoutedFakeNode extends FakeNode {
  constructor(
    opts: ConstructorParameters<typeof FakeNode>[0],
    private readonly router: JobRouter,
  ) {
    super(opts);
  }

  override feed(msg: ServerToAgent): void {
    if (msg.type === "job-run") {
      const behavior = this.router(this.opts.sparkId, msg.argv);
      if (behavior) this.setJobBehavior(msg.reqId, behavior);
    }
    super.feed(msg);
  }
}

/**
 * Canned OpenAI-compatible engine bound to a node's advertised llmPort so the
 * gateway router, chat proxy, and /llm pass-through all have a live upstream
 * in demo mode (the seed registers served models pointing at these ports).
 */
function createStubEngine(modelId: string): http.Server {
  const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    if (url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ object: "list", data: [{ id: modelId, object: "model", owned_by: "controlcenter-fake" }] }),
      );
      return;
    }
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      let raw = "";
      for await (const part of req) raw += part;
      let stream = true;
      try {
        stream = JSON.parse(raw || "{}").stream !== false;
      } catch {
        /* default to streaming */
      }
      const text = "Mock engine reply for the **fake fleet** demo — streaming markdown works end to end.";
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 21, completion_tokens: 15, total_tokens: 36 },
          }),
        );
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const id = `chatcmpl-fake-${Date.now()}`;
      for (const word of text.split(" ")) {
        res.write(chunk({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `${word} ` } }] }));
      }
      res.write(
        chunk({
          id,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 21, completion_tokens: 15, total_tokens: 36 },
        }),
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":{"message":"stub engine: unsupported path"}}');
  });
}

/**
 * Best-effort bind with a short retry: a restart can briefly overlap a dying
 * predecessor still holding the port. When the ports really are taken (a second
 * concurrent --fake-fleet instance), the first holder's stubs answer instead.
 */
async function bindStubEngine(port: number, modelId: string): Promise<http.Server | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const server = createStubEngine(modelId);
    const listen = Promise.withResolvers<void>();
    server.once("error", listen.reject);
    server.listen(port, "127.0.0.1", () => listen.resolve());
    try {
      await listen.promise;
      return server;
    } catch (err) {
      server.close();
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt === 3) return null;
      const backoff = Promise.withResolvers<void>();
      setTimeout(backoff.resolve, 250 * (attempt + 1));
      await backoff.promise;
    }
  }
  return null;
}

export async function startFakeFleet(
  agentWsUrl: string,
  intervalMs = 1000,
  jobRouter?: JobRouter,
): Promise<FakeFleetHandle> {
  const timers: NodeJS.Timeout[] = [];
  const sockets: WebSocket[] = [];
  const router: JobRouter = jobRouter ?? (() => null);

  const nodes = [
    new RoutedFakeNode(
      {
        sparkId: "dgx1",
        token: FLEET_TOKEN,
        role: "head",
        llmPorts: [{ port: 8888, backend: "vllm", modelId: "glm-5.3-flash" }],
      },
      router,
    ),
    new RoutedFakeNode(
      {
        sparkId: "dgx2",
        token: FLEET_TOKEN,
        role: "worker",
        llmPorts: [{ port: 8889, backend: "llama.cpp", modelId: "qwen3.6-27b" }],
      },
      router,
    ),
    new RoutedFakeNode({ sparkId: "nas1", token: FLEET_TOKEN, role: "standalone" }, router),
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

  const engines: http.Server[] = [];
  const boundPorts: number[] = [];
  for (const node of nodes) {
    for (const advertised of node.opts.llmPorts ?? []) {
      const server = await bindStubEngine(advertised.port, String(advertised.modelId ?? "fake-model"));
      if (server) {
        engines.push(server);
        boundPorts.push(advertised.port);
      }
    }
  }

  return {
    nodes,
    engines: boundPorts,
    stop() {
      for (const t of timers) clearInterval(t);
      for (const s of sockets) s.close();
      for (const e of engines) e.close();
    },
  };
}
