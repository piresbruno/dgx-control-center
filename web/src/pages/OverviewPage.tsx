import { useEffect, useState } from "react";
import type { LiveNode } from "../api/ws.js";
import { nodeSummary, statusPill } from "../App.js";
import { Kpi } from "../ui/index.js";
import { listDeployments, type DeploymentRecord } from "../api/serving.js";
import { getSummary, type AnalysisSummary } from "../api/analysis.js";

export interface OverviewProps {
  nodes: LiveNode[];
  history: Record<string, Record<string, number[]>>;
  connected: boolean;
  onSelectNode(id: string): void;
}


export function OverviewPage({ nodes, history, connected, onSelectNode }: OverviewProps) {
  const online = nodes.filter((n) => n.state !== "offline" && n.state !== "provisioning");
  const totalWatts = nodes.reduce((sum, n) => {
    const power = n.domains["power"];
    const watts = typeof power === "object" && power !== null ? (power as Record<string, unknown>)["watts"] : undefined;
    return sum + (typeof watts === "number" ? watts : 0);
  }, 0);

  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [summary, setSummary] = useState<AnalysisSummary | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const d = await listDeployments();
        if (alive) setDeployments(d.deployments ?? []);
      } catch {
        // Overview tolerates partial data.
      }
      try {
        const s = await getSummary(24);
        if (alive) setSummary(s);
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
          <div className="sub">{`${nodes.length} node${nodes.length === 1 ? "" : "s"} · live metrics via WebSocket`}</div>
        </div>
      </div>

      <div className="grid cols-4">
        <Kpi
          label="Nodes online"
          value={online.length}
          unit={` / ${nodes.length || "…"}`}
          delta={connected ? "live feed" : "reconnecting…"}
        />
        <Kpi
          testId="kpi-serving"
          label="Models serving"
          value={serving}
          unit={` / ${deployments.length || "…"}`}
          delta={deployments.length > 0 ? "desired running / registered" : "no deployments yet"}
        />
        <Kpi
          testId="kpi-requests"
          label="Requests (24 h)"
          value={summary ? summary.kpis.requests : "—"}
          delta={summary ? `${summary.kpis.errors} errors` : "no gateway traffic yet"}
        />
        <Kpi
          label="Power now"
          value={totalWatts > 0 ? totalWatts : "—"}
          unit="W"
          delta="fleet total where reported"
        />
      </div>

      <div className="grid cols-3">
        {nodes.length === 0 && (
          <div className="panel col-span-all">
            <div className="panel-body"><div className="empty">No nodes connected yet — register one under Settings → Nodes, then install its agent.</div></div>
          </div>
        )}
        {nodes.map((node) => (
          <div className="panel node-card clickable" key={node.sparkId} onClick={() => onSelectNode(node.sparkId)} data-testid={`node-${node.sparkId}`}>
            <div className="head">
              <div className="node-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <path d="M9 9h6v6H9z" />
                </svg>
              </div>
              <div className="grow">
                <div className="name">{node.name} <span className="faint tiny">· {node.role}</span></div>
                <div className="meta">{node.kind}</div>
              </div>
              {statusPill(node.state)}
            </div>
            <Gauge label="GPU" value={numOf(node, "gpu", "utilPct")} suffix="%" color="var(--series-1)" />
            <Gauge label="CPU" value={numOf(node, "cpu", "loadPct")} suffix="%" color="var(--series-2)" />
            <Gauge label="MEM" value={numOf(node, "memory", "usedPct")} suffix="%" color="var(--series-3)" />
            <div className="row between card-foot">
              <span className="tiny num dim">{nodeSummary(node)}</span>
              <span className="tiny faint mono">{node.sparkId}</span>
            </div>
            <Spark history={history[node.sparkId]} />
          </div>
        ))}
      </div>

      <div className="note">◈ Live over WS — cards update in place.</div>
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
