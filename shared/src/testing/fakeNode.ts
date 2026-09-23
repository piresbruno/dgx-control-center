import type {
  AgentToServer,
  HelloMsg,
  LlmMsg,
  MetricsMsg,
  ServeLogMsg,
  ServerToAgent,
} from "../index.js";
import { PROTOCOL_VERSION, VERSION } from "../version.js";

/**
 * FakeNode (F1a): the agent-protocol test double. Deterministic by default —
 * delivery order and time are controlled by injectable `schedule`/`nowMs`,
 * and every fault is an explicit switch. Consumed by server unit tests
 * (handshake, reconciler, staleness) and by `--fake-fleet` dev mode.
 */

export type ScheduleFn = (fn: () => void, delayMs: number) => void;

export interface FakeLlmPort {
  port: number;
  backend?: string;
  modelId?: string;
  available?: boolean;
}

export interface FakeNodeOptions {
  sparkId: string;
  token?: string;
  version?: string;
  proto?: number;
  role?: "head" | "worker" | "standalone";
  llmPorts?: FakeLlmPort[];
  /** Deterministic delivery scheduler (default: run-now when delayMs === 0). */
  schedule?: ScheduleFn;
  nowMs?: () => number;
}

export interface JobBehavior {
  /** Process exit code; null ⇒ killed by signal. */
  exitCode: number | null;
  /** Output lines streamed as job-out before exit. */
  output?: string[];
  /** Never exits on its own — only a job-kill terminates it. */
  hang?: boolean;
}

export interface ServeStatus {
  running: boolean;
  pid?: number;
  startedAt?: number;
}

const DEFAULT_TOKEN = "f".repeat(64);
const defaultSchedule: ScheduleFn = (fn, delayMs) => {
  if (delayMs <= 0) fn();
  else setTimeout(fn, delayMs);
};

export class FakeNode {
  /** Record of every message the node emitted (in emit order). */
  readonly sent: AgentToServer[] = [];
  readonly faults = {
    /** Defer every outbound delivery by this many ms. */
    latencyMs: 0,
    /** Drop every nth outbound emit (1-based). */
    dropEveryNth: null as number | null,
    /** Repeat the previous metrics seq on the next push (replay/dedup drill). */
    staleSeq: false,
    /** Ignore server pings — watchdog timeout drill. */
    watchdogDeaf: false,
    /** Auto-disconnect after this many outbound emits. */
    disconnectAfterEmits: null as number | null,
  };

  private handlers = new Set<(msg: AgentToServer) => void>();
  private readonly schedule: ScheduleFn;
  private emitCount = 0;
  private seq = 0;
  private connected = false;
  private jobBehaviors = new Map<string, JobBehavior>();
  private serveStates = new Map<string, ServeStatus>();

  constructor(readonly opts: FakeNodeOptions) {
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  // ── server-facing wire ────────────────────────────────────────────────

  onServerMessage(handler: (msg: AgentToServer) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(msg: AgentToServer): void {
    this.emitCount += 1;
    if (this.faults.disconnectAfterEmits !== null && this.emitCount > this.faults.disconnectAfterEmits) {
      this.disconnect();
      return;
    }
    if (this.faults.dropEveryNth !== null && this.emitCount % this.faults.dropEveryNth === 0) {
      return;
    }
    this.sent.push(msg);
    const forward = () => {
      for (const handler of this.handlers) handler(msg);
    };
    if (this.faults.latencyMs > 0) this.schedule(forward, this.faults.latencyMs);
    else forward();
  }

  /** Server → node ingress. Ignored while disconnected. */
  feed(msg: ServerToAgent): void {
    if (!this.connected) return;
    switch (msg.type) {
      case "ping":
        if (this.faults.watchdogDeaf) return;
        this.emit({ type: "pong" });
        return;
      case "job-run":
        this.runJob(msg.reqId, msg.argv);
        return;
      case "job-kill":
        // A killed job always terminates by signal, hung or not.
        this.emit({ type: "job-exit", reqId: msg.reqId, code: null, signal: "SIGKILL" });
        return;
      case "serve": {
        if (msg.action === "status") {
          const state = this.serveStates.get(msg.scriptId) ?? { running: false };
          this.emit({
            type: "resp",
            reqId: msg.reqId,
            ok: true,
            payload: { scriptId: msg.scriptId, ...state },
          });
        } else if (msg.action === "start") {
          this.serveStates.set(msg.scriptId, { running: true, pid: 42000 + this.emitCount });
          this.emit({
            type: "serve-log",
            scriptId: msg.scriptId,
            chunk: `[fake] ${msg.scriptId} started`,
          } satisfies ServeLogMsg);
          this.emit({ type: "resp", reqId: msg.reqId, ok: true });
        } else {
          this.serveStates.delete(msg.scriptId);
          this.emit({ type: "resp", reqId: msg.reqId, ok: true });
        }
        return;
      }
      case "welcome":
      case "config-update":
        return;
    }
  }

  // ── agent lifecycle ───────────────────────────────────────────────────

  hello(): HelloMsg {
    return {
      type: "hello",
      sparkId: this.opts.sparkId,
      token: this.opts.token ?? DEFAULT_TOKEN,
      proto: this.opts.proto ?? PROTOCOL_VERSION,
      agentVersion: this.opts.version ?? VERSION,
    };
  }

  connect(): void {
    this.connected = true;
    this.emit(this.hello());
  }

  disconnect(): void {
    this.connected = false;
  }

  reconnect(): void {
    this.connect();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // ── telemetry emitters ────────────────────────────────────────────────

  pushMetrics(ts: number = this.opts.nowMs?.() ?? Date.now()): MetricsMsg {
    const effectiveSeq = this.faults.staleSeq ? this.seq : this.seq + 1;
    this.seq = effectiveSeq;
    const msg: MetricsMsg = {
      type: "metrics",
      seq: effectiveSeq,
      ts,
      domains: {
        gpu: { utilPct: 40 + (effectiveSeq % 50), tempC: 55 + (effectiveSeq % 15) },
        cpu: { loadPct: 10 + (effectiveSeq % 60) },
        power: { watts: 150 + (effectiveSeq % 100) },
      },
    };
    this.emit(msg);
    return msg;
  }

  pushLlm(): LlmMsg {
    const msg: LlmMsg = {
      type: "llm",
      ports: (this.opts.llmPorts ?? []).map((p, i) => ({
        port: p.port,
        available: p.available ?? true,
        backend: p.backend ?? "vllm",
        modelId: p.modelId ?? `fake-model-${i}`,
      })),
    };
    this.emit(msg);
    return msg;
  }

  // ── scripted behaviors ────────────────────────────────────────────────

  setJobBehavior(reqId: string, behavior: JobBehavior): void {
    this.jobBehaviors.set(reqId, behavior);
  }

  setServeStatus(scriptId: string, status: ServeStatus): void {
    this.serveStates.set(scriptId, status);
  }

  private runJob(reqId: string, argv: string[]): void {
    const behavior = this.jobBehaviors.get(reqId) ?? { exitCode: 0, output: [`[fake] ran ${argv[0]}`] };
    for (const line of behavior.output ?? []) {
      this.emit({ type: "job-out", reqId, stream: "out", chunk: `${line}\n` });
    }
    if (behavior.hang) return; // exits only via job-kill
    this.emit({ type: "job-exit", reqId, code: behavior.exitCode });
  }
}
