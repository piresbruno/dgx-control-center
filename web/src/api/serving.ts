/** REST client for the M3 serving plane (recipes, deployments, verbs). */

export interface RecipeVariant {
  rel: string;
  name: string;
}

export interface RecipeMeta {
  port: number | null;
  model: string | null;
  modelFallback: string | null;
  servedName: string | null;
  headIp: string | null;
  workerIp: string | null;
  workerUser: string | null;
  nnodes: number;
  tp: number | null;
  readyTimeoutS: number | null;
  maxModelLen: number | null;
  image: string | null;
  containers: Record<string, string>;
  containersByEntry: Record<string, Record<string, string>>;
  secretPresence: Record<string, boolean>;
  entry: string | null;
  variants: RecipeVariant[];
  class: "repo" | "script";
  verbs: string[];
}

export interface RecipeRecord {
  id: string;
  sparkId: string;
  path: string;
  label: string | null;
  entry: string | null;
  meta: RecipeMeta | null;
  versions: { gitHead: string | null; dirtyBuild: boolean; probedAt: number } | null;
  files: string[];
  orphaned: boolean;
  probeError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ServeStateName =
  | "orphan"
  | "stopping"
  | "foreign"
  | "healthy"
  | "healthy-keyed"
  | "starting"
  | "unknown"
  | "up"
  | "failed"
  | "stopped";

export interface ServeProbe {
  containers: Record<string, string>;
  health: number | null;
  modelsRaw: string | null;
  dockerError?: string;
  ranks?: Record<string, string>;
  parsedAt?: number;
}

export interface DeploymentRecord {
  id: string;
  recipeId: string;
  sparkId: string;
  desired: "running" | "stopped";
  entry: string | null;
  port: number | null;
  servedName: string | null;
  jobId: string | null;
  jobState: string | null;
  startedWith: { gitHead: string | null; dirtyBuild: boolean } | null;
  lastProbe: ServeProbe | null;
  createdAt: number;
  updatedAt: number;
  state:
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
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; guard?: unknown };
    const err = new Error(body.error ?? `${res.status} ${res.statusText}`) as Error & { guard?: unknown; status?: number };
    err.guard = body.guard;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export const listRecipes = (): Promise<{ recipes: RecipeRecord[] }> => json("/api/recipes");
export const registerRecipe = (nodeId: string, path: string, label?: string): Promise<{ recipe: RecipeRecord; jobId?: string }> =>
  json("/api/recipes", { method: "POST", body: JSON.stringify({ nodeId, path, label }) });
export const probeRecipe = (id: string): Promise<{ jobId: string }> => json(`/api/recipes/${id}/probe`, { method: "POST" });
export const deleteRecipe = (id: string): Promise<{ removed: boolean }> => json(`/api/recipes/${id}`, { method: "DELETE" });

export const listDeployments = (): Promise<{ deployments: DeploymentRecord[] }> => json("/api/serve/deployments");
export const createDeployment = (recipeId: string): Promise<DeploymentRecord> =>
  json("/api/serve/deployments", { method: "POST", body: JSON.stringify({ recipeId }) });
export const getDeployment = (id: string): Promise<DeploymentRecord> => json(`/api/serve/deployments/${id}`);
export const deploymentVerb = (id: string, verb: "start" | "stop" | "restart" | "probe"): Promise<{ reqId: string }> =>
  json(`/api/serve/deployments/${id}/${verb}`, { method: "POST" });
export const deleteDeployment = (id: string): Promise<{ removed: boolean }> =>
  json(`/api/serve/deployments/${id}`, { method: "DELETE" });

export const getJob = (reqId: string): Promise<import("./models.js").JobRecord> => json(`/api/jobs/${reqId}`);
