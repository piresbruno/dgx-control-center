/** REST client for M5 power & clocks. */

export interface ClockProfile {
  id: "full" | "eco" | "quiet";
  name: string;
  gpuMaxMhz: number | null;
  cpuMaxMhz: number | null;
  description: string;
}

export interface ResolvedProfile {
  profileId: string;
  gpuMaxMhz: number | null;
  cpuMaxMhz: number | null;
  clamped: boolean;
}

export interface ClockStatusRow {
  sparkId: string;
  desired: string;
  resolved: ResolvedProfile | null;
  updatedAt: number;
}

export interface ThermalEvent {
  ts: number;
  sparkId: string;
  kind: "derate" | "recover";
  tempC: number | null;
}

export interface ThermalStatus {
  nodes: Array<{ sparkId: string; state: "nominal" | "derated" }>;
  events: ThermalEvent[];
}

export interface EnergyBucket {
  nodeId: string;
  bucket: number;
  kwh: number;
  cost: number;
  minutes: number;
}

export interface EnergySummary {
  windowHours: number;
  hourly: EnergyBucket[];
  daily: EnergyBucket[];
  monthly: EnergyBucket[];
  totalKwh: number;
  totalCost: number;
}

export interface ScheduleRow {
  sparkId: string;
  tz: string;
  rules: Array<{ profileId: string; start: string; end: string }>;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const getProfiles = (): Promise<{ profiles: ClockProfile[] }> => json("/api/power/profiles");
export const getClocks = (): Promise<{ clocks: ClockStatusRow[] }> => json("/api/power/clocks");
export const setProfile = (sparkId: string, profile: string): Promise<{ resolved: ResolvedProfile }> =>
  json(`/api/power/clocks/${sparkId}`, { method: "PUT", body: JSON.stringify({ profile }) });
export const getThermal = (): Promise<ThermalStatus> => json("/api/power/thermal");
export const getEnergy = (windowHours = 168, nodeId?: string): Promise<EnergySummary> =>
  json(`/api/power/energy?windowHours=${windowHours}${nodeId ? `&nodeId=${encodeURIComponent(nodeId)}` : ""}`);
export const getSchedules = (): Promise<{ schedules: ScheduleRow[] }> => json("/api/power/schedules");
export const setSchedule = (
  sparkId: string,
  tz: string,
  rules: Array<{ profileId: string; start: string; end: string }>,
): Promise<ScheduleRow> => json(`/api/power/schedules/${sparkId}`, { method: "PUT", body: JSON.stringify({ tz, rules }) });
