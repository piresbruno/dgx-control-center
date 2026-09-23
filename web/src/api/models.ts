/** REST client for the M2 model plane. */

export interface ModelRow {
  name: string;
  repository: string;
  runtime?: string;
  bytes?: number;
}

export interface InventorySnapshot {
  targetId: string;
  models: ModelRow[];
  fetchedAt: number;
  stale: boolean;
  error: string | null;
}

export interface JobRecord {
  reqId: string;
  nodeId: string;
  kind: string;
  argv: string[];
  state: "running" | "done" | "failed" | "interrupted";
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null | undefined;
  output: string;
  truncated: boolean;
  orphan: boolean;
}

export interface CheckOutcome {
  ok: boolean;
  mode: "present" | "installed" | "missing" | "failed";
  version: string | null;
  reason: string | null;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const getNasModels = (): Promise<InventorySnapshot> => json("/api/models");
export const getNodeModels = (id: string): Promise<InventorySnapshot> => json(`/api/nodes/${id}/models`);
export const checkModelctl = (id: string): Promise<CheckOutcome> => json(`/api/nodes/${id}/modelctl-check`);
export const provisionModelctl = (id: string): Promise<CheckOutcome> =>
  json(`/api/nodes/${id}/provision-modelctl`, { method: "POST" });

export const dispatchJob = (nodeId: string, kind: string, params: Record<string, string> = {}, timeoutMs?: number): Promise<{ reqId: string }> =>
  json(`/api/nodes/${nodeId}/jobs`, { method: "POST", body: JSON.stringify({ kind, params, timeoutMs }) });

export const listJobs = (nodeId?: string, active?: boolean): Promise<{ jobs: JobRecord[] }> =>
  json(`/api/jobs?${nodeId ? `nodeId=${nodeId}&` : ""}${active ? "active=1" : ""}`);
export const getJob = (reqId: string): Promise<JobRecord> => json(`/api/jobs/${reqId}`);
export const cancelJob = (reqId: string): Promise<{ reqId: string; state: string }> =>
  json(`/api/jobs/${reqId}/cancel`, { method: "POST" });

export function humanBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
