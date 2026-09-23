import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelJob,
  checkModelctl,
  dispatchJob,
  getJob,
  getNodeModels,
  getNasModels,
  humanBytes,
  listJobs,
  provisionModelctl,
  type CheckOutcome,
  type InventorySnapshot,
  type JobRecord,
  type ModelRow,
} from "../api/models.js";

type Tab = "catalog" | "presence" | "downloads";

interface NodeInfo {
  id: string;
  name: string;
  kind: string;
  lanIp: string | null;
  sshUser: string | null;
}

const POLL_MS = 2_000;

export function ModelsPage() {
  const [tab, setTab] = useState<Tab>("catalog");
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [nas, setNas] = useState<InventorySnapshot | null>(null);
  const [selected, setSelected] = useState<ModelRow | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    void fetch("/api/nodes")
      .then((r) => r.json())
      .then((d: { nodes: NodeInfo[] }) => setNodes(d.nodes.filter((n) => n.kind !== "nas")));
    void getNasModels().then(setNas).catch(() => setNas(null));
  }, []);

  const catalog = (nas?.models ?? []).filter(
    (m) =>
      !search ||
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.repository.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="page" data-testid="models-page">
      <header className="page-head">
        <div>
          <h2>Models</h2>
          <p className="sub">
            NAS store{nas ? ` · ${nas.models.length} active` : ""} — inventory, placement, transfers
            {nas?.stale ? " (stale)" : ""}
          </p>
        </div>
        <div className="right">
          {(["catalog", "presence", "downloads"] as const).map((t) => (
            <button key={t} className={`btn ${tab === t ? "primary" : ""}`} onClick={() => setTab(t)}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </header>

      <DoctorRow nodes={nodes} />

      {tab === "catalog" && (
        <CatalogTab catalog={catalog} error={nas?.error ?? null} search={search} setSearch={setSearch} selected={selected} setSelected={setSelected} nodes={nodes} />
      )}
      {tab === "presence" && <PresenceTab nodes={nodes} catalog={nas?.models ?? []} />}
      {tab === "downloads" && <DownloadsTab nodes={nodes} />}
    </div>
  );
}

function DoctorRow({ nodes }: { nodes: NodeInfo[] }) {
  const [checks, setChecks] = useState<Record<string, CheckOutcome | "loading">>({});
  const [provisioning, setProvisioning] = useState<string | null>(null);

  useEffect(() => {
    for (const node of nodes) {
      if (checks[node.id] === undefined) {
        setChecks((prev) => ({ ...prev, [node.id]: "loading" }));
        void checkModelctl(node.id)
          .then((outcome) => setChecks((prev) => ({ ...prev, [node.id]: outcome })))
          .catch((err) => setChecks((prev) => ({ ...prev, [node.id]: { ok: false, mode: "failed", version: null, reason: String(err) } })));
      }
    }
  }, [nodes, checks]);

  const provision = async (id: string) => {
    setProvisioning(id);
    try {
      const outcome = await provisionModelctl(id);
      setChecks((prev) => ({ ...prev, [id]: outcome }));
    } finally {
      setProvisioning(null);
    }
  };

  return (
    <div className="doctor-row" style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0 16px" }}>
      {nodes.map((node) => {
        const check = checks[node.id];
        return (
          <span key={node.id} className={`pill ${check?.ok ? "ok" : check === "loading" ? "info" : "crit"}`} data-testid={`doctor-${node.id}`}>
            <span className="dot" />
            {node.name}: {check === "loading" ? "checking…" : check?.ok ? `modelctl ${check.version ?? ""}` : (check?.reason ?? "unreachable")}
            {!check?.ok && check !== "loading" && (
              <button className="btn" style={{ marginLeft: 8 }} disabled={provisioning === node.id} onClick={() => void provision(node.id)}>
                {provisioning === node.id ? "installing…" : "Install"}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

function CatalogTab(props: {
  catalog: ModelRow[];
  error: string | null;
  search: string;
  setSearch: (s: string) => void;
  selected: ModelRow | null;
  setSelected: (m: ModelRow | null) => void;
  nodes: NodeInfo[];
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)", gap: 16 }}>
      <section className="panel">
        <div className="panel-head">
          <h3>Catalog</h3>
          <span className="sub">{props.catalog.length} models</span>
          <div className="right">
            <input placeholder="Filter…" value={props.search} onChange={(e) => props.setSearch(e.target.value)} />
          </div>
        </div>
        <div className="panel-body flush">
          {props.error ? (
            <div style={{ padding: 18, color: "var(--crit)" }}>{props.error}</div>
          ) : (
            <table className="table" data-testid="catalog-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Runtime</th>
                  <th>Repository</th>
                  <th style={{ textAlign: "right" }}>Size</th>
                </tr>
              </thead>
              <tbody>
                {props.catalog.map((m) => (
                  <tr
                    key={m.name}
                    onClick={() => props.setSelected(m)}
                    style={{ cursor: "pointer", background: props.selected?.name === m.name ? "var(--raised)" : undefined }}
                    data-testid={`catalog-${m.name}`}
                  >
                    <td>{m.name}</td>
                    <td>{m.runtime ?? "—"}</td>
                    <td style={{ color: "var(--text-3)" }}>{m.repository}</td>
                    <td style={{ textAlign: "right" }}>{humanBytes(m.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Detail</h3>
        </div>
        <div className="panel-body">
          {props.selected ? (
            <>
              <strong style={{ fontSize: 14 }}>{props.selected.name}</strong>
              <dl style={{ marginTop: 10, display: "grid", gap: 6, fontSize: 12.5 }}>
                <div>Repository: {props.selected.repository}</div>
                <div>Runtime: {props.selected.runtime ?? "unknown"}</div>
                <div>Size: {humanBytes(props.selected.bytes)}</div>
              </dl>
            </>
          ) : (
            <span style={{ color: "var(--text-3)" }}>Select a model from the catalog.</span>
          )}
        </div>
      </section>
    </div>
  );
}

function PresenceTab({ nodes, catalog }: { nodes: NodeInfo[]; catalog: ModelRow[] }) {
  const [presence, setPresence] = useState<Record<string, Set<string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const entries = await Promise.all(
      nodes.map(async (n) => {
        try {
          const snap = await getNodeModels(n.id);
          return [n.id, new Set(snap.models.map((m) => m.name))] as const;
        } catch {
          return [n.id, new Set<string>()] as const;
        }
      }),
    );
    setPresence(Object.fromEntries(entries));
  }, [nodes]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (nodeId: string, kind: string, params: Record<string, string>, label: string) => {
    setBusy(`${nodeId}:${label}`);
    try {
      await dispatchJob(nodeId, kind, params);
      setMessage(`${label} dispatched to ${nodeId}`);
      setTimeout(() => void refresh(), 3_000);
    } catch (err) {
      setMessage(`${label} failed: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  // Show the intersection that matters: NAS models (syncable) plus anything a node has locally.
  const names = [...new Set([...catalog.map((m) => m.name), ...Object.values(presence).flatMap((s) => [...s])])].sort();
  const lanIpOf = (id: string) => nodes.find((n) => n.id === id)?.lanIp ?? null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Node presence matrix</h3>
        <span className="sub">{names.length} models × {nodes.length} nodes</span>
        <div className="right">
          <button className="btn" onClick={() => void refresh()}>Refresh</button>
        </div>
      </div>
      {message && <div className="panel-body" style={{ paddingBottom: 0, color: "var(--info)" }}>{message}</div>}
      <div className="panel-body flush" style={{ overflowX: "auto" }}>
        <table className="table" data-testid="presence-matrix">
          <thead>
            <tr>
              <th>Model</th>
              {nodes.map((n) => (
                <th key={n.id}>{n.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {names.slice(0, 200).map((name) => (
              <tr key={name}>
                <td>{name}</td>
                {nodes.map((n) => {
                  const present = presence[n.id]?.has(name) ?? false;
                  const cellBusy = busy === `${n.id}:${name}`;
                  return (
                    <td key={n.id}>
                      {present ? (
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <span className="pill ok"><span className="dot" />present</span>
                          <button
                            className="btn"
                            disabled={cellBusy}
                            onClick={() => void act(n.id, "modelctl-delete-local", { model: name }, name)}
                            title="Remove from node cache"
                          >
                            ✕
                          </button>
                        </span>
                      ) : (
                        <span style={{ display: "inline-flex", gap: 6 }}>
                          <button
                            className="btn"
                            disabled={cellBusy}
                            onClick={() => void act(n.id, "modelctl-sync-local", { model: name }, name)}
                            title="Sync from NAS store"
                          >
                            ↓ sync
                          </button>
                          {nodes
                            .filter((src) => presence[src.id]?.has(name) && src.lanIp && src.id !== n.id)
                            .map((src) => (
                              <button
                                key={src.id}
                                className="btn"
                                disabled={cellBusy}
                                onClick={() =>
                                  void act(n.id, "modelctl-push", { model: name, host: lanIpOf(src.id) ?? "" }, name)
                                }
                                title={`Push from ${src.name}`}
                              >
                                ⇥ push {src.name}
                              </button>
                            ))}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DownloadsTab({ nodes }: { nodes: NodeInfo[] }) {
  const [source, setSource] = useState("");
  const [target, setTarget] = useState(nodes[0]?.id ?? "");
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await listJobs(undefined, true);
      const detailed = await Promise.all(all.jobs.map((j) => getJob(j.reqId)));
      setJobs(detailed.filter((j) => j.kind.startsWith("modelctl")));
    } catch {
      // polling errors are non-fatal
    }
  }, []);

  useEffect(() => {
    void refresh();
    timer.current = setInterval(() => void refresh(), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [refresh]);

  useEffect(() => {
    if (!target && nodes.length > 0) setTarget(nodes[0]!.id);
  }, [nodes, target]);

  const submit = async () => {
    setError(null);
    try {
      await dispatchJob(target, "modelctl-download", { source: source.trim() }, 30 * 60_000);
      setSource("");
      void refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Download queue</h3>
        <span className="sub">Hugging Face → NAS store (modelctl download)</span>
      </div>
      <div className="panel-body" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            placeholder="owner/model or huggingface.co URL"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            style={{ flex: "1 1 280px" }}
            data-testid="download-source"
          />
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={!source.trim() || !target} onClick={() => void submit()} data-testid="download-submit">
            Download
          </button>
        </div>
        {error && <div style={{ color: "var(--crit)" }}>{error}</div>}
        {jobs.length === 0 && <span style={{ color: "var(--text-3)" }}>No modelctl jobs yet.</span>}
        {jobs.map((job) => (
          <div key={job.reqId} className="panel" style={{ padding: 12 }} data-testid={`job-${job.reqId}`}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <span className={`pill ${job.state === "running" ? "info" : job.state === "done" ? "ok" : "crit"}`}>
                <span className="dot" />
                {job.state}
              </span>
              <strong style={{ fontSize: 12.5 }}>{job.argv.join(" ")}</strong>
              <span style={{ color: "var(--text-3)", fontSize: 12 }}>on {job.nodeId}</span>
              <div className="right" style={{ marginLeft: "auto" }}>
                {job.state === "running" && (
                  <button className="btn" onClick={() => void cancelJob(job.reqId).then(() => void refresh())}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
            {job.output && (
              <pre style={{ margin: 0, maxHeight: 180, overflow: "auto", fontSize: 11.5, whiteSpace: "pre-wrap" }}>
                {job.output + (job.truncated ? "\n… truncated" : "")}
              </pre>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
