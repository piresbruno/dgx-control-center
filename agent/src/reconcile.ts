import { z } from "zod";
import { atomicWriteJson, readJson } from "./util/agentState.js";

/**
 * Agent-local reconcile (F1a edge autonomy): the node re-applies its desired
 * clock profile **without the dashboard** — at daemon start (node boot resets
 * clocks) and whenever the server pushes a config-update with a profile.
 * The apply action is injected: M5 binds it to the spark-clock helper.
 */

export const agentDesiredStateSchema = z.object({
  version: z.literal(1).default(1),
  clockProfileId: z.string().nullable().default(null),
  /** What the last successful apply actually set (reconcile target). */
  lastApplied: z
    .object({
      clockProfileId: z.string().nullable(),
      at: z.number().int().positive(),
    })
    .nullable()
    .default(null),
});
export type AgentDesiredState = z.infer<typeof agentDesiredStateSchema>;

/** Clock application seam — the real impl is the spark-clock helper (M5). */
export interface ClockApplier {
  applyProfile(profileId: string | null): Promise<void>;
}

export interface ReconcileOutcome {
  applied: boolean;
  /** Error message when the apply failed (state left unchanged for retry). */
  error?: string;
}

export async function loadAgentState(file: string): Promise<AgentDesiredState> {
  const parsed = agentDesiredStateSchema.safeParse(await readJson<unknown>(file, {}));
  return parsed.success ? parsed.data : { version: 1, clockProfileId: null, lastApplied: null };
}

export async function saveAgentState(file: string, state: AgentDesiredState): Promise<void> {
  await atomicWriteJson(file, agentDesiredStateSchema.parse(state));
}

/**
 * Reconcile clocks toward the desired profile. Mid-session calls are
 * idempotent (no apply when lastApplied matches). Boot calls pass
 * `force: true` — a node boot resets clocks, so a set profile is always
 * re-applied even when the recorded lastApplied matches. A failed apply is
 * NOT recorded — the next boot/tick retries.
 */
export async function reconcileClocks(
  file: string,
  applier: ClockApplier,
  now: number = Date.now(),
  opts: { force?: boolean } = {},
): Promise<ReconcileOutcome> {
  const state = await loadAgentState(file);
  // null and undefined both mean "no profile" — must not spuriously apply.
  const desired = state.clockProfileId;
  if (desired === null && (state.lastApplied?.clockProfileId ?? null) === null) {
    return { applied: false };
  }
  if (!opts.force && (state.lastApplied?.clockProfileId ?? null) === desired) {
    return { applied: false };
  }
  try {
    await applier.applyProfile(desired);
  } catch (err) {
    return { applied: false, error: String(err) };
  }
  const next: AgentDesiredState = {
    version: 1,
    clockProfileId: desired,
    lastApplied: { clockProfileId: desired, at: now },
  };
  await saveAgentState(file, next);
  return { applied: true };
}

/** Update the desired profile from a config-update/welcome frame. */
export async function setDesiredProfile(
  file: string,
  clockProfileId: string | null | undefined,
): Promise<AgentDesiredState> {
  const state = await loadAgentState(file);
  const next: AgentDesiredState = { ...state, clockProfileId: clockProfileId ?? null };
  await saveAgentState(file, next);
  return next;
}
