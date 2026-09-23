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
  /** Resolved caps pushed with the profile (null = uncapped/full). */
  clockCaps: z
    .object({ gpuMaxMhz: z.number().nullable(), cpuMaxMhz: z.number().nullable() })
    .nullable()
    .default(null),
  /** What the last successful apply actually set (reconcile target). */
  lastApplied: z
    .object({
      clockProfileId: z.string().nullable(),
      at: z.number().int().positive(),
      caps: z.object({ gpuMaxMhz: z.number().nullable(), cpuMaxMhz: z.number().nullable() }).nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type AgentDesiredState = z.infer<typeof agentDesiredStateSchema>;

/** Clock application seam — the real impl is the cc-clock helper (M5). */
export interface ClockApplyRequest {
  profileId: string | null;
  caps: { gpuMaxMhz: number | null; cpuMaxMhz: number | null } | null;
}

export interface ClockApplier {
  applyProfile(profile: ClockApplyRequest): Promise<void>;
}

export interface ReconcileOutcome {
  applied: boolean;
  /** Error message when the apply failed (state left unchanged for retry). */
  error?: string;
}

export async function loadAgentState(file: string): Promise<AgentDesiredState> {
  const parsed = agentDesiredStateSchema.safeParse(await readJson<unknown>(file, {}));
  return parsed.success ? parsed.data : agentDesiredStateSchema.parse({});
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
  const desiredCaps = state.clockCaps;
  const matches =
    (state.lastApplied?.clockProfileId ?? null) === desired &&
    JSON.stringify(state.lastApplied?.caps ?? null) === JSON.stringify(desiredCaps ?? null);
  if (desired === null && desiredCaps == null && (state.lastApplied?.clockProfileId ?? null) === null) {
    return { applied: false };
  }
  if (!opts.force && matches) {
    return { applied: false };
  }
  try {
    await applier.applyProfile({ profileId: desired, caps: desiredCaps });
  } catch (err) {
    return { applied: false, error: String(err) };
  }
  const next: AgentDesiredState = agentDesiredStateSchema.parse({
    version: 1,
    clockProfileId: desired,
    clockCaps: desiredCaps,
    lastApplied: { clockProfileId: desired, at: now, caps: desiredCaps },
  });
  await saveAgentState(file, next);
  return { applied: true };
}

/** Update the desired profile from a config-update/welcome frame. */
export async function setDesiredProfile(
  file: string,
  clockProfileId: string | null | undefined,
  clockCaps?: { gpuMaxMhz: number | null; cpuMaxMhz: number | null } | null,
): Promise<AgentDesiredState> {
  const state = await loadAgentState(file);
  const next: AgentDesiredState = {
    ...state,
    clockProfileId: clockProfileId ?? null,
    clockCaps: clockCaps ?? (clockProfileId ? state.clockCaps : null),
  };
  await saveAgentState(file, next);
  return next;
}
