import { useCallback, useEffect, useState } from "react";

interface ClientRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: number;
  revokedAt: number | null;
  lastSeenAt: number | null;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function ClientsPage() {
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setClients((await json<{ clients: ClientRow[] }>("/api/gateway/clients")).clients);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const create = async () => {
    setError(null);
    try {
      const scopeList = scopes.split(",").map((s) => s.trim()).filter(Boolean);
      const { key } = await json<{ client: ClientRow; key: string }>("/api/gateway/clients", {
        method: "POST",
        body: JSON.stringify({ name, scopes: scopeList }),
      });
      setCreatedKey(key);
      setName("");
      setScopes("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await json(`/api/gateway/clients/${id}/revoke`, { method: "POST" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await json(`/api/gateway/clients/${id}`, { method: "DELETE" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head"><h2>Create client</h2></div>
        <div className="panel-body" style={{ display: "grid", gap: 8 }}>
          <p className="hint">
            Keys are hashed (SHA-256) — the full key is shown exactly once. Scopes are served-model aliases;
            empty or "*" grants everything.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input placeholder="Client name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 160 }} aria-label="Client name" />
            <input placeholder="Scopes (comma-separated, empty = *)" value={scopes} onChange={(e) => setScopes(e.target.value)} style={{ flex: 1, minWidth: 200 }} aria-label="Scopes" />
            <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>Create key</button>
          </div>
          {createdKey && (
            <div data-testid="created-key" style={{ padding: 10, borderRadius: 8, background: "var(--bg-2, #11151c)", fontFamily: "monospace", wordBreak: "break-all" }}>
              {createdKey}
              <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => void navigator.clipboard?.writeText(createdKey).catch(() => undefined)}>Copy</button>
              <div className="hint" style={{ marginTop: 4 }}>This key will never be shown again.</div>
            </div>
          )}
          {error && <div style={{ color: "var(--crit)" }}>{error}</div>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Clients</h2>
          <span className="pill info"><span className="dot" />{clients?.length ?? "…"}</span>
        </div>
        <div className="panel-body flush" style={{ overflowX: "auto" }}>
          <table className="table" data-testid="clients-table">
            <thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Last seen</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {(clients ?? []).map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong></td>
                  <td><code style={{ fontSize: 11.5 }}>{c.keyPrefix}</code></td>
                  <td>{c.scopes.map((s) => <span key={s} className="chip">{s}</span>)}</td>
                  <td>{c.lastSeenAt ? new Date(c.lastSeenAt).toLocaleString() : "never"}</td>
                  <td>
                    {c.revokedAt != null
                      ? <span className="pill crit"><span className="dot" />revoked</span>
                      : <span className="pill ok"><span className="dot" />active</span>}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      {c.revokedAt == null && <button className="btn sm warn" onClick={() => void revoke(c.id)}>Revoke</button>}
                      <button className="btn sm ghost" onClick={() => void remove(c.id)}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
              {clients && clients.length === 0 && <tr><td colSpan={6} className="hint">No clients yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
