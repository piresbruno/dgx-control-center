import { useCallback, useEffect, useState } from "react";
import { ActionTd, ActionTh, Callout, CellWith, ErrorBanner, Field, FormGrid, FormRow, TableScroller, Toolbar } from "../ui/index.js";
import {
  createBackup,
  getSettings,
  importConfig,
  listBackups,
  patchSettings,
  runMaintenanceNow,
  type BackupRow,
  type SystemSettings,
} from "../api/system.js";
import { installAgent, listNodes, registerNode, type NodeRecord } from "../api/nodes.js";

const configExportHref = "/api/system/export";

export function SettingsPage() {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [originsDraft, setOriginsDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [maintenance, setMaintenance] = useState<string | null>(null);
  const [nodes, setNodes] = useState<NodeRecord[] | null>(null);
  const [draft, setDraft] = useState({ id: "", name: "", kind: "spark", role: "worker", lanIp: "", sshUser: "" });
  const [nodeMessage, setNodeMessage] = useState<string | null>(null);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSettings(await getSettings());
      setBackups((await listBackups()).backups);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshNodes = useCallback(async () => {
    try {
      setNodes((await listNodes()).nodes);
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
      await registerNode({
        id,
        name: draft.name.trim() || id,
        kind: draft.kind as NodeRecord["kind"],
        role: draft.role as NodeRecord["role"],
        ...(draft.lanIp.trim() ? { lanIp: draft.lanIp.trim() } : {}),
        ...(draft.sshUser.trim() ? { sshUser: draft.sshUser.trim() } : {}),
      });
      setNodeMessage(`Node '${id}' registered — agents may now connect with this sparkId.`);
      setDraft((d) => ({ ...d, id: "", name: "" }));
      await refreshNodes();
    } catch (e) {
      setNodeError(e instanceof Error ? e.message : String(e));
    }
  };

  const doInstall = async (id: string) => {
    setNodeError(null);
    setNodeMessage(null);
    setInstalling(id);
    try {
      const outcome = await installAgent(id);
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
      setSettings(await patchSettings(p));
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
      const r = await runMaintenanceNow();
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
      const res = await importConfig(await file.text());
      setMessage(`Imported ${res.written.join(", ")} — restart the dashboard to apply.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      {(message || error) && (
        <div className="stack tight mb">
          {message && <Callout kind="info" testId="settings-message">{message}</Callout>}
          {error && <ErrorBanner error={error} />}
        </div>
      )}

      <section className="panel">
        <div className="panel-head"><h2>Retention</h2></div>
        <div className="panel-body stack">
          <FormGrid>
            <Field label="Trace retention (days)">
              <input
                type="number"
                min={1}
                max={365}
                className="w-sm"
                value={settings?.retention.tracesDays ?? 7}
                onChange={(e) => setSettings((s) => (s ? { ...s, retention: { ...s.retention, tracesDays: Number(e.target.value) } } : s))}
                onBlur={(e) => void patch({ retention: { tracesDays: Number(e.target.value) } }, "Trace retention saved")}
              />
            </Field>
            <Field label="Backups to keep">
              <input
                type="number"
                min={1}
                max={100}
                className="w-sm"
                value={settings?.retention.backupsKeep ?? 10}
                onChange={(e) => setSettings((s) => (s ? { ...s, retention: { ...s.retention, backupsKeep: Number(e.target.value) } } : s))}
                onBlur={(e) => void patch({ retention: { backupsKeep: Number(e.target.value) } }, "Backup retention saved")}
              />
            </Field>
          </FormGrid>
          <div className="hint">Metrics rollups: 1m ≈ 7 d, 1h/1d ≈ 90/365 d (fixed windows). Maintenance runs hourly.</div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Capture</h2></div>
        <div className="panel-body">
          <FormGrid>
            <Field
              label="Request payloads"
              hint="v1 records request metadata only (never bodies). Payload capture ships with capture settings in a later release."
            >
              <label className="row">
                <input
                  type="checkbox"
                  checked={settings?.capture.payloads ?? false}
                  disabled
                  data-testid="capture-payloads"
                />
                Capture request payloads
              </label>
            </Field>
          </FormGrid>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>CORS origins</h2></div>
        <div className="panel-body stack">
          <div className="hint">Exact-origin allowlist for browser access (empty = same-origin only, never "*").</div>
          <FormGrid>
            <Field label="Allowed origins" top>
              <textarea
                className="grow"
                value={originsDraft || (settings?.corsOrigins ?? []).join("\n")}
                onChange={(e) => setOriginsDraft(e.target.value)}
                rows={3}
                placeholder="https://dashboard.example.com"
                aria-label="CORS origins"
              />
              <div>
                <button className="btn sm primary" onClick={() => void saveOrigins()}>Save origins</button>
              </div>
            </Field>
          </FormGrid>
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
        <div className="panel-body stack">
          <div className="hint">
            Registered nodes (<code>nodes.json</code>). Agents may only connect with a registered sparkId — add them
            here instead of hand-editing the file. Install uses SSH, so lanIp + sshUser are required for it.
          </div>
          <TableScroller>
            <table className="table">
              <thead><tr><th>Node</th><th>Kind / role</th><th>lanIp / sshUser</th><ActionTh /></tr></thead>
              <tbody>
                {(nodes ?? []).map((n) => (
                  <tr key={n.id} data-testid={`registry-row-${n.id}`}>
                    <CellWith title={<span className="mono">{n.id}</span>} sub={n.name} />
                    <CellWith title={n.kind} sub={n.role} />
                    <CellWith title={n.lanIp ?? "—"} sub={n.sshUser ?? "no ssh user"} />
                    <ActionTd>
                      {n.kind !== "nas" && n.lanIp && n.sshUser && (
                        <button className="btn sm" disabled={installing === n.id} onClick={() => void doInstall(n.id)}>
                          {installing === n.id ? "Installing…" : "Install agent"}
                        </button>
                      )}
                    </ActionTd>
                  </tr>
                ))}
                {nodes !== null && nodes.length === 0 && <tr><td colSpan={4} className="hint">No nodes registered yet.</td></tr>}
              </tbody>
            </table>
          </TableScroller>
          <FormRow>
            <input className="w-md" data-testid="node-id" placeholder="id (dgx3)" value={draft.id} onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))} />
            <input className="w-md" data-testid="node-name" placeholder="name (dgx-3)" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
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
            <input className="w-md" data-testid="node-lanip" placeholder="lanIp" value={draft.lanIp} onChange={(e) => setDraft((d) => ({ ...d, lanIp: e.target.value }))} />
            <input className="w-md" data-testid="node-sshuser" placeholder="sshUser" value={draft.sshUser} onChange={(e) => setDraft((d) => ({ ...d, sshUser: e.target.value }))} />
            <button className="btn sm primary" data-testid="node-add" onClick={() => void addNode()}>Add node</button>
          </FormRow>
          {nodeMessage && <Callout kind="info" testId="nodes-message">{nodeMessage}</Callout>}
          <ErrorBanner error={nodeError} testId="nodes-error" />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>System</h2></div>
        <div className="panel-body stack">
          <Toolbar>
            <a className="btn sm primary" href={configExportHref} download="controlcenter-config.json">Export config</a>
            <label className="btn sm">
              Import config
              <input
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void doImport(f);
                }}
              />
            </label>
            <button className="btn sm" onClick={() => void runMaintenance()}>Run maintenance now</button>
            <button className="btn sm" onClick={() => void createBackup().then(refresh)}>Create backup</button>
          </Toolbar>
          {maintenance && <div className="hint">{maintenance}</div>}
          <TableScroller>
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
          </TableScroller>
        </div>
      </section>
    </>
  );
}
