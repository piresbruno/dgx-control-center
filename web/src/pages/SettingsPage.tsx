import { useCallback, useEffect, useState } from "react";

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

  const patch = async (p: Partial<SystemSettings>, note: string) => {
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
