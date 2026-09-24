/** Single source of truth for versions across server, agent and web. */
export const VERSION = "1.0.0";

/** Agent protocol version — bumped on breaking WS message changes. */
export const PROTOCOL_VERSION = 1;

/** Server rejects agent hellos below this floor and offers an upgrade job. */
export const MIN_AGENT_VERSION = "0.1.0";

/** Explicit node state (PLAN.md F1a): no "implicitly fine". */
export const NODE_STATES = [
  "provisioning",
  "consistent",
  "reconciling",
  "drifted",
  "degraded",
  "offline",
] as const;
export type NodeState = (typeof NODE_STATES)[number];

/** Node kinds — spark-only features (clocks, UMA) gate on `spark`. */
export const NODE_KINDS = ["spark", "gpu-host", "nas"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_ROLES = ["head", "worker", "standalone"] as const;
export type NodeRole = (typeof NODE_ROLES)[number];
