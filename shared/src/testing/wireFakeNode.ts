import { serverToAgent } from "../index.js";
import type { FakeNode } from "./fakeNode.js";

/** Structural subset of a ws client socket (keeps shared dependency-free). */
interface MinimalWsClient {
  on(event: "message", cb: (raw: Buffer) => void): unknown;
  send(data: string): unknown;
}

/**
 * Bridges a FakeNode onto a real WebSocket client socket: server frames are
 * validated then fed to the node; node emissions go straight onto the wire.
 * Used by server integration tests and the --fake-fleet dev mode.
 */
export function wireFakeNodeOverWs(node: FakeNode, socket: MinimalWsClient): void {
  socket.on("message", (raw: Buffer) => {
    const parsed = serverToAgent.safeParse(JSON.parse(raw.toString()));
    if (parsed.success) node.feed(parsed.data);
  });
  node.onServerMessage((msg) => socket.send(JSON.stringify(msg)));
}
