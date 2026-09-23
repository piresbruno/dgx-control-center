import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import { serverToAgent, type AgentToServer, type MetricsMsg, type ServerToAgent } from "@cc/shared";
import { reconcileClocks, setDesiredProfile, type ClockApplier } from "./reconcile.js";

/** Ports-and-adapters: collectors are injected (F1a testability). */
export type DomainCollector = (ts: number) => Record<string, unknown>;

export interface AgentDaemonOptions {
  dashboardUrl: string;
  sparkId: string;
  token: string;
  role: "head" | "worker" | "standalone";
  llmPorts: number[];
  /** Metric cadence per domain, ms; the `system` domain drives the main loop. */
  intervals: Record<string, number>;
  collect: (domain: string, ts: number) => Record<string, unknown> | null;
  /** Injectable timers (deterministic tests); defaults to globalThis. */
  timers?: Pick<typeof globalThis, "setInterval" | "clearInterval" | "setTimeout">;
  /** Reconnect backoff bounds, ms (F1a: 1s → 30s). */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Edge autonomy (F1a): persist desired clock profile + re-apply on boot. */
  stateFile?: string;
  clockApplier?: ClockApplier;
  onLog?: (line: string) => void;
}

export type AgentDaemonState = "stopped" | "connecting" | "online" | "backoff";

/**
 * Outbound-only agent daemon (ADR-0002): dials the dashboard, says hello,
 * serves welcome/config-update, pongs, pushes atomic seq'd snapshots, runs
 * jobs by argv. Survives dashboard loss via exponential reconnect backoff.
 */
export class AgentDaemon {
  private ws: WebSocket | null = null;
  private state: AgentDaemonState = "stopped";
  private attempts = 0;
  private stopped = false;
  private metricTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private jobs = new Map<string, ChildProcess>();
  private reconcileChain: Promise<void> = Promise.resolve();
  private config: {
    intervals: Record<string, number>;
    llmPorts: number[];
    role: "head" | "worker" | "standalone";
  };

  constructor(private readonly opts: AgentDaemonOptions) {
    this.config = { intervals: opts.intervals, llmPorts: opts.llmPorts, role: opts.role };
  }

  getState(): AgentDaemonState {
    return this.state;
  }

  start(): void {
    this.stopped = false;
    // Boot path: re-apply the persisted clock profile BEFORE contacting the
    // dashboard (node boot resets clocks). Serialized with welcome-driven
    // applies so they can never interleave.
    this.reconcileChain = this.reconcileChain
      .then(() => this.reconcileClocks())
      .then(() => this.dial())
      .catch((err) => this.log(`start chain failed: ${String(err)}`));
  }

  /** Boot path: re-apply the persisted clock profile without the dashboard. */
  private async reconcileClocks(): Promise<void> {
    const { stateFile, clockApplier } = this.opts;
    if (!stateFile || !clockApplier) return;
    // force: a node boot resets clocks, so the profile is always re-applied.
    const outcome = await reconcileClocks(stateFile, clockApplier, Date.now(), { force: true });
    this.log(outcome.applied ? "clocks reconciled (boot)" : `clocks reconcile skipped: ${outcome.error ?? "up-to-date"}`);
  }

  stop(): void {
    this.stopped = true;
    this.clearMetricTimer();
    for (const child of this.jobs.values()) child.kill("SIGKILL");
    this.jobs.clear();
    this.ws?.close();
    this.ws = null;
    this.state = "stopped";
  }

  /** Latest metrics message (test/inspection seam). */
  lastMetrics: MetricsMsg | null = null;

  private log(line: string): void {
    this.opts.onLog?.(line);
  }

  private setState(next: AgentDaemonState): void {
    if (this.state !== next) {
      this.state = next;
      this.log(`state → ${next}`);
    }
  }

  private dial(): void {
    if (this.stopped) return;
    this.setState("connecting");
    const ws = new WebSocket(`${this.opts.dashboardUrl}/agent-ws`);
    this.ws = ws;

    ws.on("open", () => {
      this.attempts = 0;
      this.send({
        type: "hello",
        sparkId: this.opts.sparkId,
        token: this.opts.token,
        proto: 1,
        agentVersion: process.env.npm_package_version ?? "0.1.0",
      });
    });

    ws.on("message", (raw: Buffer) => {
      const parsed = serverToAgent.safeParse(JSON.parse(raw.toString()));
      if (!parsed.success) return;
      void this.handle(parsed.data).catch((err) => this.log(`frame error: ${String(err)}`));
    });

    ws.on("close", () => {
      this.clearMetricTimer();
      if (this.stopped) return;
      this.scheduleReconnect();
    });

    ws.on("error", (err) => this.log(`socket error: ${err.message}`));
  }

  private scheduleReconnect(): void {
    this.setState("backoff");
    const min = this.opts.backoffMinMs ?? 1_000;
    const max = this.opts.backoffMaxMs ?? 30_000;
    const delay = Math.min(max, min * 2 ** this.attempts);
    this.attempts += 1;
    const timers = this.opts.timers ?? globalThis;
    timers.setTimeout(() => this.dial(), delay);
  }

  private async handle(msg: ServerToAgent): Promise<void> {
    switch (msg.type) {
      case "welcome":
        this.config = msg.config;
        await this.ingestClockProfile(msg.config.clockProfileId);
        this.setState("online");
        this.startMetricLoop();
        return;
      case "config-update":
        this.config = msg.config;
        await this.ingestClockProfile(msg.config.clockProfileId);
        this.startMetricLoop(); // restart with new cadences
        return;
      case "ping":
        this.emit({ type: "pong" });
        return;
      case "job-run":
        this.runJob(msg.reqId, msg.argv, msg.timeoutMs);
        return;
      case "job-kill": {
        const child = this.jobs.get(msg.reqId);
        if (child) child.kill("SIGKILL");
        return;
      }
      case "serve":
        // Serving supervision lands with deployments (M3); contract answered.
        this.emit({ type: "resp", reqId: msg.reqId, ok: false, error: "serve arrives in M3" });
        return;
      default:
        return;
    }
  }

  private send(msg: AgentToServer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private emit(msg: AgentToServer): void {
    this.send(msg);
  }

  private clearMetricTimer(): void {
    if (this.metricTimer) {
      (this.opts.timers ?? globalThis).clearInterval(this.metricTimer);
      this.metricTimer = null;
    }
  }

  /** Persist a pushed clock profile and reconcile toward it (F1a edge autonomy). */
  private ingestClockProfile(profileId: string | null | undefined): Promise<void> {
    const { stateFile, clockApplier } = this.opts;
    if (!stateFile || !clockApplier || profileId === undefined) return Promise.resolve();
    this.reconcileChain = this.reconcileChain.then(async () => {
      await setDesiredProfile(stateFile, profileId);
      const outcome = await reconcileClocks(stateFile, clockApplier);
      this.log(
        outcome.applied
          ? `clock profile applied: ${profileId ?? "default"}`
          : `clock apply skipped: ${outcome.error ?? "up-to-date"}`,
      );
    });
    return this.reconcileChain;
  }

  private startMetricLoop(): void {
    this.clearMetricTimer();
    const cadence = this.config.intervals["system"] ?? 1_000;
    const timers = this.opts.timers ?? globalThis;
    this.metricTimer = timers.setInterval(() => {
      const ts = Date.now();
      const domains: Record<string, unknown> = {};
      for (const domain of Object.keys(this.config.intervals)) {
        const sample = this.opts.collect(domain, ts);
        if (sample) domains[domain] = sample;
      }
      const msg: MetricsMsg = { type: "metrics", seq: ++this.seq, ts, domains };
      this.lastMetrics = msg;
      this.emit(msg);
    }, cadence);
  }

  private runJob(reqId: string, argv: string[], timeoutMs?: number): void {
    try {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
      this.jobs.set(reqId, child);
      const emitOut = (stream: "out" | "err") => (chunk: Buffer) => {
        this.emit({ type: "job-out", reqId, stream, chunk: chunk.toString() });
      };
      child.stdout?.on("data", emitOut("out"));
      child.stderr?.on("data", emitOut("err"));
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        this.jobs.delete(reqId);
        this.emit({ type: "job-exit", reqId, code, signal: signal ?? undefined });
      };
      child.on("exit", (code, signal) => finish(code, signal));
      child.on("error", (err) => {
        this.emit({ type: "job-out", reqId, stream: "err", chunk: `${err.message}\n` });
        finish(127, null);
      });
      if (timeoutMs) {
        const timers = this.opts.timers ?? globalThis;
        timers.setTimeout(() => {
          if (this.jobs.has(reqId)) child.kill("SIGKILL");
        }, timeoutMs);
      }
    } catch (err) {
      this.emit({ type: "job-exit", reqId, code: 127, signal: undefined });
      this.log(`job ${reqId} spawn failed: ${String(err)}`);
    }
  }
}
