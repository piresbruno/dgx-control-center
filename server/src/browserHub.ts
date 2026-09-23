import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { LiveState, LiveSnapshot } from "./liveState.js";

/** Registers /ws: browser push channel — immediate snapshot, then deltas. */
export function registerBrowserHub(
  app: FastifyInstance,
  getSnapshot: () => LiveSnapshot,
  subscribe?: (cb: (snapshot: LiveSnapshot) => void) => () => void,
): void {
  app.register(websocket);
  app.register((scope) => {
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
  });
}
