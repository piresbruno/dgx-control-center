import { z } from "zod";

/**
 * Agent WS protocol (v1) — PLAN.md F1a. Contract-first: server, agent and
 * tests all validate against these schemas; changes here are compile errors.
 *
 * Envelope rules:
 * - Agent→server first message must be `hello`; server answers `welcome`.
 * - Every metrics push is an atomic per-node snapshot with monotonic `seq`.
 * - Jobs are reqId-correlated: `job-run` → streamed `job-out` → `job-exit`,
 *   or a single `resp` for RPC-shaped requests.
 */

export const helloMsg = z.object({
  type: z.literal("hello"),
  sparkId: z.string().min(1),
  token: z.string().min(1),
  proto: z.number().int(),
  agentVersion: z.string().min(1),
});
export type HelloMsg = z.infer<typeof helloMsg>;

export const welcomeMsg = z.object({
  type: z.literal("welcome"),
  proto: z.number().int(),
  config: z.object({
    /** Metric cadence per domain, ms. */
    intervals: z.record(z.string(), z.number().int().positive()),
    llmPorts: z.array(z.number().int().min(1).max(65535)),
    role: z.enum(["head", "worker", "standalone"]),
  }),
});
export type WelcomeMsg = z.infer<typeof welcomeMsg>;

/** Server pushes a hot config change (cadences, ports, role, rotated token). */
export const configUpdateMsg = z.object({
  type: z.literal("config-update"),
  config: welcomeMsg.shape.config,
});
export type ConfigUpdateMsg = z.infer<typeof configUpdateMsg>;

/**
 * Atomic per-node telemetry snapshot (F1a): all domains in one message,
 * monotonic per-node `seq` for dedup/reorder, per-domain wall-clock `ts`.
 */
export const metricsMsg = z.object({
  type: z.literal("metrics"),
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  domains: z.record(z.string(), z.unknown()),
});
export type MetricsMsg = z.infer<typeof metricsMsg>;

/** Engine probe snapshot for one port (detection cadence on workers). */
export const llmMsg = z.object({
  type: z.literal("llm"),
  ports: z.array(
    z.object({
      port: z.number().int().min(1).max(65535),
      available: z.boolean(),
      backend: z.string().optional(),
      modelId: z.string().optional(),
      snapshot: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});
export type LlmMsg = z.infer<typeof llmMsg>;

/** Server → agent: run a job by argv (no remote shell by default). */
export const jobRunMsg = z.object({
  type: z.literal("job-run"),
  reqId: z.string(),
  argv: z.array(z.string()).min(1),
  /** Shell mode is an explicit opt-in (F1a: scripts transported base64). */
  shell: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type JobRunMsg = z.infer<typeof jobRunMsg>;

export const jobKillMsg = z.object({
  type: z.literal("job-kill"),
  reqId: z.string(),
});
export type JobKillMsg = z.infer<typeof jobKillMsg>;

/** Streamed job output chunk (capped ring server-side). */
export const jobOutMsg = z.object({
  type: z.literal("job-out"),
  reqId: z.string(),
  stream: z.enum(["out", "err"]),
  chunk: z.string(),
});
export type JobOutMsg = z.infer<typeof jobOutMsg>;

export const jobExitMsg = z.object({
  type: z.literal("job-exit"),
  reqId: z.string(),
  code: z.number().int().nullable(),
  signal: z.string().nullable().optional(),
});
export type JobExitMsg = z.infer<typeof jobExitMsg>;

/** Recipe/script supervision (F3): start|stop|status with env contract. */
export const serveMsg = z.object({
  type: z.literal("serve"),
  reqId: z.string(),
  action: z.enum(["start", "stop", "status"]),
  scriptId: z.string().min(1),
  script: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type ServeMsg = z.infer<typeof serveMsg>;

export const serveLogMsg = z.object({
  type: z.literal("serve-log"),
  scriptId: z.string(),
  chunk: z.string(),
});
export type ServeLogMsg = z.infer<typeof serveLogMsg>;

/** Reply to any RPC-shaped dash request (serve status, inventory, ping). */
export const respMsg = z.object({
  type: z.literal("resp"),
  reqId: z.string(),
  ok: z.boolean(),
  payload: z.unknown().optional(),
  error: z.string().optional(),
});
export type RespMsg = z.infer<typeof respMsg>;

export const pingMsg = z.object({ type: z.literal("ping") });
export const pongMsg = z.object({ type: z.literal("pong") });

/** Server → agent messages. */
export const serverToAgent = z.discriminatedUnion("type", [
  welcomeMsg,
  configUpdateMsg,
  jobRunMsg,
  jobKillMsg,
  serveMsg,
  pingMsg,
]);
export type ServerToAgent = z.infer<typeof serverToAgent>;

/** Agent → server messages. */
export const agentToServer = z.discriminatedUnion("type", [
  helloMsg,
  metricsMsg,
  llmMsg,
  jobOutMsg,
  jobExitMsg,
  serveLogMsg,
  respMsg,
  pongMsg,
]);
export type AgentToServer = z.infer<typeof agentToServer>;
