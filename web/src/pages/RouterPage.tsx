import { useCallback, useEffect, useState } from "react";
import { ActionTd, ActionTh, Callout, ErrorBanner, Field, FormGrid, TableScroller } from "../ui/index.js";
import {
  deleteServedModel,
  listServedModels,
  saveServedModel,
  type ServedModel,
  type ServedTarget,
} from "../api/gateway.js";
import { listNodes, type NodeRecord } from "../api/nodes.js";

export function RouterPage() {
  const [models, setModels] = useState<ServedModel[] | null>(null);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [alias, setAlias] = useState("");
  const [targets, setTargets] = useState("");
  const [modelId, setModelId] = useState("");
  const [onDemandRecipe, setOnDemandRecipe] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setModels((await listServedModels()).models);
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
    void listNodes()
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
      await saveServedModel({
        alias,
        targets: targetList.map((t) => ({ ...t, modelId: modelId.trim() || null })),
        onDemand: onDemandRecipe.trim() ? { recipeId: onDemandRecipe.trim(), idleStopS: null } : null,
      });
      setMessage(`Saved ${alias}`);
      setAlias("");
      setTargets("");
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
      await deleteServedModel(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head"><h2>Served model</h2></div>
        <div className="panel-body stack">
          <p className="hint">
            An alias maps to a fallback chain of engine endpoints (node:port). Requests rank targets healthy-first
            with round-robin inside a health class. The gateway rewrites the requested model to the upstream id.
          </p>
          <FormGrid>
            <Field label="Alias">
              <input className="grow" placeholder="alias (public model name)" value={alias} onChange={(e) => setAlias(e.target.value)} aria-label="Alias" />
            </Field>
            <Field label="Targets">
              <input className="grow" placeholder="targets: node:port, comma-separated" value={targets} onChange={(e) => setTargets(e.target.value)} aria-label="Targets" />
            </Field>
            <Field label="Upstream model id">
              <input className="grow" placeholder="upstream model id (default: alias)" value={modelId} onChange={(e) => setModelId(e.target.value)} aria-label="Upstream model id" />
            </Field>
            <Field label="On-demand recipe">
              <input className="grow" placeholder="on-demand recipe id (optional)" value={onDemandRecipe} onChange={(e) => setOnDemandRecipe(e.target.value)} aria-label="On-demand recipe" />
            </Field>
            <Field label="">
              <div className="form-row">
                <button className="btn primary" disabled={!alias.trim()} onClick={() => void save()}>Save</button>
              </div>
            </Field>
          </FormGrid>
          <div className="hint">Nodes: {nodes.map((n) => n.id).join(", ") || "…"}</div>
          {message && <Callout kind="info">{message}</Callout>}
          <ErrorBanner error={error} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Routes</h2>
          <span className="pill info"><span className="dot" />{models?.length ?? "…"}</span>
        </div>
        <TableScroller>
          <table className="table" data-testid="routes-table">
            <thead><tr><th>Alias</th><th>Fallback chain</th><th>Upstream ids</th><th>Mode</th><ActionTh /></tr></thead>
            <tbody>
              {(models ?? []).map((m) => (
                <tr key={m.id} data-testid={`route-${m.alias}`}>
                  <td><span className="strong">{m.alias}</span></td>
                  <td>{m.targets.map((t) => <span key={`${t.nodeId}:${t.port}`} className="chip">{t.nodeId}:{t.port}</span>)}</td>
                  <td className="hint">{m.targets.map((t) => t.modelId ?? "(alias)").join(", ")}</td>
                  <td>
                    {m.onDemand
                      ? <span className="pill warn"><span className="dot" />on-demand · {m.onDemand.recipeId}</span>
                      : <span className="pill ok"><span className="dot" />always-on</span>}
                  </td>
                  <ActionTd><button className="btn sm ghost" onClick={() => void remove(m.id)}>✕</button></ActionTd>
                </tr>
              ))}
              {models && models.length === 0 && <tr><td colSpan={5} className="hint">No routes defined — clients would get 404s with this list.</td></tr>}
            </tbody>
          </table>
        </TableScroller>
      </section>
    </>
  );
}
