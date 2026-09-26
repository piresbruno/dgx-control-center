import { useCallback, useEffect, useState } from "react";
import {
  listRecipes,
  registerRecipe,
  probeRecipe,
  deleteRecipe,
  createDeployment,
  type RecipeRecord,
} from "../api/serving.js";
import { ActionTd, ActionTh, Callout, CellWith, ErrorBanner, Field, FormGrid, TableScroller } from "../ui/index.js";
import { listNodes, type NodeRecord } from "../api/nodes.js";

/** git drift chip: HEAD moved / dirty build relative to what we probed. */
function DriftChip({ recipe }: { recipe: RecipeRecord }) {
  if (!recipe.versions) return <span className="pill info"><span className="dot" />never probed</span>;
  const dirty = recipe.versions.dirtyBuild;
  return (
    <span className={`pill ${dirty ? "warn" : "ok"}`} title={`HEAD ${recipe.versions.gitHead ?? "?"}`}>
      <span className="dot" />
      {dirty ? "dirty build" : `clean · ${(recipe.versions.gitHead ?? "?").slice(0, 7)}`}
    </span>
  );
}

function MetaChips({ recipe }: { recipe: RecipeRecord }) {
  const m = recipe.meta;
  if (!m) return null;
  return (
    <>
      {m.port != null && <span className="chip">:{m.port}</span>}
      {m.tp != null && <span className="chip">tp{m.tp}</span>}
      <span className="chip">{m.nnodes}n</span>
      {m.servedName && <span className="chip">{m.servedName}</span>}
      {m.model && <span className="chip" title={m.model}>{m.model.split("/").pop()}</span>}
      {m.variants.map((v) => (
        <span key={v.rel} className="chip" title={v.rel}>{v.name}</span>
      ))}
      {Object.keys(m.secretPresence).length > 0 && (
        <span className="chip" title={Object.keys(m.secretPresence).join(", ")}>
          {Object.keys(m.secretPresence).length} secret{Object.keys(m.secretPresence).length === 1 ? "" : "s"}
        </span>
      )}
    </>
  );
}

export function RecipesPage() {
  const [recipes, setRecipes] = useState<RecipeRecord[] | null>(null);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [nodeId, setNodeId] = useState("");
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { recipes } = await listRecipes();
      setRecipes(recipes);
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
      .then((d) => {
        const sparks = d.nodes.filter((n) => n.kind !== "nas");
        setNodes(sparks);
        setNodeId((cur) => cur || sparks[0]?.id || "");
      })
      .catch(() => undefined);
  }, []);

  const register = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { recipe, jobId } = await registerRecipe(nodeId, path.trim(), label.trim() || undefined);
      setMessage(`Registered ${recipe.id} — probing${jobId ? "" : " (job queued)"}`);
      setPath("");
      setLabel("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reprobe = async (id: string) => {
    setError(null);
    try {
      await probeRecipe(id);
      setMessage(`Re-probing ${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await deleteRecipe(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deploy = async (id: string) => {
    setError(null);
    try {
      await createDeployment(id);
      setMessage(`Deployment created for ${id} — open the Serve page`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Register recipe</h2>
        </div>
        <div className="panel-body stack">
          <p className="hint">
            A recipe is a user-owned folder on a node (start.sh dispatcher + .env). The dashboard never edits it —
            it probes read-only and runs its verbs.
          </p>
          <FormGrid>
            <Field label="Node">
              <select value={nodeId} onChange={(e) => setNodeId(e.target.value)} aria-label="Node">
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.name || n.id}</option>
                ))}
              </select>
            </Field>
            <Field label="Path">
              <input
                className="grow"
                placeholder="/home/you/recipes/GLM-…"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                aria-label="Absolute path on node"
              />
            </Field>
            <Field label="Label">
              <input
                className="w-lg"
                placeholder="Label (optional)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                aria-label="Label"
              />
            </Field>
            <Field label="">
              <div className="form-row">
                <button className="btn primary" disabled={busy || !nodeId || !path.trim()} onClick={() => void register()}>
                  Register &amp; probe
                </button>
              </div>
            </Field>
          </FormGrid>
          {message && <Callout kind="info">{message}</Callout>}
          <ErrorBanner error={error} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Recipes</h2>
          <span className="pill info"><span className="dot" />{recipes?.length ?? "…"} registered</span>
        </div>
        <TableScroller>
          <table className="table" data-testid="recipes-table">
            <thead>
              <tr>
                <th>Recipe</th>
                <th>Node</th>
                <th>Probe</th>
                <th>Drift</th>
                <ActionTh />
              </tr>
            </thead>
            <tbody>
              {(recipes ?? []).map((r) => (
                <tr key={r.id} data-testid={`recipe-${r.id}`}>
                  <CellWith
                    title={r.label ?? r.id}
                    sub={
                      <>
                        {r.path}
                        <div className="form-row">
                          <MetaChips recipe={r} />
                        </div>
                      </>
                    }
                  />
                  <td>{r.sparkId}</td>
                  <td>
                    <div className="form-row">
                      {r.probeError ? (
                        <span className="pill crit"><span className="dot" />{r.probeError}</span>
                      ) : (
                        <span className="pill ok"><span className="dot" />{r.meta?.class ?? "probing"}</span>
                      )}
                      {r.orphaned && <span className="pill warn"><span className="dot" />orphaned</span>}
                    </div>
                  </td>
                  <td><DriftChip recipe={r} /></td>
                  <ActionTd>
                    <button className="btn sm" onClick={() => void reprobe(r.id)}>Re-probe</button>
                    <button className="btn sm primary" disabled={!r.meta} onClick={() => void deploy(r.id)}>Deploy</button>
                    <button className="btn sm ghost" onClick={() => void remove(r.id)}>✕</button>
                  </ActionTd>
                </tr>
              ))}
              {recipes && recipes.length === 0 && (
                <tr><td colSpan={5} className="hint">No recipes registered yet.</td></tr>
              )}
            </tbody>
          </table>
        </TableScroller>
      </section>
    </>
  );
}
