import { useCallback, useEffect, useState } from "react";

interface ServedTarget {
  nodeId: string;
  port: number;
  modelId?: string | null;
}

interface ServedModel {
  id: string;
  alias: string;
  targets: ServedTarget[];
  onDemand: { recipeId: string; idleStopS: number | null } | null;
  updatedAt: number;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

interface NodeRow {
  id: string;
  name: string;
  kind: string;
}

export function RouterPage() {
  const [models, setModels] = useState<ServedModel[] | null>(null);
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [alias, setAlias] = useState("");
  const [targets, setTargets] = useState("dgx1:8081");
  const [modelId, setModelId] = useState("");
  const [onDemandRecipe, setOnDemandRecipe] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setModels((await json<{ models: ServedModel[] }>("/api/gateway/served-models")).models);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    void fetch("/api/nodes")
      .then((r) => r.json() as Promise<{ nodes: NodeRow[] }>)
      .then((d) => setNodes(d.nodes.filter((n) => n.kind !== "nas")))
      .catch(() => undefined);
  }, []);

  const save = async () => {
    setError(null);
    setMessage(null);
    try {
      const targetList: ServedTarget[] = targets
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((pair) => {
          const [nodeId, port] = pair.split(":");
          return { nodeId: nodeId!.trim(), port: Number(port) };
        });
      if (targetList.some((t) => !t.nodeId || !Number.isInteger(t.port) || t.port < 1 || t.port > 65535)) {
        throw new Error("targets must be nodeId:port pairs");
      }
      await json("/api/gateway/served-models", {
        method: "POST",
        body: JSON.stringify({
          alias,
          targets: targetList.map((t) => ({ ...t, modelId: modelId.trim() || null })),
          onDemand: onDemandRecipe.trim() ? { recipeId: onDemandRecipe.trim(), idleStopS: null } : null,
        }),
      });
      setMessage(`Saved ${alias}`);
      setAlias("");
      setTargets("dgx1:8081");
      setModelId("");
      setOnDemandRecipe("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await json(`/api/gateway/served-models/${id}`, { method: "DELETE" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head"><h2>Served model</h2></div>
        <div className="panel-body" style={{ display: "grid", gap: 8 }}>
          <p className="hint">
            An alias maps to a fallback chain of engine endpoints (node:port). Requests rank targets healthy-first
            with round-robin inside a health class. The gateway rewrites the requested model to the upstream id.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input placeholder="alias (public model name)" value={alias} onChange={(e) => setAlias(e.target.value)} style={{ flex: 1, minWidth: 180 }} aria-label="Alias" />
            <input placeholder="targets: dgx1:8081, dgx2:8081" value={targets} onChange={(e) => setTargets(e.target.value)} style={{ flex: 2, minWidth: 240 }} aria-label="Targets" />
            <input placeholder={`upstream model id (default: alias)${modelId ? "" : ""}`} value={modelId} onChange={(e) => setModelId(e.target.value)} style={{ flex: 1, minWidth: 180 }} aria-label="Upstream model id" />
            <input placeholder="on-demand recipe id (optional)" value={onDemandRecipe} onChange={(e) => setOnDemandRecipe(e.target.value)} style={{ flex: 1, minWidth: 180 }} aria-label="On-demand recipe" />
            <button className="btn primary" disabled={!alias.trim()} onClick={() => void save()}>Save</button>
          </div>
          <div className="hint">Nodes: {nodes.map((n) => n.id).join(", ") || "…"}</div>
          {message && <div style={{ color: "var(--info)" }}>{message}</div>}
          {error && <div style={{ color: "var(--crit)" }}>{error}</div>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Routes</h2>
          <span className="pill info"><span className="dot" />{models?.length ?? "…"}</span>
        </div>
        <div className="panel-body flush" style={{ overflowX: "auto" }}>
          <table className="table" data-testid="routes-table">
            <thead><tr><th>Alias</th><th>Fallback chain</th><th>Upstream ids</th><th>Mode</th><th>Actions</th></tr></thead>
            <tbody>
              {(models ?? []).map((m) => (
                <tr key={m.id} data-testid={`route-${m.alias}`}>
                  <td><strong>{m.alias}</strong></td>
                  <td>{m.targets.map((t) => <span key={`${t.nodeId}:${t.port}`} className="chip">{t.nodeId}:{t.port}</span>)}</td>
                  <td className="hint">{m.targets.map((t) => t.modelId ?? "(alias)").join(", ")}</td>
                  <td>
                    {m.onDemand
                      ? <span className="pill warn"><span className="dot" />on-demand · {m.onDemand.recipeId}</span>
                      : <span className="pill ok"><span className="dot" />always-on</span>}
                  </td>
                  <td><button className="btn sm ghost" onClick={() => void remove(m.id)}>✕</button></td>
                </tr>
              ))}
              {models && models.length === 0 && <tr><td colSpan={5} className="hint">No routes defined — clients would get 404s with this list.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
