import { useCallback, useEffect, useState } from "react";
import { ActionTd, ActionTh, ErrorBanner, Field, FormGrid, KeyBlock, TableScroller } from "../ui/index.js";
import {
  createClient,
  listClients,
  removeClient,
  revokeClient,
  type ClientRow,
} from "../api/gateway.js";

export function ClientsPage() {
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setClients((await listClients()).clients);
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
      const { key } = await createClient({ name, scopes: scopeList });
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
      await revokeClient(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await removeClient(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head"><h2>Create client</h2></div>
        <div className="panel-body stack">
          <p className="hint">
            Keys are hashed (SHA-256) — the full key is shown exactly once. Scopes are served-model aliases;
            empty or "*" grants everything.
          </p>
          <FormGrid>
            <Field label="Client name">
              <input className="grow" placeholder="Client name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Client name" />
            </Field>
            <Field label="Scopes" hint="Comma-separated, empty = *">
              <input className="grow" placeholder="Scopes (comma-separated, empty = *)" value={scopes} onChange={(e) => setScopes(e.target.value)} aria-label="Scopes" />
            </Field>
            <Field label="">
              <div className="form-row">
                <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>Create key</button>
              </div>
            </Field>
          </FormGrid>
          {createdKey && (
            <>
              <KeyBlock value={createdKey} testId="created-key" />
              <div className="hint">This key will never be shown again.</div>
            </>
          )}
          <ErrorBanner error={error} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Clients</h2>
          <span className="pill info"><span className="dot" />{clients?.length ?? "…"}</span>
        </div>
        <TableScroller>
          <table className="table" data-testid="clients-table">
            <thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Last seen</th><th>Status</th><ActionTh /></tr></thead>
            <tbody>
              {(clients ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="strong">{c.name}</td>
                  <td><code className="small">{c.keyPrefix}</code></td>
                  <td>
                    <div className="row wrap tight">
                      {c.scopes.map((s) => <span key={s} className="chip">{s}</span>)}
                    </div>
                  </td>
                  <td>{c.lastSeenAt ? new Date(c.lastSeenAt).toLocaleString() : "never"}</td>
                  <td>
                    {c.revokedAt != null
                      ? <span className="pill crit"><span className="dot" />revoked</span>
                      : <span className="pill ok"><span className="dot" />active</span>}
                  </td>
                  <ActionTd>
                    {c.revokedAt == null && <button className="btn sm warn" onClick={() => void revoke(c.id)}>Revoke</button>}
                    <button className="btn sm ghost" onClick={() => void remove(c.id)}>✕</button>
                  </ActionTd>
                </tr>
              ))}
              {clients && clients.length === 0 && <tr><td colSpan={6} className="hint">No clients yet.</td></tr>}
            </tbody>
          </table>
        </TableScroller>
      </section>
    </>
  );
}
