import { useCallback, useEffect, useState } from "react";

interface NodeRecord {
  id: string;
  name: string;
  kind: string;
  role: string;
  lanIp?: string;
  sshUser?: string;
  createdAt: number;
}

interface SystemSettings {
  retention: { tracesDays: number; alertEventsMax: number; backupsKeep: number };
  capture: { payloads: boolean };
  corsOrigins: string[];
}

interface BackupRow {
  id: string;
  files: string[];
  dbBytes: number;
  createdAt: number;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function SettingsPage() {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [originsDraft, setOriginsDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backups, setBackups] = useState<Array<{ id: string; files: string[]; dbBytes: number }>>([]);
  const [maintenance, setMaintenance] = useState<string | null>(null);
  const [nodes, setNodes] = useState<NodeRecord[] | null>(null);
  const [draft, setDraft] = useState({ id: "", name: "", kind: "spark", role: "worker", lanIp: "", sshUser: "" });
  const [nodeMessage, setNodeMessage] = useState<string | null>(null);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSettings(await json<SystemSettings>("/api/system/settings"));
      setBackups((await json<{ backups: Array<{ id: string; files: string[]; dbBytes: number }> }>("/api/system/backups")).backups);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshNodes = useCallback(async () => {
    try {
      setNodes(await json<{ nodes: NodeRecord[] }>("/api/nodes").then((d) => d.nodes));
    } catch (e) {
      setNodeError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refreshNodes();
  }, [refreshNodes]);

  const addNode = async () => {
    setNodeError(null);
    setNodeMessage(null);
    const id = draft.id.trim();
    if (!id) {
      setNodeError("Node id is required.");
      return;
    }
    try {
      const payload: Record<string, unknown> = {
        id,
        name: draft.name.trim() || id,
        kind: draft.kind,
        role: draft.role,
      };
      if (draft.lanIp.trim()) payload.lanIp = draft.lanIp.trim();
      if (draft.sshUser.trim()) payload.sshUser = draft.sshUser.trim();
      await json("/api/nodes", { method: "POST", body: JSON.stringify(payload) });
      setNodeMessage(`Node '${id}' registered — agents may now connect with this sparkId.`);
      setDraft((d) => ({ ...d, id: "", name: "" }));
      await refreshNodes();
    } catch (e) {
      setNodeError(e instanceof Error ? e.message : String(e));
    }
  };

  const installAgent = async (id: string) => {
    setNodeError(null);
    setNodeMessage(null);
    setInstalling(id);
    try {
      const outcome = await json<{ ok: boolean; mode: string; reason: string | null; helloSeen: boolean }>(
        `/api/nodes/${id}/install-agent`,
        { method: "POST" },
      );
      setNodeMessage(
        outcome.ok && outcome.helloSeen
          ? `Agent installed on ${id} (${outcome.mode}) — hello seen.`
          : `Install on ${id}: ok=${outcome.ok}, mode=${outcome.mode}${outcome.reason ? ` — ${outcome.reason}` : ""}`,
      );
    } catch (e) {
      setNodeError(`Install on ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(null);
    }
  };

  /** PATCH accepts deep-partial settings (e.g. a single retention field). */
  const patch = async (
    p: { retention?: Partial<SystemSettings["retention"]>; capture?: Partial<SystemSettings["capture"]>; corsOrigins?: string[] },
    note: string,
  ) => {
    setError(null);
    setMessage(null);
    try {
      setSettings(await json<SystemSettings>("/api/system/settings", { method: "PATCH", body: JSON.stringify(p) }));
      setMessage(note);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const saveOrigins = () => {
    const list = originsDraft.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    void patch({ corsOrigins: list }, "CORS origins saved");
  };

  const runMaintenance = async () => {
    try {
      const r = await json<{ metricsPruned: Record<string, number>; tracesPruned: number; backupsDeleted: string[] }>("/api/system/maintenance", { method: "POST" });
      setMaintenance(`pruned ${r.tracesPruned} traces · ${r.metricsPruned["1m"] ?? 0} 1m buckets · ${r.backupsDeleted.length} backups`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doImport = async (file: File) => {
    setError(null);
    setMessage(null);
    try {
      const text = await file.text();
      const res = await json<{ written: string[]; skipped: string[]; restartRequired: boolean }>("/api/system/import", {
        method: "POST",
        body: text,
      });
      setMessage(`Imported ${res.written.join(", ")} — restart the dashboard to apply.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      {message && <section className="panel"><div className="panel-body" style={{ color: "var(--info)" }} data-testid="settings-message">{message}</div></section>}
      {error && <section className="panel"><div className="panel-body" style={{ color: "var(--crit)" }}>{error}</div></section>}

      <section className="panel">
        <div className="panel-head"><h2>Retention</h2></div>
        <div className="panel-body" style={{ display: "grid", gap: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
            Trace retention (days)
            <input
              type="number"
              min={1}
              max={365}
              value={settings?.retention.tracesDays ?? 7}
              onChange={(e) => setSettings((s) => (s ? { ...s, retention: { ...s.retention, tracesDays: Number(e.target.value) } } : s))}
              onBlur={(e) => void patch({ retention: { tracesDays: Number(e.target.value) } }, "Trace retention saved")}
              style={{ width: 90 }}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
            Backups to keep
            <input
              type="number"
              min={1}
              max={100}
              value={settings?.retention.backupsKeep ?? 10}
              onChange={(e) => setSettings((s) => (s ? { ...s, retention: { ...s.retention, backupsKeep: Number(e.target.value) } } : s))}
              onBlur={(e) => void patch({ retention: { backupsKeep: Number(e.target.value) } }, "Backup retention saved")}
              style={{ width: 90 }}
            />
          </label>
          <div className="hint">Metrics rollups: 1m ≈ 7 d, 1h/1d ≈ 90/365 d (fixed windows). Maintenance runs hourly.</div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Capture</h2></div>
        <div className="panel-body" style={{ display: "grid", gap: 8 }}>
          <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={settings?.capture.payloads ?? false}
              disabled
              data-testid="capture-payloads"
            />
            Capture request payloads
          </label>
          <div className="hint">v1 records request metadata only (never bodies). Payload capture ships with capture settings in a later release.</div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>CORS origins</h2></div>
        <div className="panel-body" style={{ display: "grid", gap: 8 }}>
          <div className="hint">Exact-origin allowlist for browser access (empty = same-origin only, never "*").</div>
          <textarea
            value={originsDraft || (settings?.corsOrigins ?? []).join("\n")}
            onChange={(e) => setOriginsDraft(e.target.value)}
            rows={3}
            placeholder="https://dashboard.example.com"
            aria-label="CORS origins"
          />
          <div>
            <button className="btn sm primary" onClick={() => void saveOrigins()}>Save origins</button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Tokens &amp; secrets</h2></div>
        <div className="panel-body">
          <div className="hint">
            The agent token and the gateway upstream credential live in environment variables
            (<code>CC_AGENT_TOKEN</code>, <code>CC_UPSTREAM_AUTH</code>) — never in config files or exports. Rotating the
            agent token requires updating each agent's config and the dashboard env together.
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Nodes</h2></div>
        <div className="panel-body" style={{ display: "grid", gap: 10 }}>
          <div className="hint">
            Registered nodes (<code>nodes.json</code>). Agents may only connect with a registered sparkId — add them
            here instead of hand-editing the file. Install uses SSH, so lanIp + sshUser are required for it.
          </div>
          {(nodes ?? []).map((n) => (
            <div
              key={n.id}
              data-testid={`registry-row-${n.id}`}
              style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--hairline)", paddingTop: 8 }}
            >
              <strong className="mono">{n.id}</strong>
              <span className="hint">
                {n.name} · {n.kind} · {n.role}
                {n.lanIp ? ` · ${n.lanIp}` : ""}
              </span>
              <span style={{ flex: 1 }} />
              {n.kind !== "nas" && n.lanIp && n.sshUser && (
                <button className="btn sm" disabled={installing === n.id} onClick={() => void installAgent(n.id)}>
                  {installing === n.id ? "Installing…" : "Install agent"}
                </button>
              )}
            </div>
          ))}
          {nodes !== null && nodes.length === 0 && <div className="empty">No nodes registered yet.</div>}
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", borderTop: "1px solid var(--hairline)", paddingTop: 10 }}>
            <input data-testid="node-id" placeholder="id (dgx3)" value={draft.id} onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))} />
            <input data-testid="node-name" placeholder="name (dgx-3)" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            <select data-testid="node-kind" value={draft.kind} onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))} aria-label="Kind">
              <option value="spark">spark</option>
              <option value="gpu-host">gpu-host</option>
              <option value="nas">nas</option>
            </select>
            <select data-testid="node-role" value={draft.role} onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))} aria-label="Role">
              <option value="head">head</option>
              <option value="worker">worker</option>
              <option value="standalone">standalone</option>
            </select>
            <input data-testid="node-lanip" placeholder="lanIp" value={draft.lanIp} onChange={(e) => setDraft((d) => ({ ...d, lanIp: e.target.value }))} />
            <input data-testid="node-sshuser" placeholder="sshUser" value={draft.sshUser} onChange={(e) => setDraft((d) => ({ ...d, sshUser: e.target.value }))} />
            <button className="btn sm primary" data-testid="node-add" onClick={() => void addNode()}>Add node</button>
          </div>
          {nodeMessage && <div className="hint" data-testid="nodes-message">{nodeMessage}</div>}
          {nodeError && <div style={{ color: "var(--crit)" }} data-testid="nodes-error">{nodeError}</div>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>System</h2></div>
        <div className="panel-body" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <a className="btn sm primary" href="/api/system/export" download="controlcenter-config.json">Export config</a>
            <label className="btn sm">
              Import config
              <input
                type="file"
                accept="application/json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void doImport(f);
                }}
              />
            </label>
            <button className="btn sm" onClick={() => void runMaintenance()}>Run maintenance now</button>
            <button className="btn sm" onClick={() => void json("/api/system/backup", { method: "POST" }).then(refresh)}>Create backup</button>
          </div>
          {maintenance && <div className="hint">{maintenance}</div>}
          <table className="table" data-testid="backups-table">
            <thead><tr><th>Backup</th><th>Files</th><th>DB size</th></tr></thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id}>
                  <td>{b.id}</td>
                  <td>{b.files.length} files</td>
                  <td>{(b.dbBytes / 1024).toFixed(0)} KiB</td>
                </tr>
              ))}
              {backups.length === 0 && <tr><td colSpan={3} className="hint">No backups yet — create one before upgrading.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

async function doImport(file: File): Promise<void> {
  const text = await file.text();
  await fetch("/api/system/import", { method: "POST", headers: { "content-type": "application/json" }, body: text });
}
