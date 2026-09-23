import type { FastifyInstance } from "fastify";
import type { LiveState, LiveSnapshot } from "./liveState.js";

/**
 * Registers /ws INSIDE the @fastify/websocket scope opened by registerAgentHub
 * (the plugin may only be registered once per instance).
 */
export function registerBrowserHub(
  scope: FastifyInstance,
  getSnapshot: () => LiveSnapshot,
  subscribe?: (cb: (snapshot: LiveSnapshot) => void) => () => void,
): void {
  {
    scope.get("/ws", { websocket: true }, (socket) => {
      socket.send(JSON.stringify({ type: "snapshot", ...getSnapshot() }));
      if (subscribe) {
        const unsub = subscribe((snapshot) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "snapshot", ...snapshot }));
          }
        });
        socket.on("close", unsub);
      }
      socket.on("message", () => {
        // Browsers receive; stray frames are ignored (OS-level keepalive).
      });
    });
  }
}
