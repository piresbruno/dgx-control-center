import { useCallback, useEffect, useState } from "react";
import {
  listDeployments,
  listRecipes,
  deploymentVerb,
  deleteDeployment,
  getJob,
  getDeployment,
  type DeploymentRecord,
  type RecipeRecord,
} from "../api/serving.js";
import { ActionTd, ActionTh, Callout, CellWith, ErrorBanner, TableScroller } from "../ui/index.js";

const STATE_PILL: Record<string, string> = {
  healthy: "ok",
  "healthy-keyed": "ok",
  starting: "info",
  up: "warn",
  stopping: "warn",
  stopped: "info",
  failed: "crit",
  orphan: "crit",
  foreign: "crit",
  unknown: "warn",
};

function StatePill({ dep }: { dep: DeploymentRecord }) {
  const s = dep.state;
  const cls = STATE_PILL[s.state] ?? "info";
  const label =
    s.state === "healthy" && s.warmup
      ? "healthy · warmup"
      : s.state === "foreign"
        ? `foreign (${s.servedId})`
        : s.state === "failed"
          ? `failed (exit ${s.exitCode ?? "?"})`
          : s.state === "unknown"
            ? `unknown — ${s.reason}`
            : s.state === "up"
              ? "up · API silent"
              : s.state;
  return <span className={`pill ${cls}`}><span className="dot" />{label}</span>;
}

/** Live job console: polls the deployment's latest job output. */
function Console({ deployment }: { deployment: DeploymentRecord }) {
  const [output, setOutput] = useState<string>("");

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const fresh = await getDeployment(deployment.id).catch(() => null);
      if (!alive || !fresh) return;
      const jobId = fresh.jobId;
      if (!jobId) {
        setOutput("");
        return;
      }
      const job = await getJob(jobId).catch(() => null);
      if (alive && job) setOutput(job.output || "");
    };
    void poll();
    const t = setInterval(() => void poll(), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [deployment.id, deployment.jobId]);

  const jobLabel = deployment.jobState ? `${deployment.jobState}` : "idle";
  return (
    <div className="stack tight">
      <div className="hint">
        driver console — {jobLabel} {deployment.jobId ? `· ${deployment.jobId}` : ""}
      </div>
      <pre
        className="code-block code-block--console"
        data-testid={`console-${deployment.id}`}
      >
        {output || "(no job output yet)"}
      </pre>
    </div>
  );
}

/** Armed stop: two-step confirmation — the plan's "armed stop" requirement. */
function ArmedStop({ dep, onStopped }: { dep: DeploymentRecord; onStopped: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 6000); // auto-disarm
    return () => clearTimeout(t);
  }, [armed]);

  if (dep.desired === "stopped" && dep.state.state !== "starting" && dep.state.state !== "up") {
    return (
      <button className="btn sm" disabled title="deployment is stopped">
        Stop
      </button>
    );
  }
  if (!armed) {
    return (
      <button className="btn sm warn" onClick={() => setArmed(true)}>
        Arm stop
      </button>
    );
  }
  return (
    <button
      className="btn sm crit"
      data-testid={`confirm-stop-${dep.id}`}
      onClick={async () => {
        setArmed(false);
        await deploymentVerb(dep.id, "stop").catch(() => undefined);
        onStopped();
      }}
    >
      Confirm stop
    </button>
  );
}

export function ServePage() {
  const [deployments, setDeployments] = useState<DeploymentRecord[] | null>(null);
  const [recipes, setRecipes] = useState<RecipeRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [guardMessage, setGuardMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { deployments } = await listDeployments();
      setDeployments(deployments);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2500);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    void listRecipes()
      .then((d) => setRecipes(d.recipes))
      .catch(() => undefined);
  }, []);

  const verb = async (id: string, v: "start" | "stop" | "restart" | "probe") => {
    setError(null);
    setGuardMessage(null);
    try {
      await deploymentVerb(id, v);
    } catch (e) {
      const err = e as Error & { guard?: { reason?: string; code?: string } | null; status?: number };
      if (err.status === 409 && err.guard) {
        setGuardMessage(`Multi-node guard refused start (${err.guard.code}): ${err.guard.reason}`);
      } else {
        setError(err.message);
      }
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteDeployment(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const recipeOf = (dep: DeploymentRecord): RecipeRecord | undefined => recipes.find((r) => r.id === dep.recipeId);

  return (
    <>
      {(guardMessage || error) && (
        <div className="mb stack tight">
          {guardMessage && <Callout kind="warn" testId="guard-message">{guardMessage}</Callout>}
          <ErrorBanner error={error} />
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Deployments</h2>
          <span className="pill info"><span className="dot" />{deployments?.length ?? "…"}</span>
        </div>
        <TableScroller>
          <table className="table" data-testid="deployments-table">
            <thead>
              <tr>
                <th>Deployment</th>
                <th>State</th>
                <th>Endpoint</th>
                <ActionTh />
              </tr>
            </thead>
            <tbody>
              {(deployments ?? []).map((d) => {
                const recipe = recipeOf(d);
                return (
                  <tr key={d.id} data-testid={`dep-${d.id}`}>
                    <CellWith
                      title={recipe?.label ?? d.recipeId}
                      sub={`${d.sparkId} · entry ${d.entry ?? "?"} · desired ${d.desired}`}
                    />
                    <td><StatePill dep={d} /></td>
                    <td>
                      {d.port != null ? (
                        <code className="small">/llm/node/{d.sparkId}/{d.port}</code>
                      ) : (
                        <span className="hint">no port</span>
                      )}
                    </td>
                    <ActionTd>
                      <button className="btn sm primary" onClick={() => void verb(d.id, "start")}>Start</button>
                      <ArmedStop dep={d} onStopped={refresh} />
                      <button className="btn sm" onClick={() => void verb(d.id, "restart")}>Restart</button>
                      <button className="btn sm" onClick={() => void verb(d.id, "probe")}>Probe</button>
                      <button className="btn sm ghost" title="Remove deployment record" onClick={() => void remove(d.id)}>✕</button>
                    </ActionTd>
                  </tr>
                );
              })}
              {deployments && deployments.length === 0 && (
                <tr>
                  <td colSpan={4}><div className="empty">No deployments. Register and deploy a recipe from the Recipes page.</div></td>
                </tr>
              )}
            </tbody>
          </table>
        </TableScroller>
      </section>

      {(deployments ?? []).map((d) => (
        <section className="panel mt" key={`console-${d.id}`}>
          <div className="panel-head">
            <h3>{recipeOf(d)?.label ?? d.recipeId} — console</h3>
            <StatePill dep={d} />
          </div>
          <div className="panel-body stack tight">
            {d.lastProbe && (
              <div className="form-row">
                {Object.entries(d.lastProbe.ranks ?? {}).map(([k, v]) => (
                  <span key={k} className={`pill ${v === "running" ? "ok" : v === "absent" ? "info" : "crit"}`}>
                    <span className="dot" />{k}: {v}
                  </span>
                ))}
                {d.lastProbe.health != null && <span className="chip">HTTP {d.lastProbe.health}</span>}
              </div>
            )}
            <Console deployment={d} />
          </div>
        </section>
      ))}
    </>
  );
}
