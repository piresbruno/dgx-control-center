import { describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { MetricsMsg } from "@cc/shared";
import { AgentDaemon } from "./daemon.js";

interface Dashboard {
  url: string;
  hellos: Array<{ sparkId: string; token: string; proto: number; agentVersion: string }>;
  metrics: MetricsMsg[];
  pongs: number;
  jobFrames: Array<{ type: string; reqId: string; chunk?: string; code?: number | null }>;
  sockets: WebSocket[];
  close(): Promise<void>;
}

async function startDashboard(config = { intervals: { system: 20 }, llmPorts: [8888], role: "head" as const }) {
  const dash: Dashboard = {
    url: "",
    hellos: [],
    metrics: [],
    pongs: 0,
    jobFrames: [],
    sockets: [],
    close: async () => {
      for (const s of dash.sockets) s.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (socket) => {
    dash.sockets.push(socket);
    socket.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case "hello":
          dash.hellos.push(msg);
          socket.send(JSON.stringify({ type: "welcome", proto: 1, config }));
          return;
        case "pong":
          dash.pongs += 1;
          return;
        case "metrics":
          dash.metrics.push(msg);
          return;
        case "job-out":
        case "job-exit":
          dash.jobFrames.push(msg);
          return;
      }
    });
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const addr = wss.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no address");
  dash.url = `ws://127.0.0.1:${addr.port}`;
  return dash;
}

function makeDaemon(dash: Dashboard, overrides: Partial<ConstructorParameters<typeof AgentDaemon>[0]> = {}) {
  return new AgentDaemon({
    dashboardUrl: dash.url,
    sparkId: "dgx1",
    token: "t".repeat(64),
    role: "head",
    llmPorts: [8888],
    intervals: { system: 20 },
    collect: (domain, ts) => (domain === "system" ? { loadPct: 42, ts } : null),
    backoffMinMs: 10,
    backoffMaxMs: 50,
    ...overrides,
  });
}

describe("AgentDaemon", () => {
  it("dials, says hello, receives welcome and pushes seq'd atomic snapshots", async () => {
    const dash = await startDashboard();
    const daemon = makeDaemon(dash);
    daemon.start();

    await vi.waitFor(() => expect(dash.hellos.length).toBe(1));
    expect(dash.hellos[0]).toMatchObject({ type: "hello", sparkId: "dgx1", proto: 1 });
    expect(daemon.getState()).toBe("online");

    await vi.waitFor(() => expect(dash.metrics.length).toBeGreaterThanOrEqual(3));
    const seqs = dash.metrics.map((m) => m.seq);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    expect(dash.metrics[0]?.domains).toMatchObject({ system: { loadPct: 42 } });

    daemon.stop();
    await dash.close();
  });

  it("pongs server pings", async () => {
    const dash = await startDashboard();
    const daemon = makeDaemon(dash);
    daemon.start();
    await vi.waitFor(() => expect(daemon.getState()).toBe("online"));

    dash.sockets[0]?.send(JSON.stringify({ type: "ping" }));
    await vi.waitFor(() => expect(dash.pongs).toBe(1));

    daemon.stop();
    await dash.close();
  });

  it("runs jobs by argv and streams out/exit frames", async () => {
    const dash = await startDashboard();
    const daemon = makeDaemon(dash);
    daemon.start();
    await vi.waitFor(() => expect(daemon.getState()).toBe("online"));

    dash.sockets[0]?.send(
      JSON.stringify({ type: "job-run", reqId: "j1", argv: [process.execPath, "-e", "process.stdout.write('hi')"] }),
    );
    await vi.waitFor(() => {
      expect(dash.jobFrames.some((f) => f.type === "job-out" && f.chunk?.includes("hi"))).toBe(true);
      expect(dash.jobFrames.some((f) => f.type === "job-exit" && f.reqId === "j1" && f.code === 0)).toBe(true);
    });

    daemon.stop();
    await dash.close();
  });

  it("reconnects with backoff and re-handshakes after server-side drop", async () => {
    const dash = await startDashboard();
    const daemon = makeDaemon(dash);
    daemon.start();
    await vi.waitFor(() => expect(daemon.getState()).toBe("online"));

    dash.sockets[0]?.terminate(); // cable pull
    await vi.waitFor(() => expect(daemon.getState()).toBe("online")); // backoff → re-dial → online
    await vi.waitFor(() => expect(dash.hellos.length).toBe(2));

    daemon.stop();
    await dash.close();
  });

  it("stops cleanly and halts the metric loop", async () => {
    const dash = await startDashboard();
    const daemon = makeDaemon(dash);
    daemon.start();
    await vi.waitFor(() => expect(dash.metrics.length).toBeGreaterThanOrEqual(1));
    const count = dash.metrics.length;
    daemon.stop();
    expect(daemon.getState()).toBe("stopped");
    await new Promise((r) => setTimeout(r, 60));
    expect(dash.metrics.length).toBeLessThanOrEqual(count + 1); // at most one in-flight tick
    await dash.close();
  });
});
