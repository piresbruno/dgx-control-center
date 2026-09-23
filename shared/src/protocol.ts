import { z } from "zod";

/**
 * Agent WS protocol (v1) — PLAN.md F1a. Contract-first: server, agent and
 * tests all validate against these schemas; changes here are compile errors.
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

export const respMsg = z.object({
  type: z.literal("resp"),
  reqId: z.string(),
  ok: z.boolean(),
  payload: z.unknown().optional(),
  error: z.string().optional(),
});
export type RespMsg = z.infer<typeof respMsg>;

/** Server → agent: run a job by argv (no remote shell by default). */
export const jobRunMsg = z.object({
  type: z.literal("job-run"),
  reqId: z.string(),
  argv: z.array(z.string()).min(1),
  timeoutMs: z.number().int().positive().optional(),
});
export type JobRunMsg = z.infer<typeof jobRunMsg>;

/** Server → agent messages. */
export const serverToAgent = z.discriminatedUnion("type", [welcomeMsg, jobRunMsg]);
export type ServerToAgent = z.infer<typeof serverToAgent>;

/** Agent → server messages. */
export const agentToServer = z.discriminatedUnion("type", [helloMsg, metricsMsg, respMsg]);
export type AgentToServer = z.infer<typeof agentToServer>;
