import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { buildApp } from "./app.js";
import { fakeFleetHubDeps, FLEET_NODE_IDS, startFakeFleet } from "./fakeFleet.js";

describe("fake fleet", () => {
  it("drives the live hub with sequenced metrics from all three nodes", async () => {
    const received: Array<{ sparkId: string; type: string }> = [];
    const app = buildApp({ agentHubDeps: fakeFleetHubDeps((sparkId, msg) => received.push({ sparkId, type: msg.type })) });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const url = address.replace("[::1]", "127.0.0.1") + "/agent-ws";

    const fleet = await startFakeFleet(url, 20);
    await vi.waitFor(() => {
      expect(app.agentRegistry?.connectedIds().sort()).toEqual([...FLEET_NODE_IDS].sort());
    });

    await vi.waitFor(
      () => {
        for (const id of FLEET_NODE_IDS) {
          expect(received.some((r) => r.sparkId === id && r.type === "metrics")).toBe(true);
        }
        expect(received.some((r) => r.type === "llm")).toBe(true);
      },
      { timeout: 3000 },
    );

    fleet.stop();
    await vi.waitFor(() => expect(app.agentRegistry?.connectedIds() ?? []).toEqual([]));
    await app.close();
  });

  it("nodes survive hub-side faults via scripted behavior (hang job stays hung)", async () => {
    const app = buildApp({ agentHubDeps: fakeFleetHubDeps() });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const url = address.replace("[::1]", "127.0.0.1") + "/agent-ws";
    const fleet = await startFakeFleet(url, 20);

    const dgx1 = fleet.nodes[0]!;
    dgx1.setJobBehavior("hang-1", { exitCode: 0, hang: true });
    const exited = Promise.withResolvers<void>();
    dgx1.onServerMessage((msg) => {
      if (msg.type === "job-exit" && msg.reqId === "hang-1") exited.reject(new Error("hung job exited"));
    });
    const hub = app.agentRegistry!;
    void hub.request("dgx1", { type: "job-run", reqId: "hang-1", argv: ["sleep", "999"] }).catch(() => {});
    hub.send("dgx1", { type: "ping" });

    await vi.waitFor(() => {
      expect(dgx1.sent.some((m) => m.type === "pong")).toBe(true);
      expect(dgx1.sent.some((m) => m.type === "job-exit" && m.reqId === "hang-1")).toBe(false);
    });
    exited.promise.catch(() => {});

    hub.send("dgx1", { type: "job-kill", reqId: "hang-1" });
    await vi.waitFor(() => {
      expect(dgx1.sent.some((m) => m.type === "job-exit" && m.reqId === "hang-1" && m.code === null)).toBe(true);
    });

    fleet.stop();
    await app.close();
  });
});
