import {
  agentToServer,
  helloMsg,
  isVersionAtLeastFloor,
  PROTOCOL_VERSION,
  type AgentToServer,
  type ServerToAgent,
} from "@cc/shared";
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";

/** Close codes (protocol contract; tests assert them). */
export const CLOSE_BAD_TOKEN = 4001;
export const CLOSE_UNKNOWN_NODE = 4002;
export const CLOSE_PROTO_MISMATCH = 4003;
export const CLOSE_VERSION_FLOOR = 4004;

export interface NodeRuntimeConfig {
  /** Metric cadence per domain, ms. */
  intervals: Record<string, number>;
  llmPorts: number[];
  role: "head" | "worker" | "standalone";
  /** Desired clock profile (F1a edge autonomy: agent re-applies on boot). */
  clockProfileId?: string | null;
}

export interface AgentHubDeps {
  /** Current agent token — the hub compares hello tokens against it. */
  agentToken(): string;
  isKnownNode(sparkId: string): boolean;
  nodeConfig(sparkId: string): NodeRuntimeConfig;
  /** Version floor (ADR-0002); agents below it are refused with 4004. */
  minAgentVersion: string;
  /** Telemetry sink — receives every validated agent→server message. */
  onAgentMessage(sparkId: string, msg: AgentToServer): void;
}

export interface AgentConnection {
  sparkId: string;
  socket: WebSocket;
  node: NodeRuntimeConfig;
  /** Wall-clock of last validated inbound message (watchdog liveness). */
  lastSeen: number;
}

declare module "fastify" {
  interface FastifyInstance {
    agentRegistry?: AgentRegistry;
  }
}

export class AgentRegistry {
  private readonly connections = new Map<string, AgentConnection>();
  private readonly messageHandlers = new Set<(sparkId: string, msg: AgentToServer) => void>();

  register(conn: AgentConnection): void {
    const previous = this.connections.get(conn.sparkId);
    if (previous && previous.socket !== conn.socket) previous.socket.close(CLOSE_UNKNOWN_NODE, "replaced");
    this.connections.set(conn.sparkId, conn);
  }

  unregister(sparkId: string, socket: WebSocket): void {
    const current = this.connections.get(sparkId);
    if (current && current.socket === socket) this.connections.delete(sparkId);
  }

  isConnected(sparkId: string): boolean {
    return this.connections.has(sparkId);
  }

  connectedIds(): string[] {
    return [...this.connections.keys()];
  }

  /** Best-effort send; false when the node is not connected. */
  send(sparkId: string, msg: ServerToAgent): boolean {
    const conn = this.connections.get(sparkId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) return false;
    conn.socket.send(JSON.stringify(msg));
    return true;
  }

  /** Fan-out of one validated agent message to subscribers. */
  dispatch(sparkId: string, msg: AgentToServer): void {
    for (const handler of this.messageHandlers) handler(sparkId, msg);
  }

  /** Observe validated agent messages for one node until unsubscribe. */
  onMessage(sparkId: string, handler: (msg: AgentToServer) => void): () => void {
    const wrapped = (sid: string, msg: AgentToServer) => {
      if (sid === sparkId) handler(msg);
    };
    this.messageHandlers.add(wrapped);
    return () => this.messageHandlers.delete(wrapped);
  }

  /** RPC over reqId correlation: resolves with the `resp` payload. */
  request<Resp = unknown>(
    sparkId: string,
    msg: { reqId: string; type: string } & Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<Resp> {
    const conn = this.connections.get(sparkId);
    if (!conn) return Promise.reject(new Error(`node ${sparkId} not connected`));
    const { promise, resolve, reject } = Promise.withResolvers<Resp>();
    const timer = setTimeout(() => {
      off();
      reject(new Error(`request ${msg.reqId} to ${sparkId} timed out`));
    }, timeoutMs);
    const off = this.onMessage(sparkId, (message) => {
      if (message.type !== "resp" || message.reqId !== msg.reqId) return;
      clearTimeout(timer);
      off();
      if (message.ok) resolve(message.payload as Resp);
      else reject(new Error(message.error ?? `request ${msg.reqId} failed`));
    });
    this.send(sparkId, msg as unknown as ServerToAgent);
    return promise;
  }

  touch(sparkId: string, now: number): void {
    const conn = this.connections.get(sparkId);
    if (conn) conn.lastSeen = now;
  }

  /** Watchdog sweep: drop nodes silent longer than pongTimeoutMs (F1a). */
  sweep(now: number, pongTimeoutMs: number): string[] {
    const dropped: string[] = [];
    for (const [sparkId, conn] of this.connections) {
      if (now - conn.lastSeen > pongTimeoutMs) {
        conn.socket.close(1011, "watchdog timeout");
        this.connections.delete(sparkId);
        dropped.push(sparkId);
      }
    }
    return dropped;
  }
}

/** Registers /agent-ws: first-message handshake, then validated dispatch. */
export function registerAgentHub(
  app: FastifyInstance,
  deps: AgentHubDeps,
  extraWsRoutes?: (scope: FastifyInstance) => void,
): AgentRegistry {
  const registry = new AgentRegistry();
  // All WS routes must register inside the @fastify/websocket scope — its
  // onRoute hook (installed by that plugin) marks routes as WS routes, and the
  // plugin must be registered exactly once (decorator 'ws').
  app.register(websocket);
  app.register((scope) => {
    extraWsRoutes?.(scope);
    scope.get("/agent-ws", { websocket: true }, (socket) => {
    let auth: { sparkId: string } | null = null;

    socket.on("message", (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        socket.close(CLOSE_PROTO_MISMATCH, "invalid json");
        return;
      }

      if (!auth) {
        const hello = helloMsg.safeParse(parsed);
        if (!hello.success) {
          socket.close(CLOSE_PROTO_MISMATCH, "expected hello");
          return;
        }
        const { sparkId, token, proto, agentVersion } = hello.data;
        if (token !== deps.agentToken()) {
          socket.close(CLOSE_BAD_TOKEN, "bad token");
          return;
        }
        if (!deps.isKnownNode(sparkId)) {
          socket.close(CLOSE_UNKNOWN_NODE, "unknown node");
          return;
        }
        if (proto !== PROTOCOL_VERSION) {
          socket.close(CLOSE_PROTO_MISMATCH, "proto mismatch");
          return;
        }
        if (!isVersionAtLeastFloor(agentVersion, deps.minAgentVersion)) {
          socket.close(CLOSE_VERSION_FLOOR, "agent below version floor");
          return;
        }
        auth = { sparkId };
        const config = deps.nodeConfig(sparkId);
        registry.register({ sparkId, socket, node: config, lastSeen: Date.now() });
        const welcome: ServerToAgent = { type: "welcome", proto: PROTOCOL_VERSION, config };
        socket.send(JSON.stringify(welcome));
        return;
      }

      const result = agentToServer.safeParse(parsed);
      if (!result.success) return;
      registry.touch(auth.sparkId, Date.now());
      registry.dispatch(auth.sparkId, result.data);
      deps.onAgentMessage(auth.sparkId, result.data);
    });

    socket.on("close", () => {
      if (auth) registry.unregister(auth.sparkId, socket);
    });
    socket.on("error", () => {
      if (auth) registry.unregister(auth.sparkId, socket);
    });
    });
  });

  return registry;
}
