/** REST client for M6 alerting. */

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertState = "firing" | "acknowledged" | "resolved";

export interface AlertRow {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  entity: string;
  detail: string;
  state: AlertState;
  firedAt: number;
  ackedAt: number | null;
  ackedBy: string | null;
  resolvedAt: number | null;
  resolvedNote: string | null;
  mutedUntil: number | null;
}

export interface AlertEvent {
  id: number;
  ts: number;
  alertId: string;
  ruleId: string;
  kind: "fired" | "acknowledged" | "resolved" | "muted" | "unmuted" | "re-fired";
  actor: string | null;
  note: string | null;
}

export interface AlertRule {
  id: string;
  name: string;
  severity: AlertSeverity;
  enabled: boolean;
  seed: boolean;
  condition: {
    source: "node-metric" | "gateway-5xx" | "node-unreachable";
    path?: string;
    op: ">" | "<" | ">=" | "<=";
    value: number;
    forMs: number;
  };
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const listAlerts = (state?: "open" | AlertState): Promise<{ alerts: AlertRow[] }> =>
  json(`/api/alerts${state ? `?state=${state}` : ""}`);
export const listAlertEvents = (limit = 200): Promise<{ events: AlertEvent[] }> => json(`/api/alerts/events?limit=${limit}`);
export const ackAlert = (id: string, by: string): Promise<{ acknowledged: boolean }> =>
  json(`/api/alerts/${id}/ack`, { method: "POST", body: JSON.stringify({ by }) });
export const resolveAlert = (id: string, note: string): Promise<{ resolved: boolean }> =>
  json(`/api/alerts/${id}/resolve`, { method: "POST", body: JSON.stringify({ note }) });
export const muteAlert = (id: string, untilMs: number): Promise<{ muted: boolean }> =>
  json(`/api/alerts/${id}/mute`, { method: "POST", body: JSON.stringify({ untilMs }) });

export const listRules = (): Promise<{ rules: AlertRule[] }> => json("/api/alerts/rules");
export const saveRule = (rule: AlertRule): Promise<AlertRule> =>
  json(`/api/alerts/rules/${rule.id}`, { method: "PUT", body: JSON.stringify(rule) });
export const deleteRule = (id: string): Promise<{ removed: boolean }> => json(`/api/alerts/rules/${id}`, { method: "DELETE" });

export const alertsHistoryCsvUrl = "/api/alerts/history.csv";
