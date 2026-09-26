import { useCallback, useEffect, useState } from "react";
import {
  listAlerts,
  listAlertEvents,
  ackAlert,
  resolveAlert,
  muteAlert,
  listRules,
  saveRule,
  deleteRule,
  alertsHistoryCsvUrl,
  type AlertRow,
  type AlertEvent,
  type AlertRule,
} from "../api/alerts.js";
import { ActionTd, ActionTh, CellWith, ErrorBanner, Field, FormGrid, FormRow, Segmented, TableScroller } from "../ui/index.js";

function severityPill(s: string): string {
  return `pill ${s === "critical" ? "crit" : s === "warning" ? "warn" : "info"}`;
}

function statePill(s: string): string {
  return `pill ${s === "firing" ? "crit" : s === "acknowledged" ? "warn" : "ok"}`;
}

function AlertsTable({ alerts, onChanged }: { alerts: AlertRow[]; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      {error && (
        <div className="panel-body">
          <ErrorBanner error={error} />
        </div>
      )}
      <TableScroller>
        <table className="table" data-testid="alerts-table">
          <thead><tr><th>Rule</th><th>Entity</th><th>Severity</th><th>State</th><th>Fired</th><ActionTh /></tr></thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id} data-testid={`alert-${a.id.slice(0, 8)}`}>
                <CellWith title={a.ruleName} sub={a.detail} />
                <td>{a.entity}</td>
                <td><span className={severityPill(a.severity)}><span className="dot" />{a.severity}</span></td>
                <td><span className={statePill(a.state)}><span className="dot" />{a.state}</span></td>
                <td>{new Date(a.firedAt).toLocaleString()}</td>
                <ActionTd>
                  {a.state === "firing" && (
                    <button className="btn sm" onClick={() => void act(() => ackAlert(a.id, "dashboard"))}>Ack</button>
                  )}
                  {a.state !== "resolved" && (
                    <>
                      <button className="btn sm primary" onClick={() => void act(() => resolveAlert(a.id, "resolved from UI"))}>Resolve</button>
                      <button
                        className="btn sm warn"
                        title="Suppress re-fire for 24 h"
                        onClick={() => void act(() => muteAlert(a.id, Date.now() + 24 * 3600_000))}
                      >
                        Mute 24h
                      </button>
                    </>
                  )}
                </ActionTd>
              </tr>
            ))}
            {alerts.length === 0 && <tr><td colSpan={6} className="hint">No alerts — all clear.</td></tr>}
          </tbody>
        </table>
      </TableScroller>
    </>
  );
}

const EMPTY_RULE: AlertRule = {
  id: "",
  name: "",
  severity: "warning",
  enabled: true,
  seed: false,
  condition: { source: "node-metric", path: "gpu.tempC", op: ">=", value: 80, forMs: 300_000 },
};

function RulesTable({ rules, onChanged }: { rules: AlertRule[]; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AlertRule>({ ...EMPTY_RULE });

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    const id = draft.id.trim() || draft.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    await act(() => saveRule({ ...draft, id }));
    setDraft({ ...EMPTY_RULE });
  };

  return (
    <>
      <div className="panel-body stack">
        <FormGrid>
          <Field label="Rule name" required>
            <input placeholder="Rule name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="grow" aria-label="Rule name" />
          </Field>
          <Field label="Condition">
            <FormRow>
              <select value={draft.condition.source} onChange={(e) => setDraft({ ...draft, condition: { ...draft.condition, source: e.target.value as AlertRule["condition"]["source"] } })} aria-label="Source">
                <option value="node-metric">node metric</option>
                <option value="gateway-5xx">gateway 5xx %</option>
                <option value="node-unreachable">node unreachable</option>
              </select>
              {draft.condition.source === "node-metric" && (
                <input placeholder="metric path (gpu.tempC)" value={draft.condition.path ?? ""} onChange={(e) => setDraft({ ...draft, condition: { ...draft.condition, path: e.target.value } })} className="w-md" aria-label="Metric path" />
              )}
              <select value={draft.condition.op} onChange={(e) => setDraft({ ...draft, condition: { ...draft.condition, op: e.target.value as AlertRule["condition"]["op"] } })} aria-label="Operator">
                <option value=">=">≥</option><option value="<=">≤</option><option value=">">&gt;</option><option value="<">&lt;</option>
              </select>
              <input type="number" value={draft.condition.value} onChange={(e) => setDraft({ ...draft, condition: { ...draft.condition, value: Number(e.target.value) } })} className="w-xs" aria-label="Threshold" />
              <input type="number" value={draft.condition.forMs / 60_000} onChange={(e) => setDraft({ ...draft, condition: { ...draft.condition, forMs: Number(e.target.value) * 60_000 } })} className="w-xs" aria-label="Hold minutes" placeholder="min" />
              <select value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value as AlertRule["severity"] })} aria-label="Severity">
                <option value="info">info</option><option value="warning">warning</option><option value="critical">critical</option>
              </select>
              <button className="btn sm primary" disabled={!draft.name.trim()} onClick={() => void save()}>Save rule</button>
            </FormRow>
          </Field>
        </FormGrid>
        <ErrorBanner error={error} />
      </div>
      <TableScroller>
        <table className="table" data-testid="rules-table">
          <thead><tr><th>Rule</th><th>Condition</th><th>Severity</th><th>Enabled</th><ActionTh /></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} data-testid={`rule-${r.id}`}>
                <td><strong>{r.name}</strong>{" "}{r.seed && <span className="chip">seed</span>}</td>
                <td className="hint">
                  {r.condition.source === "node-metric"
                    ? `${r.condition.path} ${r.condition.op} ${r.condition.value} for ${Math.round(r.condition.forMs / 60_000)}m`
                    : r.condition.source === "gateway-5xx"
                      ? `5xx ≥ ${r.condition.value}% for ${Math.round(r.condition.forMs / 60_000)}m`
                      : `unreachable ≥ ${Math.round(r.condition.forMs / 60_000)}m`}
                </td>
                <td><span className={severityPill(r.severity)}><span className="dot" />{r.severity}</span></td>
                <td><span className={`pill ${r.enabled ? "ok" : "info"}`}><span className="dot" />{r.enabled ? "on" : "off"}</span></td>
                <ActionTd>
                  <button className="btn sm" disabled={r.seed} onClick={() => void act(() => saveRule({ ...r, enabled: !r.enabled }))}>
                    {r.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="btn sm ghost" disabled={r.seed} title={r.seed ? "seed rules are read-only" : "Delete"} onClick={() => void act(() => deleteRule(r.id))}>✕</button>
                </ActionTd>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
    </>
  );
}

export function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAlerts((await listAlerts(showAll ? undefined : "open")).alerts);
      setRules((await listRules()).rules);
      setEvents((await listAlertEvents(100)).events);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [showAll]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Alerts</h2>
          <div className="right">
            <Segmented<"active" | "all">
              options={[{ value: "active", label: "Active" }, { value: "all", label: "All" }]}
              value={showAll ? "all" : "active"}
              onChange={(v) => setShowAll(v === "all")}
              ariaLabel="Alert filter"
            />
            <a className="btn sm" href={alertsHistoryCsvUrl} download>Export history</a>
          </div>
        </div>
        {error && (
          <div className="panel-body">
            <ErrorBanner error={error} />
          </div>
        )}
        <AlertsTable alerts={alerts} onChanged={refresh} />
      </section>

      <section className="panel">
        <div className="panel-head"><h3>Rules</h3><span className="pill info"><span className="dot" />{rules.length}</span></div>
        <RulesTable rules={rules} onChanged={refresh} />
      </section>

      <section className="panel">
        <div className="panel-head"><h3>History</h3></div>
        <TableScroller maxHeight={340}>
          <table className="table" data-testid="alert-events">
            <thead><tr><th>time</th><th>kind</th><th>rule</th><th>actor</th><th>note</th></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.ts).toLocaleString()}</td>
                  <td><span className="chip">{e.kind}</span></td>
                  <td>{e.ruleId}</td>
                  <td>{e.actor ?? "—"}</td>
                  <td>{e.note ?? "—"}</td>
                </tr>
              ))}
              {events.length === 0 && <tr><td colSpan={5} className="hint">No alert events yet.</td></tr>}
            </tbody>
          </table>
        </TableScroller>
      </section>
    </>
  );
}
