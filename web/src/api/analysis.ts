/** REST client for the M4 analysis views. */

export interface TraceKpis {
  windowMs: number;
  requests: number;
  errors: number;
  errorRate: number;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  promptTokens: number;
  completionTokens: number;
}

export interface GroupRow {
  key: string;
  requests: number;
  errors: number;
  tokens: number;
  avgDurationMs: number;
}

export interface HourRow {
  bucket: number;
  requests: number;
  errors: number;
  tokens: number;
}

export interface AnalysisSummary {
  windowHours: number;
  kpis: TraceKpis;
  byClient: GroupRow[];
  byAlias: GroupRow[];
  byDeployment: GroupRow[];
  byHour: HourRow[];
}

export interface TraceRow {
  id: string;
  ts: number;
  client: string | null;
  alias: string;
  model: string | null;
  nodeId: string | null;
  port: number | null;
  status: number | null;
  ttftMs: number | null;
  durationMs: number;
  stream: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  itl: number[];
  attempts: Array<{ nodeId: string; port: number; status: number | null; error?: string }>;
  error: string | null;
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const getSummary = (windowHours = 24): Promise<AnalysisSummary> =>
  json(`/api/analysis/summary?windowHours=${windowHours}`);
export const getTraces = (limit = 100, alias?: string): Promise<{ traces: TraceRow[] }> =>
  json(`/api/analysis/traces?limit=${limit}${alias ? `&alias=${encodeURIComponent(alias)}` : ""}`);
export const exportCsvUrl = (windowHours = 24): string => `/api/analysis/export.csv`;

/** Fleet metric series for the explorer (any domain leaf across nodes). */
export interface FleetSeriesPoint {
  t: number;
  v: number;
}

export interface FleetSeriesRow {
  nodeId: string;
  points: FleetSeriesPoint[];
}

export interface FleetSeries {
  domain: string;
  granularity: string;
  hours: number;
  series: FleetSeriesRow[];
}

export const getFleetSeries = (domain: string, leaf: string, hours: number): Promise<FleetSeries> =>
  json(`/api/metrics/fleet?domain=${encodeURIComponent(domain)}&leaf=${encodeURIComponent(leaf)}&hours=${hours}`);
