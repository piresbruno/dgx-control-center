import type { FastifyInstance } from "fastify";
import type { LiveState, LiveSnapshot } from "./liveState.js";

/**
 * Registers /ws INSIDE the @fastify/websocket scope opened by registerAgentHub
 * (the plugin may only be registered once per instance). `onConnect` lets the
 * server push extra frames (alert toasts) to every connected browser.
 */
export function registerBrowserHub(
  scope: FastifyInstance,
  getSnapshot: () => LiveSnapshot,
  subscribe?: (cb: (snapshot: LiveSnapshot) => void) => () => void,
  onConnect?: (send: (msg: unknown) => void) => () => void,
): void {
  {
    scope.get("/ws", { websocket: true }, (socket) => {
      const send = (msg: unknown): void => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      send({ type: "snapshot", ...getSnapshot() });
      const unsubs: Array<() => void> = [];
      const unsubAlerts = onConnect?.(send);
      if (unsubAlerts) unsubs.push(unsubAlerts);
      if (subscribe) {
        unsubs.push(
          subscribe((snapshot) => {
            send({ type: "snapshot", ...snapshot });
          }),
        );
      }
      socket.on("close", () => {
        for (const u of unsubs) u();
      });
      socket.on("message", () => {
        // Browsers receive; stray frames are ignored (OS-level keepalive).
      });
    });
  }
}
