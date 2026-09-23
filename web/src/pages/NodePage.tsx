import type { LiveNode } from "../api/ws.js";
import { nodeSummary, statusPill } from "../App.js";

export interface NodePageProps {
  node: LiveNode | null;
  nodes: LiveNode[];
  history: Record<string, Record<string, number[]>>;
  onSelectNode(id: string): void;
}

export function NodePage({ node, nodes, history, onSelectNode }: NodePageProps) {
  if (!node) {
    return (
      <>
        <div className="page-head"><div className="page-title"><h1>Nodes</h1></div></div>
        <div className="panel"><div className="panel-body"><div className="empty">Select a node on the Overview page.</div></div></div>
        <div className="grid cols-3" style={{ marginTop: 18 }}>
          {nodes.map((n) => (
            <button key={n.sparkId} className="panel node-card" style={{ cursor: "pointer" }} onClick={() => onSelectNode(n.sparkId)}>
              <div className="head"><div className="name">{n.name}</div>{statusPill(n.state)}</div>
            </button>
          ))}
        </div>
      </>
    );
  }

  const gpu = node.domains["gpu"] as Record<string, number> | undefined;
  const cpu = node.domains["cpu"] as Record<string, number> | undefined;
  const memory = node.domains["memory"] as Record<string, number> | undefined;
  const storage = node.domains["storage"] as Record<string, number> | undefined;
  const power = node.domains["power"] as Record<string, number> | undefined;

  return (
    <>
      <div className="page-head">
        <div className="page-title">
          <h1>
            {node.name} {statusPill(node.state)}
          </h1>
          <div className="sub">{node.kind} · {node.role} · last metrics {node.lastMetricsTs ? new Date(node.lastMetricsTs).toLocaleTimeString() : "—"}</div>
        </div>
      </div>

      <div className="grid cols-4">
        <Kpi label="GPU util" value={pctOr(gpu?.["utilPct"])} delta={tempOr(gpu?.["tempC"])} />
        <Kpi label="Memory" value={pctOr(memory?.["usedPct"])} delta={gbOr(memory?.["usedGb"], memory?.["totalGb"])} />
        <Kpi label="CPU" value={pctOr(cpu?.["loadPct"])} delta={`${coresOr(cpu)} cores`} />
        <Kpi label="Power" value={wattsOr(power?.["watts"])} delta={storage ? `${storage["freeGb"]} GB free` : "—"} />
      </div>

      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <Panel title="GPU">
          <GaugeRow label="util" value={pctOr(gpu?.["utilPct"])} />
          <GaugeRow label="mem" value={mbPctOr(gpu?.["memUsedMb"], gpu?.["memTotalMb"])} />
          <GaugeRow label="clock" value={mhzOr(gpu?.["clockMhz"])} />
        </Panel>
        <Panel title="Disk & power">
          <GaugeRow label="disk" value={pctOr(storage?.["usedPct"])} />
          <GaugeRow label="watts" value={wattsOr(power?.["watts"])} />
          <div className="empty">Clock profiles land at M5.</div>
        </Panel>
      </div>

      <div className="note">◈ Live values from the agent snapshot feed; history charts attach to the SQLite query API (M1+).</div>
    </>
  );
}

function Kpi({ label, value, delta }: { label: string; value: string; delta: string }) {
  return (
    <div className="panel kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="delta">{delta}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel">
      <div className="panel-head"><h3>{title}</h3></div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

function GaugeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between" style={{ padding: "6px 0", borderBottom: "1px solid var(--hairline)" }}>
      <span className="tiny dim">{label}</span>
      <span className="tiny num strong">{value}</span>
    </div>
  );
}

function pctOr(v: number | undefined): string {
  return typeof v === "number" ? `${v} %` : "—";
}
function mhzOr(v: number | undefined): string {
  return typeof v === "number" ? `${v} MHz` : "—";
}
function wattsOr(v: number | undefined): string {
  return typeof v === "number" ? `${v} W` : "—";
}
function tempOr(v: number | undefined): string {
  return typeof v === "number" ? `${v} °C` : "—";
}
function coresOr(v: Record<string, number> | undefined): string {
  return typeof v?.["coreCount"] === "number" ? String(v["coreCount"]) : "—";
}
function gbOr(used: number | undefined, total: number | undefined): string {
  return typeof used === "number" && typeof total === "number" ? `${used} / ${total} GB` : "—";
}
function mbPctOr(used: number | undefined, total: number | undefined): string {
  return typeof used === "number" && typeof total === "number" && total > 0
    ? `${Math.round((used / total) * 100)} % (${used} MB)`
    : "—";
}
