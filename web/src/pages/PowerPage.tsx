import { useCallback, useEffect, useState } from "react";
import {
  getClocks,
  getEnergy,
  getProfiles,
  getSchedules,
  getThermal,
  setProfile,
  type ClockProfile,
  type ClockStatusRow,
  type EnergySummary,
  type ScheduleRow,
  type ThermalStatus,
} from "../api/power.js";

function kwh(n: number): string {
  return n >= 1 ? `${n.toFixed(2)} kWh` : `${(n * 1000).toFixed(0)} Wh`;
}

/** Node Power card body: profile selector + thermal state (embedded in NodePage). */
export function PowerCard({ sparkId }: { sparkId: string }) {
  const [profiles, setProfiles] = useState<ClockProfile[]>([]);
  const [clocks, setClocks] = useState<ClockStatusRow[]>([]);
  const [thermal, setThermal] = useState<ThermalStatus | null>(null);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setClocks((await getClocks()).clocks);
      setThermal(await getThermal());
      setSchedules((await getSchedules()).schedules);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void getProfiles().then((d) => setProfiles(d.profiles)).catch(() => undefined);
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const mine = clocks.find((c) => c.sparkId === sparkId);
  const thermalState = thermal?.nodes.find((n) => n.sparkId === sparkId)?.state ?? "nominal";
  const schedule = schedules.find((s) => s.sparkId === sparkId);

  const apply = async (profileId: string) => {
    setBusy(true);
    setError(null);
    try {
      await setProfile(sparkId, profileId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {profiles.map((p) => (
          <button
            key={p.id}
            className={`btn sm ${mine?.desired === p.id ? "primary" : ""}`}
            disabled={busy}
            title={p.description}
            onClick={() => void apply(p.id)}
          >
            {p.name}
            {p.gpuMaxMhz != null ? ` · GPU≤${p.gpuMaxMhz}` : ""}
            {p.cpuMaxMhz != null ? ` · CPU≤${(p.cpuMaxMhz / 1000).toFixed(1)}GHz` : ""}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span className={`pill ${thermalState === "nominal" ? "ok" : "crit"}`}>
          <span className="dot" />thermal: {thermalState}
        </span>
        {schedule && <span className="pill info"><span className="dot" />schedule · {schedule.tz}</span>}
        {mine?.resolved?.clamped && <span className="pill warn"><span className="dot" />hw-clamped</span>}
      </div>
      {error && <div style={{ color: "var(--crit)" }}>{error}</div>}
    </div>
  );
}

/** Energy view: rollups per node, cost, client-side CSV export. */
export function EnergyPage() {
  const [summary, setSummary] = useState<EnergySummary | null>(null);
  const [windowHours, setWindowHours] = useState(168);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSummary(await getEnergy(windowHours));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [windowHours]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const exportCsv = () => {
    if (!summary) return;
    const lines = ["bucket,nodeId,kwh,cost,minutes"];
    for (const h of summary.hourly) lines.push(`${new Date(h.bucket).toISOString()},${h.nodeId},${h.kwh},${h.cost},${h.minutes}`);
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "energy.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const byNode = new Map<string, number>();
  for (const h of summary?.hourly ?? []) byNode.set(h.nodeId, (byNode.get(h.nodeId) ?? 0) + h.kwh);

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Energy</h2>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select value={windowHours} onChange={(e) => setWindowHours(Number(e.target.value))} aria-label="Window">
              <option value={24}>24 h</option>
              <option value={168}>7 d</option>
              <option value={720}>30 d</option>
            </select>
            <button className="btn sm" onClick={exportCsv}>Export CSV</button>
          </div>
        </div>
        <div className="panel-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          <div className="panel kpi">
            <div className="label">total energy</div>
            <div className="value">{summary ? kwh(summary.totalKwh) : "—"}</div>
          </div>
          <div className="panel kpi">
            <div className="label">total cost</div>
            <div className="value">{summary ? summary.totalCost.toFixed(2) : "—"}</div>
          </div>
        </div>
        {error && <div className="panel-body" style={{ color: "var(--crit)" }}>{error}</div>}
      </section>

      <section className="panel">
        <div className="panel-head"><h3>Per node</h3></div>
        <div className="panel-body flush">
          <table className="table" data-testid="energy-nodes">
            <thead><tr><th>Node</th><th>kWh (window)</th><th>Cost</th></tr></thead>
            <tbody>
              {[...byNode.entries()].map(([nodeId, k]) => (
                <tr key={nodeId}>
                  <td>{nodeId}</td>
                  <td>{kwh(k)}</td>
                  <td>{summary ? ((k / (summary.totalKwh || 1)) * (summary.totalCost || 0)).toFixed(2) : "—"}</td>
                </tr>
              ))}
              {summary && byNode.size === 0 && <tr><td colSpan={3} className="hint">No power samples in this window.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h3>Hourly rollup</h3></div>
        <div className="panel-body flush" style={{ overflowX: "auto", maxHeight: 380 }}>
          <table className="table" data-testid="energy-hourly">
            <thead><tr><th>hour (UTC)</th><th>node</th><th>kWh</th><th>cost</th><th>minutes</th></tr></thead>
            <tbody>
              {(summary?.hourly ?? []).slice(-72).reverse().map((h) => (
                <tr key={`${h.nodeId}-${h.bucket}`}>
                  <td>{new Date(h.bucket).toISOString().slice(5, 13).replace("T", " ")}:00</td>
                  <td>{h.nodeId}</td>
                  <td>{h.kwh.toFixed(3)}</td>
                  <td>{h.cost.toFixed(3)}</td>
                  <td>{h.minutes}</td>
                </tr>
              ))}
              {summary && summary.hourly.length === 0 && <tr><td colSpan={5} className="hint">No samples.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
