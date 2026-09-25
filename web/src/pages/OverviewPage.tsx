import { useEffect, useState } from "react";
import type { LiveNode } from "../api/ws.js";
import { nodeSummary, statusPill } from "../App.js";

export interface OverviewProps {
  nodes: LiveNode[];
  history: Record<string, Record<string, number[]>>;
  connected: boolean;
  onSelectNode(id: string): void;
}

interface DeploymentRow {
  desired: string;
}

interface AnalysisSummary {
  kpis: { requests: number; errors: number };
}

export function OverviewPage({ nodes, history, connected, onSelectNode }: OverviewProps) {
  const online = nodes.filter((n) => n.state !== "offline" && n.state !== "provisioning");
  const totalWatts = nodes.reduce((sum, n) => {
    const power = n.domains["power"];
    const watts = typeof power === "object" && power !== null ? (power as Record<string, unknown>)["watts"] : undefined;
    return sum + (typeof watts === "number" ? watts : 0);
  }, 0);

  const [deployments, setDeployments] = useState<DeploymentRow[]>([]);
  const [summary, setSummary] = useState<AnalysisSummary | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const d = await fetch("/api/serve/deployments").then((r) => (r.ok ? r.json() : null));
        if (alive && d) setDeployments(Array.isArray(d) ? d : (d.deployments ?? []));
      } catch {
        // Overview tolerates partial data.
      }
      try {
        const s = await fetch("/api/analysis/summary?windowHours=24").then((r) => (r.ok ? r.json() : null));
        if (alive && s) setSummary(s as AnalysisSummary);
      } catch {
        // Ditto.
      }
    };
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const serving = deployments.filter((d) => d.desired === "running").length;

  return (
    <>
      <div className="page-head">
        <div className="page-title">
          <h1>Fleet overview</h1>
          <div className="sub">2× DGX Spark (GB10) · QNAP NAS store · gateway on http://cc.home.local/v1</div>
        </div>
      </div>

      <div className="grid cols-4">
        <div className="panel kpi">
          <div className="label">Nodes online</div>
          <div className="value">{online.length}<small> / {nodes.length || "…"}</small></div>
          <div className="delta">{connected ? "live feed" : "reconnecting…"}</div>
        </div>
        <div className="panel kpi" data-testid="kpi-serving">
          <div className="label">Models serving</div>
          <div className="value">{serving}<small> / {deployments.length || "…"}</small></div>
          <div className="delta dim">{deployments.length > 0 ? "desired running / registered" : "no deployments yet"}</div>
        </div>
        <div className="panel kpi" data-testid="kpi-requests">
          <div className="label">Requests (24 h)</div>
          <div className="value">{summary ? summary.kpis.requests : "—"}</div>
          <div className="delta dim">{summary ? `${summary.kpis.errors} errors` : "no gateway traffic yet"}</div>
        </div>
        <div className="panel kpi">
          <div className="label">Power now</div>
          <div className="value">{totalWatts > 0 ? totalWatts : "—"}<small>W</small></div>
          <div className="delta dim">fleet total where reported</div>
        </div>
      </div>

      <div className="grid cols-3" style={{ marginTop: 18 }}>
        {nodes.length === 0 && (
          <div className="panel" style={{ gridColumn: "1 / -1" }}>
            <div className="panel-body"><div className="empty">No nodes connected yet — register one under Settings → Nodes, then install its agent.</div></div>
          </div>
        )}
        {nodes.map((node) => (
          <div className="panel node-card" key={node.sparkId} style={{ cursor: "pointer" }} onClick={() => onSelectNode(node.sparkId)} data-testid={`node-${node.sparkId}`}>
            <div className="head">
              <div className="node-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <path d="M9 9h6v6H9z" />
                </svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="name">{node.name} <span className="faint tiny">· {node.role}</span></div>
                <div className="meta">{node.kind}</div>
              </div>
              {statusPill(node.state)}
            </div>
            <Gauge label="GPU" value={numOf(node, "gpu", "utilPct")} suffix="%" color="var(--series-1)" />
            <Gauge label="CPU" value={numOf(node, "cpu", "loadPct")} suffix="%" color="var(--series-2)" />
            <Gauge label="MEM" value={numOf(node, "memory", "usedPct")} suffix="%" color="var(--series-3)" />
            <div className="row between" style={{ borderTop: "1px solid var(--hairline)", paddingTop: 10 }}>
              <span className="tiny num dim">{nodeSummary(node)}</span>
              <span className="tiny faint mono">{node.sparkId}</span>
            </div>
            <Spark history={history[node.sparkId]} />
          </div>
        ))}
      </div>

      <div className="note">◈ Live over WS — cards update in place; charts arrive with the query API (M1+).</div>
    </>
  );
}

function numOf(node: LiveNode, domain: string, leaf: string): number | null {
  const d = node.domains[domain] as Record<string, unknown> | undefined;
  const v = d?.[leaf];
  return typeof v === "number" ? v : null;
}

function Gauge({ label, value, suffix, color }: { label: string; value: number | null; suffix: string; color: string }) {
  const pct = value === null ? 0 : Math.min(100, value);
  return (
    <div className="gauge-row">
      <span>{label}</span>
      <div className="meter"><i style={{ width: `${pct}%`, background: color }} /></div>
      <span className="v">{value === null ? "—" : `${value}${suffix}`}</span>
    </div>
  );
}

function Spark({ history }: { history: Record<string, number[]> | undefined }) {
  const series = history?.["gpu"] ?? history?.["cpu"] ?? [];
  if (series.length < 2) return <div className="spark" />;
  const max = Math.max(...series) * 1.1 || 1;
  const w = 240;
  const h = 28;
  const dx = w / Math.max(series.length - 1, 1);
  const d = series.map((v, i) => `${i === 0 ? "M" : "L"} ${(i * dx).toFixed(1)} ${(h - ((v / max) * (h - 2) + 1)).toFixed(1)}`).join(" ");
  return (
    <div className="spark">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <path d={d} fill="none" stroke="var(--series-1)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
