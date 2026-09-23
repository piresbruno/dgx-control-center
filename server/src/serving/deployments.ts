import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { shellQuote } from "../util/shellQuote.js";
import type { JobsManager, JobRecord } from "../jobs/jobsManager.js";

/**
 * Deployment supervisor (M3): drives user-owned recipe verbs over the agent
 * job channel and derives one observed state per deployment (ADR-0005 — the
 * dashboard never edits recipe content; it runs verbs and observes).
 */

export const RECIPE_VERBS = new Set(["start", "stop", "restart", "status", "logs", "download"]);
export type RecipeVerb = "start" | "stop" | "restart" | "status" | "logs" | "download";

/**
 * USER/LOGNAME are unset in non-interactive ssh/nohup shells; recipes that
 * default WORKER_USER to $USER under `set -u` abort without them.
 */
function shellEnvBootstrap(): string {
  return [
    '[ -n "${USER:-}" ] || USER=$(id -un); export USER',
    '[ -n "${LOGNAME:-}" ] || LOGNAME=$USER; export LOGNAME',
  ].join("\n");
}

/** Multi-line driver script for a recipe verb (start/restart run long). */
export function buildRecipeVerbScript(absPath: string, entry: string, verb: RecipeVerb): string {
  if (!RECIPE_VERBS.has(verb)) throw new Error(`invalid recipe verb: ${verb}`);
  return [shellEnvBootstrap(), `cd ${shellQuote(absPath)} || { echo "__RECIPE_NOPATH__"; exit 3; }`, `./${entry} ${verb}`].join("\n");
}

/** One-shot verb exec (stop / status text fallback). */
export function buildRecipeVerbCommand(absPath: string, entry: string, verb: RecipeVerb): string {
  return buildRecipeVerbScript(absPath, entry, verb).replace(/\n/g, "; ");
}

/**
 * Head serve probe (one exec): container set + engine health + model ids.
 * Pure builder; `names` unused — membership is decided by the parser.
 */
export function buildServeProbeCommand(port: number | null): string {
  const lines = [
    "echo __S_CONTAINERS__",
    "docker ps -a --format '{{.Names}}|{{.State}}' 2>&1 | head -60",
  ];
  if (Number.isInteger(port)) {
    lines.push(
      "echo __S_HEALTH__",
      `printf '%s' "$(curl -s -o /dev/null -w '%{http_code}' -m 4 http://127.0.0.1:${port}/health 2>/dev/null || echo 000)"`,
      "echo",
      "echo __S_MODELS__",
      `printf '%s' "$(curl -s -m 4 http://127.0.0.1:${port}/v1/models 2>/dev/null | head -c 1500)"`,
      "echo",
    );
  }
  return lines.join("\n");
}

export interface ServeProbe {
  containers: Record<string, string>;
  health: number | null;
  modelsRaw: string | null;
  dockerError?: string;
  parseError?: string;
}

export function parseServeProbe(out: string): ServeProbe {
  const text = String(out ?? "");
  const result: ServeProbe = { containers: {}, health: null, modelsRaw: null };
  const cIdx = text.indexOf("__S_CONTAINERS__");
  if (cIdx < 0) return { ...result, parseError: "probe output missing" };
  let rest = text.slice(cIdx + "__S_CONTAINERS__".length);
  const hIdx = rest.indexOf("__S_HEALTH__");
  const containersBlock = hIdx >= 0 ? rest.slice(0, hIdx) : rest;
  for (const line of containersBlock.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (/permission denied|cannot connect|command not found|dial tcp/i.test(t)) {
      result.dockerError = t.slice(0, 200);
      continue;
    }
    const m = t.match(/^(.+)\|(running|exited|created|restarting|removing|paused|dead)$/);
    if (m) result.containers[m[1]!] = m[2] === "running" ? "running" : "exited";
  }
  if (hIdx >= 0) {
    rest = rest.slice(hIdx + "__S_HEALTH__".length);
    const mIdx = rest.indexOf("__S_MODELS__");
    const hLine = (mIdx >= 0 ? rest.slice(0, mIdx) : rest).trim().split("\n")[0] ?? "";
    const code = parseInt(hLine, 10);
    result.health = Number.isInteger(code) ? code : null;
    if (mIdx >= 0) result.modelsRaw = rest.slice(mIdx + "__S_MODELS__".length).trim().split("\n")[0] || null;
  }
  return result;
}

/** Per-container rank against the expected map (probe is set-free). */
export function rankStates(
  expected: Record<string, string>,
  probe: Partial<ServeProbe> | null | undefined,
): Record<string, "running" | "exited" | "absent" | "error"> {
  const out: Record<string, string> = {};
  const keys = Object.keys(expected ?? {});
  if (!probe || (probe.dockerError && Object.keys(probe.containers ?? {}).length === 0)) {
    for (const k of keys) out[k] = "error";
    return out as Record<string, "error">;
  }
  for (const k of keys) out[k] = probe.containers?.[expected[k]!] ?? "absent";
  return out as Record<string, "running" | "exited" | "absent" | "error">;
}

export function parseModelIds(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  const ids = [...String(raw).matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!);
  return ids.length ? ids : null;
}

function normModel(s: string | null | undefined): string {
  const t = String(s ?? "").trim();
  return (t.split("/").pop() ?? t).toLowerCase();
}

// ─── Pure state join ───────────────────────────────────────

export interface ServeStateFactors {
  desired: "running" | "stopped";
  orphaned?: boolean;
  job?: Pick<JobRecord, "state"> & { exitCode: number | null } | null;
  llm?: { available?: boolean; modelId?: string | null } | null;
  probe?: { health?: number | null; containers?: Record<string, string>; dockerError?: string; modelsRaw?: string | null } | null;
  ranks?: Record<string, "running" | "exited" | "absent" | "error"> | null;
  servedName?: string | null;
  engineIds?: string[] | null;
}

export type ServeState =
  | { state: "orphan"; jobLive: boolean }
  | { state: "stopping" }
  | { state: "foreign"; servedId: string; servedIdMatch: false }
  | { state: "healthy"; warmup: boolean; servedIdMatch: boolean | null }
  | { state: "healthy-keyed"; authRequired: true }
  | { state: "starting" }
  | { state: "unknown"; reason: string }
  | { state: "up"; note: string }
  | { state: "failed"; exitCode: number | null }
  | { state: "stopped" };

/**
 * Observed deployment state. Precedence: user intent (desired=stopped +
 * live job → stopping, never failed); a live driver means "starting" ONLY
 * while the API is silent — start.sh keeps running post-ready warmup after
 * /health passes, and the truth is then healthy.
 */
export function joinServeState(f: ServeStateFactors): ServeState {
  const jobLive = f.job != null && (f.job.state === "running");
  const anyRankRunning = f.ranks ? Object.values(f.ranks).some((v) => v === "running") : false;
  const allProbeError = Boolean(f.probe?.dockerError) && Object.keys(f.probe?.containers ?? {}).length === 0;
  const seenIds = [...(f.llm?.modelId ? [f.llm.modelId] : []), ...(parseModelIds(f.probe?.modelsRaw) ?? [])];
  const idMatch =
    !f.servedName || seenIds.length === 0 ? null : seenIds.some((id) => normModel(id) === normModel(f.servedName));
  const apiUp = Boolean(f.llm?.available || f.probe?.health === 200);

  if (f.orphaned) return { state: "orphan", jobLive };
  if (jobLive && f.desired === "stopped") return { state: "stopping" };
  if (apiUp && idMatch === false) {
    // The port answers with someone else's engine (port collision) — never
    // report this deployment healthy.
    return { state: "foreign", servedId: seenIds[0] ?? "", servedIdMatch: false };
  }
  if (apiUp) {
    return { state: "healthy", warmup: jobLive && f.desired === "running", servedIdMatch: idMatch };
  }
  if (jobLive && f.desired === "running") return { state: "starting" };
  if (f.probe?.health === 401 && anyRankRunning) return { state: "healthy-keyed", authRequired: true };
  if (allProbeError) return { state: "unknown", reason: "probe exec failed" };
  if (anyRankRunning && f.desired === "stopped") return { state: "stopping" };
  if (anyRankRunning) return { state: "up", note: "containers running; API not answering yet" };
  const jobFailed = f.job != null && ["failed", "interrupted"].includes(f.job.state);
  if (f.desired === "running" && jobFailed) return { state: "failed", exitCode: f.job?.exitCode ?? null };
  return { state: "stopped" };
}

// ─── Store ─────────────────────────────────────────────────

const recordSchema = z.object({
  id: z.string(),
  recipeId: z.string(),
  sparkId: z.string(),
  desired: z.enum(["running", "stopped"]).default("stopped"),
  entry: z.string().nullable().default(null),
  port: z.number().nullable().default(null),
  servedName: z.string().nullable().default(null),
  jobId: z.string().nullable().default(null),
  jobState: z.string().nullable().default(null),
  startedWith: z.object({ gitHead: z.string().nullable(), dirtyBuild: z.boolean() }).nullable().default(null),
  lastProbe: z.any().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type DeploymentRecord = z.infer<typeof recordSchema>;

export interface DeploymentStoreDeps {
  filePath: string;
  now?: () => number;
}

/** JSON-file store; one deployment per recipe (identity = recipeId). */
export class DeploymentStore {
  private readonly deployments = new Map<string, DeploymentRecord>();
  private readonly file: string;
  private readonly now: () => number;

  constructor(deps: DeploymentStoreDeps) {
    this.file = deps.filePath;
    this.now = deps.now ?? Date.now;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const d of raw.deployments ?? []) {
        const parsed = recordSchema.safeParse(d);
        if (parsed.success) this.deployments.set(parsed.data.id, parsed.data);
      }
    } catch (err) {
      console.error("[serve-deployments] failed to load state:", err instanceof Error ? err.message : err);
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    const deployments = [...this.deployments.values()].sort((a, b) => a.id.localeCompare(b.id));
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, deployments }, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[serve-deployments] failed to persist state:", err instanceof Error ? err.message : err);
    }
  }

  list(): DeploymentRecord[] {
    return [...this.deployments.values()];
  }

  get(id: string): DeploymentRecord | null {
    return this.deployments.get(id) ?? null;
  }

  byRecipe(recipeId: string): DeploymentRecord | null {
    for (const d of this.deployments.values()) if (d.recipeId === recipeId) return d;
    return null;
  }

  /** One deployment per recipe — reused across restarts. */
  upsertForRecipe(
    recipeId: string,
    seed: { sparkId: string; entry?: string | null; port?: number | null; servedName?: string | null },
    patch: Partial<DeploymentRecord> = {},
  ): DeploymentRecord {
    let d = this.byRecipe(recipeId);
    if (!d) {
      d = {
        id: `dep-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`,
        recipeId,
        sparkId: seed.sparkId,
        desired: "stopped",
        entry: seed.entry ?? null,
        port: seed.port ?? null,
        servedName: seed.servedName ?? null,
        jobId: null,
        jobState: null,
        startedWith: null,
        lastProbe: null,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.deployments.set(d.id, d);
    }
    Object.assign(d, patch, { updatedAt: this.now() });
    this.persist();
    return d;
  }

  remove(id: string): boolean {
    if (!this.deployments.delete(id)) return false;
    this.persist();
    return true;
  }
}

// ─── Supervisor ────────────────────────────────────────────

export interface SupervisorDeps {
  jobs: JobsManager;
  /** Recipe lookup for (path, entry, port, servedName) and versions. */
  recipes: {
    get(id: string): {
      id: string;
      sparkId: string;
      path: string;
      entry: string | null;
      meta: { port: number | null; servedName: string | null; containers?: Record<string, string> } | null;
      versions: { gitHead: string | null; dirtyBuild: boolean } | null;
    } | null;
  };
  /** Deployment records; the supervisor mutates and persists through it. */
  store: Pick<DeploymentStore, "get" | "upsertForRecipe">;
  now?: () => number;
  /** start/restart driver timeout (recipes can warm up for minutes). */
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  probeTimeoutMs?: number;
}

type Action = { deploymentId: string; verb: RecipeVerb | "probe" };

/**
 * Runs recipe verbs as jobs; on finish, records jobState and refreshes
 * probes. Single-flight comes from the jobs layer via per-verb kinds.
 */
export class DeploymentSupervisor {
  private readonly actions = new Map<string, Action>(); // reqId → action
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: SupervisorDeps) {
    this.unsubscribe = deps.jobs.onFinished((job) => this.onFinished(job));
  }

  /** Detach the finished-job listener (tests / shutdown). */
  dispose(): void {
    this.unsubscribe();
  }

  /** Desired-start a recipe's deployment (dispatches the start driver). */
  start(deploymentId: string): { reqId: string } | { error: string } {
    return this.dispatchVerb(deploymentId, "start");
  }

  stop(deploymentId: string): { reqId: string } | { error: string } {
    return this.dispatchVerb(deploymentId, "stop");
  }

  restart(deploymentId: string): { reqId: string } | { error: string } {
    return this.dispatchVerb(deploymentId, "restart");
  }

  /** Read-only observation probe (containers, health, model ids). */
  probe(deploymentId: string): { reqId: string } | { error: string } {
    const d = this.deps.store.get(deploymentId);
    if (!d) return { error: "unknown deployment" };
    const result = this.deps.jobs.dispatch(
      d.sparkId,
      "serve-probe",
      ["bash", "-c", buildServeProbeCommand(d.port)],
      { timeoutMs: this.deps.probeTimeoutMs ?? 30_000 },
    );
    if ("error" in result) return result;
    this.actions.set(result.reqId, { deploymentId, verb: "probe" });
    return { reqId: result.reqId };
  }

  private dispatchVerb(deploymentId: string, verb: RecipeVerb): { reqId: string } | { error: string } {
    const d = this.deps.store.get(deploymentId);
    if (!d) return { error: "unknown deployment" };
    const recipe = this.deps.recipes.get(d.recipeId);
    if (!recipe) return { error: "unknown recipe" };
    const entry = d.entry ?? recipe.entry;
    if (!entry) return { error: "recipe not probed yet — no entry script" };
    if (!RECIPE_VERBS.has(verb)) return { error: `invalid verb: ${verb}` };
    const timeoutMs = verb === "stop" ? this.deps.stopTimeoutMs ?? 120_000 : this.deps.startTimeoutMs ?? 900_000;
    const result = this.deps.jobs.dispatch(
      d.sparkId,
      `recipe-verb:${verb}`,
      ["bash", "-c", buildRecipeVerbScript(recipe.path, entry, verb)],
      { timeoutMs },
    );
    if ("error" in result) return result;
    this.actions.set(result.reqId, { deploymentId, verb });
    return { reqId: result.reqId };
  }

  private onFinished(job: JobRecord): void {
    const action = this.actions.get(job.reqId);
    if (!action) return;
    this.actions.delete(job.reqId);
    const d = this.deps.store.get(action.deploymentId);
    if (!d) return;
    if (action.verb === "probe") {
      if (job.state === "done") {
        const parsed = parseServeProbe(job.output);
        this.deps.store.upsertForRecipe(d.recipeId, { sparkId: d.sparkId }, {
          lastProbe: { ...parsed, ranks: rankStates(this.expectedFor(d), parsed), parsedAt: Date.now() },
        });
      }
      return;
    }
    if (action.verb === "start") {
      const patch: Partial<DeploymentRecord> = { jobState: job.state };
      if (job.state === "done") {
        patch.startedWith = this.versionsFor(d.recipeId);
        patch.desired = "running";
      }
      this.deps.store.upsertForRecipe(d.recipeId, { sparkId: d.sparkId }, patch);
      return;
    }
    if (action.verb === "stop") {
      const patch: Partial<DeploymentRecord> = { jobState: job.state };
      if (job.state === "done") patch.desired = "stopped";
      this.deps.store.upsertForRecipe(d.recipeId, { sparkId: d.sparkId }, patch);
      return;
    }
    this.deps.store.upsertForRecipe(d.recipeId, { sparkId: d.sparkId }, { jobState: job.state });
  }

  private expectedFor(d: DeploymentRecord): Record<string, string> {
    const recipe = this.deps.recipes.get(d.recipeId);
    return recipe?.meta?.containers ?? {};
  }

  private versionsFor(recipeId: string): { gitHead: string | null; dirtyBuild: boolean } | null {
    const recipe = this.deps.recipes.get(recipeId);
    return recipe?.versions ? { gitHead: recipe.versions.gitHead, dirtyBuild: recipe.versions.dirtyBuild } : null;
  }
}
