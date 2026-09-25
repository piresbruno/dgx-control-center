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
import { Callout, DetailList, ErrorBanner, Field, FormGrid, FormRow, Segmented, TableScroller } from "../ui/index.js";
import { listNodes, type NodeRecord } from "../api/nodes.js";

type Tab = "catalog" | "presence" | "downloads";


const POLL_MS = 2_000;

export function ModelsPage() {
  const [tab, setTab] = useState<Tab>("catalog");
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [nas, setNas] = useState<InventorySnapshot | null>(null);
  const [selected, setSelected] = useState<ModelRow | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    void listNodes()
      .then((d) => setNodes(d.nodes.filter((n) => n.kind !== "nas")))
      .catch(() => undefined);
    void getNasModels().then(setNas).catch(() => setNas(null));
  }, []);

  const catalog = (nas?.models ?? []).filter(
    (m) =>
      !search ||
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.repository.toLowerCase().includes(search.toLowerCase()),
  );

  return (
  <div data-testid="models-page">
      <header className="page-head">
        <div className="page-title">
          <h2>Models</h2>
          <p className="sub">
            NAS store{nas ? ` · ${nas.models.length} active` : ""} — inventory, placement, transfers
            {nas?.stale ? " (stale)" : ""}
          </p>
        </div>
        <Segmented<Tab>
          ariaLabel="Models view"
          value={tab}
          onChange={setTab}
          options={[
            { value: "catalog", label: "Catalog" },
            { value: "presence", label: "Presence" },
            { value: "downloads", label: "Downloads" },
          ]}
        />
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

function DoctorRow({ nodes }: { nodes: NodeRecord[] }) {
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
    <div className="doctor-row">
      {nodes.map((node) => {
        const check = checks[node.id];
        const outcome = check === "loading" || check === undefined ? null : check;
        return (
          <span key={node.id} className="row">
            <span className={`pill ${outcome ? (outcome.ok ? "ok" : "crit") : "info"}`} data-testid={`doctor-${node.id}`}>
              <span className="dot" />
              {node.name}: {outcome === null ? "checking…" : outcome.ok ? `modelctl ${outcome.version ?? ""}` : (outcome.reason ?? "unreachable")}
            </span>
            {outcome !== null && !outcome.ok && (
              <button className="btn" disabled={provisioning === node.id} onClick={() => void provision(node.id)}>
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
  nodes: NodeRecord[];
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
        <div className={props.error ? "panel-body" : "panel-body flush"}>
          {props.error ? (
            <Callout kind="crit">Store inventory failed — {props.error}</Callout>
          ) : (
            <table className="table" data-testid="catalog-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Runtime</th>
                  <th>Repository</th>
                  <th className="num">Size</th>
                </tr>
              </thead>
              <tbody>
                {props.catalog.map((m) => (
                  <tr
                    key={m.name}
                    className={props.selected?.name === m.name ? "clickable selected" : "clickable"}
                    onClick={() => props.setSelected(m)}
                    data-testid={`catalog-${m.name}`}
                  >
                    <td>{m.name}</td>
                    <td>{m.runtime ?? "—"}</td>
                    <td className="faint">{m.repository}</td>
                    <td className="num">{humanBytes(m.bytes)}</td>
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
            <div className="stack tight">
              <strong>{props.selected.name}</strong>
              <DetailList
                items={[
                  { label: "Repository", value: props.selected.repository, mono: false },
                  { label: "Runtime", value: props.selected.runtime ?? "unknown" },
                  { label: "Size", value: humanBytes(props.selected.bytes) },
                ]}
              />
            </div>
          ) : (
            <div className="faint">Select a model from the catalog.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function PresenceTab({ nodes, catalog }: { nodes: NodeRecord[]; catalog: ModelRow[] }) {
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
      {message && (
        <div className="panel-body">
          <Callout kind="info">{message}</Callout>
        </div>
      )}
      <TableScroller>
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
                        <span className="row">
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
                        <span className="row">
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
      </TableScroller>
    </section>
  );
}

function DownloadsTab({ nodes }: { nodes: NodeRecord[] }) {
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
      <div className="panel-body stack">
        <FormGrid>
          <Field label="Source" htmlFor="download-source-field">
            <input
              id="download-source-field"
              className="grow"
              placeholder="owner/model or huggingface.co URL"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              data-testid="download-source"
            />
          </Field>
          <Field label="Target node" htmlFor="download-target-node">
            <FormRow>
              <select id="download-target-node" className="w-md" value={target} onChange={(e) => setTarget(e.target.value)}>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
              <button className="btn primary" disabled={!source.trim() || !target} onClick={() => void submit()} data-testid="download-submit">
                Download
              </button>
            </FormRow>
          </Field>
        </FormGrid>
        <ErrorBanner error={error} />
        {jobs.length === 0 && <div className="faint">No modelctl jobs yet.</div>}
        {jobs.map((job) => (
          <div key={job.reqId} className="panel panel-body stack tight" data-testid={`job-${job.reqId}`}>
            <div className="row between">
              <span className="row">
                <span className={`pill ${job.state === "running" ? "info" : job.state === "done" ? "ok" : "crit"}`}>
                  <span className="dot" />
                  {job.state}
                </span>
                <strong className="small">{job.argv.join(" ")}</strong>
                <span className="faint small">on {job.nodeId}</span>
              </span>
              {job.state === "running" && (
                <button className="btn" onClick={() => void cancelJob(job.reqId).then(() => void refresh())}>
                  Cancel
                </button>
              )}
            </div>
            {job.output && (
              <pre className="code-block code-block--job">
                {job.output + (job.truncated ? "\n… truncated" : "")}
              </pre>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
