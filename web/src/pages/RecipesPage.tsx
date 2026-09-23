import { useCallback, useEffect, useState } from "react";
import {
  listRecipes,
  registerRecipe,
  probeRecipe,
  deleteRecipe,
  createDeployment,
  type RecipeRecord,
} from "../api/serving.js";

interface NodeRow {
  id: string;
  name: string;
  kind: string;
  role: string;
}

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
  const [nodes, setNodes] = useState<NodeRow[]>([]);
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
    void fetch("/api/nodes")
      .then((r) => r.json() as Promise<{ nodes: NodeRow[] }>)
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
        <div className="panel-body" style={{ display: "grid", gap: 8 }}>
          <p className="hint">
            A recipe is a user-owned folder on a node (start.sh dispatcher + .env). The dashboard never edits it —
            it probes read-only and runs its verbs.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select value={nodeId} onChange={(e) => setNodeId(e.target.value)} aria-label="Node">
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>{n.name || n.id}</option>
              ))}
            </select>
            <input
              style={{ flex: 2, minWidth: 260 }}
              placeholder="/home/you/recipes/GLM-…"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              aria-label="Absolute path on node"
            />
            <input
              style={{ flex: 1, minWidth: 160 }}
              placeholder="Label (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              aria-label="Label"
            />
            <button className="btn primary" disabled={busy || !nodeId || !path.trim()} onClick={() => void register()}>
              Register &amp; probe
            </button>
          </div>
          {message && <div style={{ color: "var(--info)" }}>{message}</div>}
          {error && <div style={{ color: "var(--crit)" }}>{error}</div>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Recipes</h2>
          <span className="pill info"><span className="dot" />{recipes?.length ?? "…"} registered</span>
        </div>
        <div className="panel-body flush" style={{ overflowX: "auto" }}>
          <table className="table" data-testid="recipes-table">
            <thead>
              <tr>
                <th>Recipe</th>
                <th>Node</th>
                <th>Probe</th>
                <th>Drift</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(recipes ?? []).map((r) => (
                <tr key={r.id} data-testid={`recipe-${r.id}`}>
                  <td>
                    <strong>{r.label ?? r.id}</strong>
                    <div className="hint" style={{ fontSize: 11 }}>{r.path}</div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                      <MetaChips recipe={r} />
                    </div>
                  </td>
                  <td>{r.sparkId}</td>
                  <td>
                    {r.probeError ? (
                      <span className="pill crit"><span className="dot" />{r.probeError}</span>
                    ) : (
                      <span className="pill ok"><span className="dot" />{r.meta?.class ?? "probing"}</span>
                    )}
                    {r.orphaned && <span className="pill warn"><span className="dot" />orphaned</span>}
                  </td>
                  <td><DriftChip recipe={r} /></td>
                  <td>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button className="btn sm" onClick={() => void reprobe(r.id)}>Re-probe</button>
                      <button className="btn sm primary" disabled={!r.meta} onClick={() => void deploy(r.id)}>Deploy</button>
                      <button className="btn sm ghost" onClick={() => void remove(r.id)}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
              {recipes && recipes.length === 0 && (
                <tr><td colSpan={5} className="hint">No recipes registered yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
