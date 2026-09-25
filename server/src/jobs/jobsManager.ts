import type { AgentToServer, ServerToAgent } from "@cc/shared";

/**
 * Server-side remote job tracking over the agent job channel.
 *
 * - Jobs are reqId-correlated: dispatch `job-run` → stream `job-out` → `job-exit`.
 * - Single-flight per (nodeId, kind): a second dispatch while one runs conflicts.
 * - Server-side timeout sends `job-kill` and fails the job.
 * - Node disconnect marks running jobs interrupted; job messages for unknown
 *   reqIds (dashboard restarted mid-job, agent still streaming) are captured
 *   as orphan records so operators can see them.
 */

export type JobState = "running" | "done" | "failed" | "interrupted";

export interface JobRecord {
  reqId: string;
  nodeId: string;
  kind: string;
  argv: string[];
  state: JobState;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null | undefined;
  output: string;
  truncated: boolean;
  orphan: boolean;
}

export interface JobsManagerDeps {
  send: (nodeId: string, msg: ServerToAgent) => boolean;
  isConnected: (nodeId: string) => boolean;
  now?: () => number;
  genReqId?: () => string;
  /** Ring cap per node (oldest finished jobs evicted). */
  maxJobsPerNode?: number;
  maxOutputBytes?: number;
}

export type DispatchResult = { reqId: string } | { error: "not-connected" } | { error: "conflict" };

const DEFAULT_MAX_JOBS = 50;
const DEFAULT_MAX_OUTPUT = 256 * 1024;

export class JobsManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly byNode = new Map<string, string[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly finishedListeners: Array<(job: JobRecord) => void> = [];
  private readonly deps: Required<Pick<JobsManagerDeps, "maxJobsPerNode" | "maxOutputBytes">> &
    Omit<JobsManagerDeps, "maxJobsPerNode" | "maxOutputBytes">;

  constructor(deps: JobsManagerDeps) {
    this.deps = {
      maxJobsPerNode: deps.maxJobsPerNode ?? DEFAULT_MAX_JOBS,
      maxOutputBytes: deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
      ...deps,
    };
  }

  /** Subscribe to job terminal transitions (done/failed/interrupted). */
  onFinished(listener: (job: JobRecord) => void): () => void {
    this.finishedListeners.push(listener);
    return () => {
      const i = this.finishedListeners.indexOf(listener);
      if (i >= 0) this.finishedListeners.splice(i, 1);
    };
  }

  /** Whether the node's agent channel is currently connected. */
  isConnected(nodeId: string): boolean {
    return this.deps.isConnected(nodeId);
  }

  private notifyFinished(job: JobRecord): void {
    for (const l of this.finishedListeners) l(job);
  }

  dispatch(nodeId: string, kind: string, argv: string[], opts: { timeoutMs?: number } = {}): DispatchResult {
    if (!this.deps.isConnected(nodeId)) return { error: "not-connected" };
    if (this.isRunning(nodeId, kind)) return { error: "conflict" };

    const reqId = this.deps.genReqId?.() ?? `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const record: JobRecord = {
      reqId,
      nodeId,
      kind,
      argv,
      state: "running",
      startedAt: this.deps.now?.() ?? Date.now(),
      endedAt: null,
      exitCode: null,
      signal: undefined,
      output: "",
      truncated: false,
      orphan: false,
    };
    this.jobs.set(reqId, record);
    this.pushNodeIndex(nodeId, reqId);

    const sent = this.deps.send(nodeId, { type: "job-run", reqId, argv, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
    if (!sent) {
      record.state = "failed";
      record.endedAt = this.deps.now?.() ?? Date.now();
      record.output += "[server] dispatch failed: socket write rejected\n";
      this.notifyFinished(record);
      return { reqId };
    }

    if (opts.timeoutMs) {
      const timer = setTimeout(() => {
        if (this.jobs.get(reqId)?.state !== "running") return;
        this.deps.send(nodeId, { type: "job-kill", reqId });
        const job = this.jobs.get(reqId);
        if (job && job.state === "running") {
          job.state = "failed";
          job.endedAt = this.deps.now?.() ?? Date.now();
          job.output += `[server] timed out after ${opts.timeoutMs}ms\n`;
          this.notifyFinished(job);
        }
        this.timers.delete(reqId);
      }, opts.timeoutMs + 5_000); // grace for the kill + exit frame
      this.timers.set(reqId, timer);
    }
    return { reqId };
  }

  /** Feed agent messages; captures job-out/job-exit (incl. orphans). */
  observeMessage(nodeId: string, msg: AgentToServer): void {
    if (msg.type === "job-out") {
      const job = this.jobs.get(msg.reqId);
      if (job) {
        this.appendOutput(job, msg.chunk);
        return;
      }
      this.recordOrphan(nodeId, msg.reqId, msg.chunk);
      return;
    }
    if (msg.type === "job-exit") {
      const job = this.jobs.get(msg.reqId);
      const timer = this.timers.get(msg.reqId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(msg.reqId);
      }
      if (job && job.state === "running") {
        job.state = msg.code === 0 ? "done" : "failed";
        job.endedAt = this.deps.now?.() ?? Date.now();
        job.exitCode = msg.code;
        job.signal = msg.signal;
        this.notifyFinished(job);
      }
    }
  }

  /** Mark every running job on a node interrupted (agent socket dropped). */
  onNodeDisconnected(nodeId: string): void {
    for (const reqId of this.byNode.get(nodeId) ?? []) {
      const job = this.jobs.get(reqId);
      if (job?.state === "running") {
        job.state = "interrupted";
        job.endedAt = this.deps.now?.() ?? Date.now();
        this.notifyFinished(job);
      }
    }
  }

  /** Cancel a running job: kill on the agent and mark failed. */
  cancel(reqId: string): boolean {
    const job = this.jobs.get(reqId);
    if (!job || job.state !== "running") return false;
    this.deps.send(job.nodeId, { type: "job-kill", reqId });
    const timer = this.timers.get(reqId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(reqId);
    }
    job.state = "failed";
    job.endedAt = this.deps.now?.() ?? Date.now();
    job.output += "[server] cancelled by operator\n";
    this.notifyFinished(job);
    return true;
  }

  isRunning(nodeId: string, kind: string): boolean {
    return (this.byNode.get(nodeId) ?? []).some((reqId) => {
      const job = this.jobs.get(reqId);
      return job !== undefined && job.kind === kind && job.state === "running";
    });
  }

  list(filter: { nodeId?: string; active?: boolean } = [] as never): JobRecord[] {
    let records = [...this.jobs.values()];
    if (filter.nodeId) records = records.filter((j) => j.nodeId === filter.nodeId);
    if (filter.active) records = records.filter((j) => j.state === "running");
    return records.sort((a, b) => b.startedAt - a.startedAt);
  }

  get(reqId: string): JobRecord | undefined {
    return this.jobs.get(reqId);
  }

  private appendOutput(job: JobRecord, chunk: string): void {
    if (job.output.length >= this.deps.maxOutputBytes) {
      job.truncated = true;
      return;
    }
    job.output += chunk;
    if (job.output.length > this.deps.maxOutputBytes) {
      job.output = job.output.slice(0, this.deps.maxOutputBytes);
      job.truncated = true;
    }
  }

  private recordOrphan(nodeId: string, reqId: string, chunk: string): void {
    if (this.jobs.has(reqId)) return;
    const record: JobRecord = {
      reqId,
      nodeId,
      kind: "orphan",
      argv: [],
      state: "running",
      startedAt: this.deps.now?.() ?? Date.now(),
      endedAt: null,
      exitCode: null,
      signal: undefined,
      output: chunk,
      truncated: false,
      orphan: true,
    };
    this.jobs.set(reqId, record);
    this.pushNodeIndex(nodeId, reqId);
  }

  private pushNodeIndex(nodeId: string, reqId: string): void {
    const list = this.byNode.get(nodeId) ?? [];
    list.push(reqId);
    while (list.length > this.deps.maxJobsPerNode) {
      const oldest = list.shift();
      if (oldest) {
        const job = this.jobs.get(oldest);
        if (job && job.state !== "running") this.jobs.delete(oldest);
      }
    }
    this.byNode.set(nodeId, list);
  }
}
