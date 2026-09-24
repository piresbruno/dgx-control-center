import { useCallback, useEffect, useState } from "react";

interface SeriesRow {
  nodeId: string;
  points: Array<{ t: number; v: number }>;
}

interface FleetSeries {
  domain: string;
  granularity: string;
  hours: number;
  series: SeriesRow[];
}

const DOMAINS: Array<{ id: string; label: string; leaves: Array<{ path: string; label: string }> }> = [
  { id: "gpu", label: "GPU", leaves: [{ path: "gpus.0.tempC", label: "temp °C" }, { path: "gpus.0.utilPct", label: "util %" }, { path: "gpus.0.watts", label: "watts" }, { path: "gpus.0.clockMhz", label: "clock MHz" }] },
  { id: "cpu", label: "CPU", leaves: [{ path: "utilPct", label: "util %" }, { path: "totalGb", label: "total GB" }] },
  { id: "memory", label: "Memory", leaves: [{ path: "usedPct", label: "used %" }] },
  { id: "storage", label: "Storage", leaves: [{ path: "usedPct", label: "used %" }] },
  { id: "network", label: "Network", leaves: [{ path: "rxKbps", label: "rx kbps" }, { path: "txKbps", label: "tx kbps" }] },
];

const RANGES = [
  { hours: 1, label: "1 h" },
  { hours: 6, label: "6 h" },
  { hours: 24, label: "24 h" },
  { hours: 168, label: "7 d" },
  { hours: 720, label: "30 d" },
];

function Chart({ series, color }: { series: SeriesRow; color: string }) {
  const pts = series.points;
  if (pts.length < 2) return <div className="spark" />;
  const values = pts.map((p) => p.v);
  const max = Math.max(...values) * 1.1 || 1;
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const w = 480;
  const h = 60;
  const dx = w / Math.max(pts.length - 1, 1);
  const d = pts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(i * dx).toFixed(1)} ${(h - ((p.v - min) / span) * (h - 4) - 2).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: 60 }}>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const COLORS = ["var(--series-1, #4c7ef3)", "var(--series-2, #22b07d)", "var(--series-3, #e0954a)", "var(--crit)"];

export function FleetExplorerPage() {
  const [domainId, setDomainId] = useState("gpu");
  const [leaf, setLeaf] = useState("gpus.0.tempC");
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<FleetSeries | null>(null);
  const [error, setError] = useState<string | null>(null);

  const domain = DOMAINS.find((d) => d.id === domainId)!;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/metrics/fleet?domain=${domainId}&leaf=${encodeURIComponent(leaf)}&hours=${hours}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setData((await res.json()) as FleetSeries);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [domainId, leaf, hours]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const pickDomain = (id: string) => {
    const d = DOMAINS.find((x) => x.id === id)!;
    setDomainId(id);
    setLeaf(d.leaves[0]!.path);
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Fleet explorer</h2>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {DOMAINS.map((d) => (
              <button key={d.id} className={`btn sm ${domainId === d.id ? "primary" : ""}`} onClick={() => pickDomain(d.id)}>{d.label}</button>
            ))}
          </div>
        </div>
        <div className="panel-body" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {domain.leaves.length > 1 && (
            <select value={leaf} onChange={(e) => setLeaf(e.target.value)} aria-label="Metric">
              {domain.leaves.map((l) => (
                <option key={l.path} value={l.path}>{l.label}</option>
              ))}
            </select>
          )}
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Range">
            {RANGES.map((r) => (
              <option key={r.hours} value={r.hours}>{r.label}</option>
            ))}
          </select>
          <span className="hint">granularity: {data?.granularity ?? "…"}</span>
        </div>
        {error && <div className="panel-body" style={{ color: "var(--crit)" }}>{error}</div>}
      </section>

      <section className="panel">
        <div className="panel-head"><h3>{domain.label} — {domain.leaves.find((l) => l.path === leaf)?.label ?? leaf}</h3></div>
        <div className="panel-body" style={{ display: "grid", gap: 14 }}>
          {(data?.series ?? []).map((s, i) => {
            const last = s.points[s.points.length - 1]?.v;
            return (
              <div key={s.nodeId} data-testid={`fleet-chart-${s.nodeId}`}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>{s.nodeId}</strong>
                  <span className="hint">last: {last != null ? last.toFixed(1) : "—"}</span>
                </div>
                <Chart series={s} color={COLORS[i % COLORS.length]!} />
              </div>
            );
          })}
          {data && data.series.length === 0 && (
            <div className="empty">No samples in this window for {domain.label}.</div>
          )}
        </div>
      </section>
    </>
  );
}
