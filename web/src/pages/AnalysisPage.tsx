import { useCallback, useEffect, useState } from "react";
import { getSummary, getTraces, type AnalysisSummary, type TraceRow } from "../api/analysis.js";

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="delta">{hint}</div>}
    </div>
  );
}

function statusPill(status: number | null) {
  if (status == null) return <span className="pill crit"><span className="dot" />err</span>;
  const cls = status < 300 ? "ok" : status < 500 ? "warn" : "crit";
  return <span className={`pill ${cls}`}><span className="dot" />{status}</span>;
}

function copyCurl(t: TraceRow): string {
  const body = JSON.stringify({ model: t.alias, messages: [{ role: "user", content: "hello" }] });
  return `curl -X POST http://<dashboard>:5566/v1/chat/completions \\\n  -H "authorization: Bearer $CC_KEY" \\\n  -H "content-type: application/json" \\\n  -d '${body}'`;
}

/** Inspector drawer (tabs: overview, attempts, curl). */
function Inspector({ trace, onClose }: { trace: TraceRow; onClose: () => void }) {
  const [tab, setTab] = useState<"overview" | "attempts" | "curl">("overview");
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel" data-testid="inspector">
      <div className="panel-head">
        <h3>Inspector — {trace.alias} @ {new Date(trace.ts).toLocaleTimeString()}</h3>
        <div style={{ display: "flex", gap: 6 }}>
          {(["overview", "attempts", "curl"] as const).map((x) => (
            <button key={x} className={`btn sm ${tab === x ? "primary" : ""}`} onClick={() => setTab(x)}>{x}</button>
          ))}
          <button className="btn sm ghost" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="panel-body">
        {tab === "overview" && (
          <table className="table">
            <tbody>
              <tr><td>client</td><td>{trace.client ?? "—"}</td></tr>
              <tr><td>alias</td><td>{trace.alias}</td></tr>
              <tr><td>served by</td><td>{trace.nodeId}:{trace.port ?? "—"}</td></tr>
              <tr><td>status</td><td>{trace.status ?? "—"}</td></tr>
              <tr><td>TTFT</td><td>{trace.ttftMs != null ? `${trace.ttftMs} ms` : "—"}</td></tr>
              <tr><td>duration</td><td>{trace.durationMs} ms</td></tr>
              <tr><td>stream</td><td>{trace.stream ? "yes" : "no"}</td></tr>
              <tr><td>tokens (prompt/completion)</td><td>{trace.promptTokens ?? "—"} / {trace.completionTokens ?? "—"}</td></tr>
              {trace.stream && <tr><td>ITL samples</td><td>{trace.itl.length ? `${trace.itl.length} (min ${Math.min(...trace.itl)} · max ${Math.max(...trace.itl)} ms)` : "—"}</td></tr>}
              {trace.error && <tr><td>error</td><td style={{ color: "var(--crit)" }}>{trace.error}</td></tr>}
            </tbody>
          </table>
        )}
        {tab === "attempts" && (
          <table className="table">
            <thead><tr><th>#</th><th>node</th><th>port</th><th>status</th><th>error</th></tr></thead>
            <tbody>
              {trace.attempts.map((a, i) => (
                <tr key={i}>
                  <td>{i + 1}</td><td>{a.nodeId}</td><td>{a.port}</td>
                  <td>{a.status ?? "—"}</td><td>{a.error ?? ""}</td>
                </tr>
              ))}
              {trace.attempts.length === 0 && <tr><td colSpan={5} className="hint">no upstream attempts (rejected before routing)</td></tr>}
            </tbody>
          </table>
        )}
        {tab === "curl" && (
          <div>
            <button
              className="btn sm primary"
              data-testid="copy-curl"
              onClick={async () => {
                await navigator.clipboard?.writeText(copyCurl(trace)).catch(() => undefined);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy as curl"}
            </button>
            <pre style={{ background: "var(--bg-2, #11151c)", padding: 10, borderRadius: 8, fontSize: 11.5, overflow: "auto" }}>
              {copyCurl(trace)}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
}

export function AnalysisPage() {
  const [summary, setSummary] = useState<AnalysisSummary | null>(null);
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [windowHours, setWindowHours] = useState(24);
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState<TraceRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSummary(await getSummary(windowHours));
      setTraces((await getTraces(100)).traces);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [windowHours]);

  useEffect(() => {
    void refresh();
    if (!follow) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh, follow]);

  const maxHour = Math.max(1, ...(summary?.byHour ?? []).map((h) => h.requests));

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Gateway analysis</h2>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select value={windowHours} onChange={(e) => setWindowHours(Number(e.target.value))} aria-label="Window">
              <option value={1}>1 h</option>
              <option value={6}>6 h</option>
              <option value={24}>24 h</option>
              <option value={168}>7 d</option>
            </select>
            <button className={`btn sm ${follow ? "primary" : ""}`} onClick={() => setFollow(!follow)}>
              {follow ? "Following" : "Paused"}
            </button>
            <a className="btn sm" href={`/api/analysis/export.csv`} download>Export CSV</a>
          </div>
        </div>
        <div className="panel-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
          <Kpi label="requests" value={String(summary?.kpis.requests ?? "—")} hint={`${summary?.kpis.errors ?? 0} errors`} />
          <Kpi label="error rate" value={summary ? `${Math.round(summary.kpis.errorRate * 100)} %` : "—"} />
          <Kpi label="TTFT p50" value={summary?.kpis.ttftP50Ms != null ? `${summary.kpis.ttftP50Ms} ms` : "—"} />
          <Kpi label="TTFT p95" value={summary?.kpis.ttftP95Ms != null ? `${summary.kpis.ttftP95Ms} ms` : "—"} />
          <Kpi label="tokens" value={summary ? `${summary.kpis.promptTokens} / ${summary.kpis.completionTokens}` : "—"} hint="prompt / completion" />
        </div>
        {error && <div className="panel-body" style={{ color: "var(--crit)" }}>{error}</div>}
      </section>

      {selected && <Inspector trace={selected} onClose={() => setSelected(null)} />}

      <section className="panel">
        <div className="panel-head"><h3>Requests / hour</h3></div>
        <div className="panel-body flush">
          <table className="table" data-testid="hourly-table">
            <thead><tr><th>hour (UTC)</th><th>requests</th><th>errors</th><th>tokens</th><th style={{ width: "40%" }} /></tr></thead>
            <tbody>
              {(summary?.byHour ?? []).slice(-24).map((h) => (
                <tr key={h.bucket}>
                  <td>{new Date(h.bucket).toISOString().slice(5, 13).replace("T", " ")}:00</td>
                  <td>{h.requests}</td>
                  <td style={h.errors > 0 ? { color: "var(--crit)" } : undefined}>{h.errors}</td>
                  <td>{h.tokens}</td>
                  <td>
                    <div style={{ background: "var(--accent, #4c7ef3)", height: 8, borderRadius: 4, width: `${(h.requests / maxHour) * 100}%` }} />
                  </td>
                </tr>
              ))}
              {summary && summary.byHour.length === 0 && <tr><td colSpan={5} className="hint">No traffic in this window.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Request traces</h3>
          <span className="pill info"><span className="dot" />{traces.length}</span>
        </div>
        <div className="panel-body flush" style={{ overflowX: "auto" }}>
          <table className="table" data-testid="traces-table">
            <thead>
              <tr><th>time</th><th>client</th><th>model</th><th>served by</th><th>status</th><th>TTFT</th><th>dur</th><th>tokens</th></tr>
            </thead>
            <tbody>
              {traces.map((t) => (
                <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => setSelected(t)} data-testid={`trace-${t.id.slice(0, 8)}`}>
                  <td>{new Date(t.ts).toLocaleTimeString()}</td>
                  <td>{t.client ?? "—"}</td>
                  <td>{t.alias}</td>
                  <td>{t.nodeId ? `${t.nodeId}:${t.port}` : "—"}</td>
                  <td>{statusPill(t.status)}</td>
                  <td>{t.ttftMs != null ? `${t.ttftMs} ms` : "—"}</td>
                  <td>{t.durationMs} ms</td>
                  <td>{t.promptTokens ?? "—"}/{t.completionTokens ?? "—"}</td>
                </tr>
              ))}
              {traces.length === 0 && <tr><td colSpan={8} className="hint">No requests yet — hit the gateway at /v1/chat/completions.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
