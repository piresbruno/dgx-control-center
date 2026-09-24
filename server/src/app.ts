import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { AgentHubDeps } from "./agentHub.js";
import { registerAgentHub } from "./agentHub.js";
import { runInstallAgent, type BootstrapTransport } from "./bootstrap/installAgent.js";
import { runSsh } from "./transport/ssh.js";
import { provisionModelctl, checkModelctl } from "./bootstrap/provisionModelctl.js";
import type { NodeDirectory } from "./nodeDirectory.js";
import { ModelctlService, NAS_TTL_MS, NODE_TTL_MS } from "./modelctl/service.js";
import { JobsManager } from "./jobs/jobsManager.js";
import { jobArgv } from "./jobs/commands.js";
import { RecipeStore, buildRecipeProbeCommand, parseRecipeProbe, validRecipePath } from "./serving/recipes.js";
import { DeploymentStore, DeploymentSupervisor, joinServeState, type DeploymentRecord } from "./serving/deployments.js";
import { checkMultiNode } from "./serving/multiNode.js";
import { ServedModelsStore, type ServedModelTarget } from "./gateway/servedModels.js";
import { ClientsStore } from "./gateway/clients.js";
import { handleGatewayRequest, healthFromState } from "./gateway/gateway.js";
import { TracesStore } from "./stores/tracesStore.js";
import { TraceQueries } from "./stores/traceQueries.js";
import { AlertsStore } from "./stores/alertsStore.js";
import { AlertRulesStore } from "./alerts/rules.js";
import { AlertEngine } from "./alerts/engine.js";
import { collectConfig, importConfig, createBackup, listBackups } from "./hardening/backup.js";
import { RequestRecorder } from "./gateway/recorder.js";
import { OnDemandManager } from "./gateway/onDemand.js";
import { CLOCK_PROFILES, profileById, resolveProfile } from "./power/profiles.js";
import type { ClockProfileStore } from "./power/clockStore.js";
import type { ScheduleStore } from "./power/schedules.js";
import type { FastifyRequest, FastifyReply } from "fastify";
import { VERSION } from "@cc/shared";

/** CSV field escaping: quotes, commas, newlines. */
function csv(value: string | null | undefined): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Prometheus label escaping. */
function prom(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Extract the requested model alias from a JSON request body. */
function bodyModel(body: string | null): string | null {
  try {
    const parsed = JSON.parse(body ?? "{}") as { model?: string };
    return typeof parsed.model === "string" ? parsed.model : null;
  } catch {
    return null;
  }
}

export interface AppOptions {
  logger?: boolean;
  /** When provided, /agent-ws is live with these deps (real fleet or --fake-fleet). */
  agentHubDeps?: AgentHubDeps;
  nodeDirectory?: NodeDirectory;
  agentBundlePath?: string;
  installHelloTimeoutMs?: number;
  /** Test seam: overrides the SSH run used by the install job. */
  installTransport?: BootstrapTransport;
  /** Model inventories (M2). Default: a real ModelctlService. */
  modelctl?: ModelctlService;
  /** Test seam: SSH runner for node modelctl calls (defaults to runSsh). */
  nodeInventoryRunner?: (host: string, user: string, args: string[]) => Promise<string>;
  /** Remote job tracking (M2). Default: a disconnected no-op manager. */
  jobsManager?: JobsManager;
  /** Serving recipe registry (M3). When set, /api/recipes routes go live. */
  recipeStore?: RecipeStore;
  /** Deployment records (M3). With recipeStore, /api/serve routes go live. */
  deploymentStore?: DeploymentStore;
  /** Test seam: overrides the serve supervisor. */
  serveSupervisor?: DeploymentSupervisor;
  /** Test seam: overrides the SSH run used by modelctl provisioning. */
  provisionTransport?: (script: string) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  /** SSH identity key passed to every node SSH call (CC_SSH_IDENTITY default). */
  sshIdentity?: string;
  /** Test seam: fetch used by /llm pass-through (defaults to global fetch). */
  llmFetch?: typeof fetch;
  /** Gateway traces (M4). With traceQueries, analysis + metrics go live. */
  tracesStore?: TracesStore;
  traceQueries?: TraceQueries;
  /** Served-model aliases (M4). With clients, the /v1 gateway goes live. */
  servedModelsStore?: ServedModelsStore;
  clientsStore?: ClientsStore;
  /** Default upstream Authorization injected when the client sends none. */
  upstreamAuth?: string | null;
  /** Desired clock profiles (M5). When set, /api/power/clocks routes go live. */
  clockStore?: ClockProfileStore;
  /** Desired-state store (M5): clock desires write through so the reconciler pushes config-update. */
  desiredStore?: import("./desiredState.js").DesiredStateStore;
  /** Thermal guard instance (owned by index.ts — its hooks dispatch jobs). */
  thermalGuard?: import("./power/thermal.js").ThermalGuard;
  /** Clock schedules (M5). */
  scheduleStore?: ScheduleStore;
  /** Energy accounting (M5). */
  energyStore?: import("./stores/energyStore.js").EnergyStore;
  /** Alerting (M6): stores + engine. When set, /api/alerts routes go live. */
  alertsStore?: AlertsStore;
  alertRulesStore?: AlertRulesStore;
  /** Fleet metric series (M6): query over the rollup tables. */
  metricsStore?: import("./stores/metricsStore.js").MetricsStore;
  /** Gateway 5xx %% over the rule window for the fleet-level source. */
  gateway5xxPct?: () => number | null;
  /** Hardening (M7): system backup/export surface. */
  systemDb?: import("better-sqlite3").Database;
  configDir?: string;
}

/**
 * Fastify app factory (ports-and-adapters: everything is injectable; the
 * entrypoint in index.ts owns listen).
 */
export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get("/api/health", async () => ({
    ok: true,
    name: "controlcenter",
    version: VERSION,
    time: new Date().toISOString(),
  }));

  if (opts.agentHubDeps) {
    app.decorate("agentRegistry", registerAgentHub(app, opts.agentHubDeps));
  }


// ── Alerting (M6/F5a) ──
const alertsStore = opts.alertsStore;
const alertRulesStore = opts.alertRulesStore;
if (alertsStore && alertRulesStore) {
  const engine = new AlertEngine({ alerts: alertsStore }, () => alertRulesStore.list());
  app.decorate("alertEngine", engine);

  app.get("/api/alerts/rules", async () => ({ rules: alertRulesStore.list() }));
  app.put("/api/alerts/rules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown> | null;
    if (!body) return reply.code(400).send({ error: "rule body required" });
    const result = alertRulesStore.upsert({ ...(body as object), id } as never);
    if ("error" in result) return reply.code(result.error.includes("read-only") ? 409 : 400).send({ error: result.error });
    return result;
  });
  app.delete("/api/alerts/rules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = alertRulesStore.remove(id);
    if (result === false) return reply.code(404).send({ error: "unknown rule" });
    if (typeof result === "object") return reply.code(409).send({ error: result.error });
    return { removed: true };
  });

  app.get("/api/alerts", async (request) => {
    const q = request.query as { state?: string; limit?: string };
    return { alerts: alertsStore.list({ state: q.state as never, limit: q.limit ? Number(q.limit) : undefined }) };
  });
  app.get("/api/alerts/events", async (request) => {
    const q = request.query as { alertId?: string; limit?: string };
    return { events: alertsStore.events({ alertId: q.alertId, limit: q.limit ? Number(q.limit) : undefined }) };
  });
  app.get("/api/alerts/history.csv", async (_request, reply) => {
    const rows = alertsStore.events({ limit: 5000 });
    const lines = ["ts,alertId,ruleId,kind,actor,note"];
    for (const e of rows) lines.push(`${e.ts},${e.alertId},${e.ruleId},${e.kind},${e.actor ?? ""},${(e.note ?? "").replace(/[",\n]/g, " ")}`);
    reply.header("content-type", "text/csv");
    return lines.join("\n") + "\n";
  });
  app.post("/api/alerts/:id/ack", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { by?: string } | null;
    if (!alertsStore.acknowledge(id, body?.by ?? "dashboard")) return reply.code(409).send({ error: "alert not firing" });
    return { acknowledged: true };
  });
  app.post("/api/alerts/:id/resolve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { note?: string } | null;
    if (!alertsStore.resolve(id, body?.note ?? null, false)) return reply.code(409).send({ error: "alert not open" });
    return { resolved: true };
  });
  app.post("/api/alerts/:id/mute", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { untilMs?: number } | null;
    if (!body?.untilMs || body.untilMs <= Date.now()) return reply.code(400).send({ error: "untilMs must be in the future" });
    if (!alertsStore.mute(id, body.untilMs, "dashboard")) return reply.code(404).send({ error: "unknown alert" });
    return { muted: true };
  });
  app.post("/api/alerts/:id/unmute", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!alertsStore.unmute(id)) return reply.code(404).send({ error: "unknown alert" });
    return { unmuted: true };
  });
}


      // ── System export/import/backup (M7) ──
  const configDir = opts.configDir ?? "config";
  const systemDb = opts.systemDb;
  if (systemDb) {
    app.get("/api/system/export", async () => collectConfig(configDir));
    app.post("/api/system/import", async (request, reply) => {
      const result = importConfig(configDir, request.body);
      if ("error" in result) return reply.code(400).send({ error: result.error });
      return reply.code(202).send(result); // takes effect on restart
    });
    app.post("/api/system/backup", async () => createBackup(configDir, systemDb));
    app.get("/api/system/backups", async () => ({ backups: listBackups(configDir) }));
  }

  const nodeDirectory = opts.nodeDirectory;
  if (nodeDirectory) {
    app.decorate("nodeDirectory", nodeDirectory);

    app.get("/api/nodes", async () => ({ nodes: nodeDirectory.list() }));
    const modelctl = opts.modelctl ?? new ModelctlService();
    app.decorate("modelctl", modelctl);

    const jobs = opts.jobsManager ?? new JobsManager({ send: () => false, isConnected: () => false });
    app.decorate("jobsManager", jobs);

    /** Dispatch a named job kind to a node's agent (argv resolved server-side). */
    app.post("/api/nodes/:id/jobs", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!nodeDirectory.get(id)) return reply.code(404).send({ error: "unknown node" });
      const body = request.body as { kind?: string; timeoutMs?: number; params?: unknown } | null;
      const argv = jobArgv(body?.kind ?? "", body?.params);
      if (!argv) return reply.code(400).send({ error: "unknown job kind or invalid params" });
      const result = jobs.dispatch(id, body!.kind!, argv, { timeoutMs: body?.timeoutMs });
      if ("error" in result) {
        const code = result.error === "conflict" ? 409 : 503;
        return reply.code(code).send({ error: result.error });
      }
      return reply.code(202).send({ reqId: result.reqId });
    });

    app.get("/api/jobs", async (request) => {
      const query = request.query as { nodeId?: string; active?: string };
      return { jobs: jobs.list({ nodeId: query.nodeId, active: query.active === "1" }) };
    });

    app.get("/api/jobs/:reqId", async (request, reply) => {
      const { reqId } = request.params as { reqId: string };
      const job = jobs.get(reqId);
      if (!job) return reply.code(404).send({ error: "unknown job" });
      return job;
    });

    // ── Serving recipes (M3, ADR-0005: recipes stay user-owned) ──
    const recipeStore = opts.recipeStore;
    const deploymentStore = opts.deploymentStore;
    const supervisor =
      recipeStore && deploymentStore
        ? (opts.serveSupervisor ??
          new DeploymentSupervisor({
            jobs,
            recipes: {
              // RecipeRecord.meta is optional (zod default) — normalize to the
              // supervisor's required shape.
              get: (id: string) => {
                const r = recipeStore.get(id);
                return r ? { ...r, meta: r.meta ?? null, versions: r.versions ?? null } : null;
              },
            },
            store: deploymentStore,
          }))
        : null;
    if (supervisor) app.decorate("serveSupervisor", supervisor);
    if (recipeStore) {
      app.decorate("recipeStore", recipeStore);
      // Probe jobs are dispatched here; when one finishes, its stdout is the
      // marker-delimited probe output → parse → merge into the store.
      const probeJobs = new Map<string, string>(); // reqId → recipeId
      jobs.onFinished((job) => {
        const recipeId = probeJobs.get(job.reqId);
        if (!recipeId) return;
        probeJobs.delete(job.reqId);
        recipeStore.updateFromProbe(recipeId, parseRecipeProbe(job.output));
      });

      app.get("/api/recipes", async () => ({ recipes: recipeStore.list() }));

      app.get("/api/recipes/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        const recipe = recipeStore.get(id);
        if (!recipe) return reply.code(404).send({ error: "unknown recipe" });
        return recipe;
      });

      /** Shared register-or-refresh flow: record in store, dispatch one probe. */
      const dispatchProbe = (nodeId: string, recipeId: string, recipePath: string) =>
        jobs.dispatch(nodeId, "recipe-probe", ["bash", "-c", buildRecipeProbeCommand(recipePath)], {
          timeoutMs: 30_000,
        });

      app.post("/api/recipes", async (request, reply) => {
        const body = request.body as { nodeId?: string; path?: string; label?: string; entry?: string } | null;
        const nodeId = body?.nodeId ?? "";
        const p = body?.path ?? "";
        if (!nodeId || !validRecipePath(p)) {
          return reply.code(400).send({ error: "nodeId and absolute path are required" });
        }
        const node = nodeDirectory.get(nodeId);
        if (!node) return reply.code(404).send({ error: "unknown node" });
        if (node.kind === "nas") {
          return reply.code(400).send({ error: "NAS nodes do not host serving recipes" });
        }
        const { recipe, created } = recipeStore.register({ sparkId: nodeId, path: p, label: body?.label ?? null });
        if (body?.entry) recipeStore.setEntry(recipe.id, body.entry);
        const result = dispatchProbe(nodeId, recipe.id, recipe.path);
        if ("error" in result) {
          // A re-registered folder may still have its first probe running —
          // that probe already merges into this record, so accept it.
          if (result.error === "conflict" && !created) {
            return reply.code(202).send({ recipe });
          }
          recipeStore.updateFromProbe(recipe.id, {
            ok: false,
            error: result.error,
            meta: null,
            versions: null,
            files: [],
            verbs: [],
          });
          const code = result.error === "conflict" ? 409 : 503;
          return reply.code(code).send({ error: result.error, recipe });
        }
        probeJobs.set(result.reqId, recipe.id);
        return reply.code(created ? 201 : 202).send({ recipe, jobId: result.reqId });
      });

      /** Re-probe (refresh meta + drift detection). */
      app.post("/api/recipes/:id/probe", async (request, reply) => {
        const { id } = request.params as { id: string };
        const recipe = recipeStore.get(id);
        if (!recipe) return reply.code(404).send({ error: "unknown recipe" });
        const result = dispatchProbe(recipe.sparkId, recipe.id, recipe.path);
        if ("error" in result) {
          const code = result.error === "conflict" ? 409 : 503;
          return reply.code(code).send({ error: result.error });
        }
        probeJobs.set(result.reqId, recipe.id);
        return reply.code(202).send({ jobId: result.reqId });
      });

      app.delete("/api/recipes/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        if (!recipeStore.remove(id)) return reply.code(404).send({ error: "unknown recipe" });
        return { removed: true };
      });
    }

    // ── Serve deployments (M3) ──
    if (recipeStore && deploymentStore && supervisor) {

      /** Observed state join for one deployment (pure factors from stores). */
      const stateOf = (d: DeploymentRecord) => {
        const recipe = recipeStore.get(d.recipeId);
        const job = d.jobId ? (jobs.get(d.jobId) ?? null) : null;
        const meta = (recipe?.meta ?? null) as { servedName?: string | null; nnodes?: number; workerIp?: string | null; headIp?: string | null } | null;
        const probeParsedAt = d.lastProbe?.parsedAt ?? null;
        // Jobs are in-memory: after a dashboard restart the record survives but
        // the job record doesn't — fall back to updatedAt as the stale marker.
        const staleRef = job?.endedAt ?? d.updatedAt;
        const probeStale = probeParsedAt != null && probeParsedAt < staleRef;
        return joinServeState({
          desired: d.desired,
          orphaned: recipe?.orphaned ?? false,
          job: job ? { state: job.state, exitCode: job.exitCode } : null,
          probe: d.lastProbe,
          probeStale,
          ranks: d.lastProbe?.ranks ?? null,
          servedName: meta?.servedName ?? null,
        });
      };

      app.get("/api/serve/deployments", async () => ({
        deployments: deploymentStore.list().map((d) => ({ ...d, state: stateOf(d) })),
      }));

      app.get("/api/serve/deployments/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        const d = deploymentStore.get(id);
        if (!d) return reply.code(404).send({ error: "unknown deployment" });
        return { ...d, state: stateOf(d) };
      });

      /** Create (or reuse) the single deployment slot for a recipe. */
      app.post("/api/serve/deployments", async (request, reply) => {
        const body = request.body as { recipeId?: string; entry?: string; port?: number; servedName?: string } | null;
        const recipe = body?.recipeId ? recipeStore.get(body.recipeId) : null;
        if (!recipe) return reply.code(404).send({ error: "unknown recipe" });
        if (recipe.orphaned) return reply.code(409).send({ error: "recipe is orphaned (node removed)" });
        const meta = (recipe.meta ?? null) as { port?: number | null; servedName?: string | null; entry?: string | null } | null;
        const d = deploymentStore.upsertForRecipe(recipe.id, {
          sparkId: recipe.sparkId,
          entry: body?.entry ?? meta?.entry ?? recipe.entry,
          port: body?.port ?? meta?.port ?? null,
          servedName: body?.servedName ?? meta?.servedName ?? null,
        });
        return reply.code(201).send({ ...d, state: stateOf(d) });
      });

      /** Shared verb dispatch with error mapping. */
      const verbRoute = (verb: "start" | "stop" | "restart" | "probe") => async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const { id } = request.params;
        const d = deploymentStore.get(id);
        if (!d) return reply.code(404).send({ error: "unknown deployment" });
        if (verb === "start") {
          const recipe = recipeStore.get(d.recipeId);
          const meta = (recipe?.meta ?? null) as { nnodes?: number; workerIp?: string | null; headIp?: string | null } | null;
          const guard = checkMultiNode(
            { nnodes: meta?.nnodes ?? 1, workerIp: meta?.workerIp ?? null, headIp: meta?.headIp ?? null },
            nodeDirectory.list().map((n) => ({ id: n.id, lanIp: n.lanIp ?? null, kind: n.kind, role: n.role })),
          );
          if (!guard.ok) return reply.code(409).send({ error: "multi-node guard refused start", guard });
        }
        const result = supervisor[verb](id);
        if ("error" in result) {
          const isConflict = result.error === "conflict";
          return reply.code(isConflict ? 409 : 503).send({ error: result.error });
        }
        return reply.code(202).send({ reqId: result.reqId });
      };

      app.post("/api/serve/deployments/:id/start", verbRoute("start"));
      app.post("/api/serve/deployments/:id/stop", verbRoute("stop"));
      app.post("/api/serve/deployments/:id/restart", verbRoute("restart"));
      app.post("/api/serve/deployments/:id/probe", verbRoute("probe"));

      app.delete("/api/serve/deployments/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        if (!deploymentStore.remove(id)) return reply.code(404).send({ error: "unknown deployment" });
        return { removed: true };
      });
    }

    /** Cancel a running job: job-kill to the agent, record marked failed. */
    app.post("/api/jobs/:reqId/cancel", async (request, reply) => {
      const { reqId } = request.params as { reqId: string };
      const job = jobs.get(reqId);
      if (!job) return reply.code(404).send({ error: "unknown job" });
      if (job.state !== "running") return reply.code(409).send({ error: `job already ${job.state}` });
      jobs.cancel(reqId);
      return { reqId, state: "failed", reason: "cancelled" };
    });

    // NAS store inventory (modelctl configured against the mounted store).
    app.get("/api/models", async () =>
      modelctl.inventory({ targetId: "nas", args: ["list", "--json"], ttlMs: NAS_TTL_MS }),
    );

    /** Validate modelctl on a node (doctor check, installs nothing). */
    app.get("/api/nodes/:id/modelctl-check", async (request, reply) => {
      const { id } = request.params as { id: string };
      const node = nodeDirectory.get(id);
      if (!node) return reply.code(404).send({ error: "unknown node" });
      if (!node.lanIp || !node.sshUser) {
        return reply.code(400).send({ error: "node lacks lanIp or sshUser — set them in Edit node" });
      }
      const transport =
        opts.provisionTransport ??
        ((script: string) =>
          runSsh({ host: node.lanIp!, user: node.sshUser! }, script, { timeoutMs: 30_000, identityPath: opts.sshIdentity }));
      return checkModelctl({ host: node.lanIp, user: node.sshUser }, { transport });
    });

    /** Install/repair modelctl + uv on a node (bootstrap/repair per ADR-0002). */
    app.post("/api/nodes/:id/provision-modelctl", async (request, reply) => {
      const { id } = request.params as { id: string };
      const node = nodeDirectory.get(id);
      if (!node) return reply.code(404).send({ error: "unknown node" });
      if (!node.lanIp || !node.sshUser) {
        return reply.code(400).send({ error: "node lacks lanIp or sshUser — set them in Edit node" });
      }
      const transport =
        opts.provisionTransport ??
        ((script: string) =>
          runSsh({ host: node.lanIp!, user: node.sshUser! }, script, { timeoutMs: 300_000, identityPath: opts.sshIdentity }));
      return provisionModelctl({ host: node.lanIp, user: node.sshUser }, { transport });
    });

    /** Node-local cache inventory over SSH (modelctl runs on the node). */
    app.get("/api/nodes/:id/models", async (request, reply) => {
      const { id } = request.params as { id: string };
      const node = nodeDirectory.get(id);
      if (!node) return reply.code(404).send({ error: "unknown node" });
      if (!node.lanIp || !node.sshUser) {
        return reply.code(400).send({ error: "node lacks lanIp or sshUser — set them in Edit node" });
      }
      const runNode =
        opts.nodeInventoryRunner ??
        (async (host: string, user: string, args: string[]): Promise<string> => {
          const result = await runSsh({ host, user }, `export PATH="$HOME/.local/bin:$PATH"; modelctl ${args.join(" ")}`, {
            timeoutMs: 120_000,
            identityPath: opts.sshIdentity,
          });
          if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `modelctl exited ${result.exitCode}`);
          return result.stdout;
        });
      const runner = (args: string[]): Promise<string> => runNode(node.lanIp!, node.sshUser!, args);
      return modelctl.inventory({ targetId: `node:${id}`, args: ["list", "--local", "--json"], ttlMs: NODE_TTL_MS, runner });
    });

    // ── Per-deployment pass-through (M3): proxy to a node's engine port ──
    const llmFetch = opts.llmFetch ?? fetch;
    app.all("/llm/node/:id/:port/*", async (request, reply) => {
      const { id, port } = request.params as { id: string; port: string };
      const node = nodeDirectory.get(id);
      if (!node) return reply.code(404).send({ error: "unknown node" });
      if (!node.lanIp) return reply.code(400).send({ error: "node lacks lanIp" });
      const portNum = Number(port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        return reply.code(400).send({ error: "invalid port" });
      }
      const rest = (request.params as Record<string, string>)["*"] ?? "";
      const search = new URL(request.url, "http://internal").search;
      const upstreamUrl = `http://${node.lanIp}:${portNum}/${rest}${search}`;
      const headers: Record<string, string> = {};
      const contentType = request.headers["content-type"];
      if (typeof contentType === "string") headers["content-type"] = contentType;
      const auth = request.headers.authorization;
      if (typeof auth === "string") headers.authorization = auth;
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      let upstream: Response;
      try {
        upstream = await llmFetch(upstreamUrl, {
          method: request.method,
          headers,
          ...(hasBody ? { body: JSON.stringify(request.body ?? null) } : {}),
          signal: AbortSignal.timeout(300_000),
        });
      } catch (err) {
        return reply.code(502).send({ error: `upstream unreachable: ${err instanceof Error ? err.message : err}` });
      }
      const outHeaders: Record<string, string> = {};
      for (const h of ["content-type", "cache-control"]) {
        const v = upstream.headers.get(h);
        if (v) outHeaders[h] = v;
      }
      reply.code(upstream.status).headers(outHeaders);
      if (upstream.body) {
        return reply.send(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream));
      }
      return reply.send();
    });

  // ── Fleet metric series (M6): rollup query with auto granularity ──
  const metricsStore = opts.metricsStore;
  if (metricsStore) {
    app.get("/api/metrics/fleet", async (request) => {
      const q = request.query as { domain?: string; leaf?: string; hours?: string; node?: string };
      const domain = q.domain ?? "gpu";
      const hours = Math.max(1, Number(q.hours ?? "24"));
      const granularity = hours <= 6 ? "1m" : hours <= 24 * 30 ? "1h" : "1d";
      const from = Date.now() - hours * 3_600_000;
      const rows = metricsStore.query(domain, { from, to: Date.now(), granularity, node: q.node || undefined });
      const leaf = q.leaf;
      const perNode = new Map<string, Array<{ t: number; v: number }>>();
      for (const r of rows) {
        const series = perNode.get(r.nodeId) ?? [];
        const candidates = leaf
          ? [r.data.avg[leaf]]
          : Object.values(r.data.avg).filter((v) => typeof v === "number");
        const v = candidates.find((x) => typeof x === "number") ?? null;
        if (v != null) series.push({ t: r.bucket, v });
        perNode.set(r.nodeId, series);
      }
      return {
        domain,
        granularity,
        hours,
        series: [...perNode.entries()].map(([nodeId, points]) => ({ nodeId, points })),
      };
    });
  }

// ── Gateway /v1 + analysis surface (M4) ──
    const servedModelsStore = opts.servedModelsStore;
    const clientsStore = opts.clientsStore;
    const traces = opts.tracesStore;
    const traceQueries = opts.traceQueries;
    if (servedModelsStore) {
      const rrCounters = new Map<string, number>();
      /** Live host + observed state for a router target. */
      const targetState = (t: ServedModelTarget) => {
        const node = nodeDirectory.get(t.nodeId);
        const dep = deploymentStore?.list().find((d) => d.sparkId === t.nodeId && d.port === t.port) ?? null;
        const state = dep
          ? joinServeState({
              desired: dep.desired,
              orphaned: recipeStore?.get(dep.recipeId)?.orphaned ?? false,
              job: dep.jobId ? (jobs.get(dep.jobId) ?? null) : null,
              probe: dep.lastProbe,
              ranks: dep.lastProbe?.ranks ?? null,
              servedName: (recipeStore?.get(dep.recipeId)?.meta as { servedName?: string | null } | null)?.servedName ?? null,
            }).state
          : undefined;
        return { nodeId: t.nodeId, port: t.port, host: node?.lanIp ?? null, state };
      };

      const onDemand =
        deploymentStore && supervisor
          ? new OnDemandManager({ servedModels: servedModelsStore, deployments: deploymentStore, supervisor })
          : null;
      app.decorate("onDemand", onDemand);

      app.all("/v1/*", async (request, reply) => {
        const rest = (request.params as Record<string, string>)["*"] ?? "";
        const body = typeof request.body === "string" ? request.body : request.body != null ? JSON.stringify(request.body) : null;
        const recorder = new RequestRecorder();
        let clientName: string | null = null;
        const res = await handleGatewayRequest(
          {
            servedModels: servedModelsStore.list(),
            clients: clientsStore
              ? {
                  verify: (k: string) => {
                    const c = clientsStore.verify(k);
                    if (c) clientName = c.name;
                    return c;
                  },
                }
              : null,
            targetState,
            rrCounters,
            upstreamAuth: opts.upstreamAuth ?? null,
            onResponseChunk: (chunk, atMs) => recorder.chunk(chunk, atMs),
            ensureOnDemand: onDemand ? (a: string) => onDemand.ensureUp(a).then((r) => r.ok) : undefined,
            warmupTimeoutMs: 120_000,
          },
          {
            method: request.method,
            path: `/v1/${rest}`,
            query: new URL(request.url, "http://internal").search.replace(/^\?/, "") || undefined,
            headers: {
              ...(typeof request.headers.authorization === "string" ? { authorization: request.headers.authorization } : {}),
              ...(typeof request.headers["content-type"] === "string" ? { "content-type": request.headers["content-type"] } : {}),
            },
            body,
          },
        );
        if (onDemand) onDemand.touch(bodyModel(body) ?? "");
        if (traces) {
          const trace = recorder.finish({
            ts: Date.now(),
            client: clientName,
            alias: bodyModel(body) ?? "unknown",
            model: null,
            nodeId: res.servedBy?.nodeId ?? null,
            port: res.servedBy?.port ?? null,
            status: res.status,
            contentType: res.headers["content-type"] ?? null,
            attempts: res.attempts,
            error: res.status >= 400 ? res.body?.slice(0, 200) : null,
          });
          traces.insert(trace);
          void traces.prune();
        }
        reply.code(res.status).headers(res.headers);
        return res.body ?? "";
      });

      // Router editor surface.
      app.get("/api/gateway/served-models", async () => ({ models: servedModelsStore.list() }));
      app.post("/api/gateway/served-models", async (request, reply) => {
        const body = request.body as { id?: string; alias?: string; targets?: ServedModelTarget[]; onDemand?: { recipeId: string; idleStopS?: number } | null } | null;
        if (!body?.alias) return reply.code(400).send({ error: "alias is required" });
        try {
          const rec = servedModelsStore.upsert({
            id: body.id,
            alias: body.alias,
            targets: body.targets ?? [],
            onDemand: body.onDemand ?? null,
          });
          return reply.code(201).send(rec);
        } catch (err) {
          return reply.code(409).send({ error: err instanceof Error ? err.message : "upsert failed" });
        }
      });
      app.delete("/api/gateway/served-models/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        if (!servedModelsStore.remove(id)) return reply.code(404).send({ error: "unknown served model" });
        return { removed: true };
      });

      // Clients & keys management.
      if (clientsStore) {
        app.get("/api/gateway/clients", async () => ({ clients: clientsStore.list() }));
        app.post("/api/gateway/clients", async (request, reply) => {
          const body = request.body as { name?: string; scopes?: string[] } | null;
          if (!body?.name) return reply.code(400).send({ error: "name is required" });
          const { client, key } = clientsStore.create({ name: body.name, scopes: body.scopes });
          return reply.code(201).send({ client, key }); // key shown exactly once
        });
        app.post("/api/gateway/clients/:id/revoke", async (request, reply) => {
          const { id } = request.params as { id: string };
          if (!clientsStore.revoke(id)) return reply.code(404).send({ error: "unknown or already revoked" });
          return { revoked: true };
        });
        app.delete("/api/gateway/clients/:id", async (request, reply) => {
          const { id } = request.params as { id: string };
          if (!clientsStore.remove(id)) return reply.code(404).send({ error: "unknown client" });
          return { removed: true };
        });
      }
    }

    // Analysis + export (needs traces).
    if (traces && traceQueries) {
      app.get("/api/analysis/summary", async (request) => {
        const windowHours = Number((request.query as { windowHours?: string }).windowHours ?? "24");
        const since = Date.now() - windowHours * 3600_000;
        return {
          windowHours,
          kpis: traceQueries.kpis(since),
          byClient: traceQueries.byClient(since),
          byAlias: traceQueries.byAlias(since),
          byDeployment: traceQueries.byDeployment(since),
          byHour: traceQueries.byHour(since),
        };
      });
      app.get("/api/analysis/traces", async (request) => {
        const q = request.query as { alias?: string; client?: string; limit?: string };
        return { traces: traces.list({ alias: q.alias, limit: q.limit ? Number(q.limit) : undefined }) };
      });
      app.get("/api/analysis/export.csv", async (request, reply) => {
        const q = request.query as { alias?: string; since?: string; limit?: string };
        const rows = traces.list({ alias: q.alias, since: q.since ? Number(q.since) : undefined, limit: 1000 });
        const cols = ["id", "ts", "client", "alias", "model", "nodeId", "port", "status", "ttftMs", "durationMs", "stream", "promptTokens", "completionTokens", "error"];
        const lines = [cols.join(",")];
        for (const t of rows) {
          lines.push(
            [
              t.id, t.ts, csv(t.client), csv(t.alias), csv(t.model), csv(t.nodeId), t.port ?? "", t.status ?? "",
              t.ttftMs ?? "", t.durationMs, t.stream ? "1" : "0", t.promptTokens ?? "", t.completionTokens ?? "",
            ].join(","),
          );
        }
        reply.header("content-type", "text/csv");
        return lines.join("\n") + "\n";
      });

      app.get("/api/metrics/prometheus", async (request) => {
        const windowHours = Number((request.query as { windowHours?: string }).windowHours ?? "24");
        const since = Date.now() - windowHours * 3600_000;
        const out: string[] = [];
        out.push("# TYPE cc_gateway_requests_total counter");
        for (const r of [...traceQueries.byClient(since)]) {
          out.push(`cc_gateway_requests_total{client="${prom(r.key)}"} ${r.requests}`);
        }
        for (const r of traceQueries.byAlias(since)) {
          out.push(`cc_gateway_requests_total{alias="${prom(r.key)}"} ${r.requests}`);
        }
        out.push("# TYPE cc_gateway_tokens_total counter");
        const k = traceQueries.kpis(since);
        out.push(`cc_gateway_prompt_tokens_total ${k.promptTokens}`);
        out.push(`cc_gateway_completion_tokens_total ${k.completionTokens}`);
        out.push("# TYPE cc_gateway_ttft_ms gauge");
        out.push(`cc_gateway_ttft_p50_ms ${k.ttftP50Ms ?? "NaN"}`);
        out.push(`cc_gateway_ttft_p95_ms ${k.ttftP95Ms ?? "NaN"}`);
        return out.join("\n") + "\n";
      });
    }

    // ── Power & clocks (M5): profile registry + desired state ──
    const clockStore = opts.clockStore;
    if (clockStore) {
      app.decorate("thermalGuard", opts.thermalGuard ?? null);
      const thermal = opts.thermalGuard;
      app.decorate("clockStore", clockStore);

      app.get("/api/power/profiles", async () => ({ profiles: CLOCK_PROFILES }));

      app.get("/api/power/clocks", async () => ({
        clocks: nodeDirectory
          .list()
          .filter((n) => n.kind === "spark")
          .map((n) => {
            const desire = clockStore.desiredFor(n.id);
            const profile = profileById(desire.profile);
            return {
              sparkId: n.id,
              desired: desire.profile,
              resolved: profile ? resolveProfile(profile, null) : null,
              updatedAt: desire.updatedAt,
            };
          }),
      }));

      // Clock schedules (per-node timezone windows).
      const scheduleStore = opts.scheduleStore;
      if (scheduleStore) {
        app.decorate("scheduleStore", scheduleStore);
        app.get("/api/power/schedules", async () => ({ schedules: scheduleStore.list() }));
        app.put("/api/power/schedules/:sparkId", async (request, reply) => {
          const { sparkId } = request.params as { sparkId: string };
          if (!nodeDirectory.get(sparkId)) return reply.code(404).send({ error: "unknown node" });
          const body = request.body as { tz?: string; rules?: Array<{ profileId: string; start: string; end: string }> } | null;
          if (!body?.tz || !Array.isArray(body.rules)) return reply.code(400).send({ error: "tz and rules are required" });
          const rec = scheduleStore.set(sparkId, body.tz, body.rules);
          if (!rec) return reply.code(400).send({ error: "invalid timezone or rules" });
          return rec;
        });
        app.delete("/api/power/schedules/:sparkId", async (request, reply) => {
          const { sparkId } = request.params as { sparkId: string };
          if (!scheduleStore.remove(sparkId)) return reply.code(404).send({ error: "no schedule for node" });
          return { removed: true };
        });
      }

      // Energy accounting (kWh + cost from the 1m power leaves).
      const energyStore = opts.energyStore;
      if (energyStore) {
        app.get("/api/power/energy", async (request) => {
          const q = request.query as { windowHours?: string; nodeId?: string };
          const windowHours = Number(q.windowHours ?? "168");
          return {
            windowHours,
            ...energyStore.summary(Date.now() - windowHours * 3_600_000, q.nodeId || null),
          };
        });
      }

      app.get("/api/power/thermal", async () => ({
        nodes: nodeDirectory
          .list()
          .filter((n) => n.kind === "spark")
          .map((n) => ({ sparkId: n.id, state: thermal?.stateFor(n.id) ?? "nominal" })),
        events: thermal?.events().slice(0, 50) ?? [],
      }));

      /** Set the desired profile — spark nodes only (409 otherwise). */
      app.put("/api/power/clocks/:sparkId", async (request, reply) => {
        const { sparkId } = request.params as { sparkId: string };
        const node = nodeDirectory.get(sparkId);
        if (!node) return reply.code(404).send({ error: "unknown node" });
        if (node.kind !== "spark") {
          return reply.code(409).send({ error: "clock control is spark-only", kind: node.kind });
        }
        const body = request.body as { profile?: string } | null;
        const rec = body?.profile ? clockStore.set(sparkId, body.profile) : null;
        if (!rec) return reply.code(400).send({ error: "unknown profile" });
        await opts.desiredStore?.patch(sparkId, { clockProfileId: rec.profile });
        const profile = profileById(rec.profile)!;
        return { sparkId, desired: rec.profile, resolved: resolveProfile(profile, null) };
      });
    }

    if (opts.agentHubDeps) {
      const hubDeps = opts.agentHubDeps;
      const registry = app.agentRegistry;
      if (!registry) throw new Error("agentHubDeps provided but hub not registered");
      const bundlePath = opts.agentBundlePath ?? "agent/dist/agent.mjs";
      const helloTimeoutMs = opts.installHelloTimeoutMs ?? 60_000;

      app.post("/api/nodes/:id/install-agent", async (request, reply) => {
        const { id } = request.params as { id: string };
        const node = nodeDirectory.get(id);
        if (!node) return reply.code(404).send({ error: "unknown node" });
        if (!node.lanIp || !node.sshUser) {
          return reply.code(400).send({ error: "node lacks lanIp or sshUser — set them in Edit node" });
        }
        const bundle = await readFile(bundlePath, "utf8").catch(() => null);
        if (bundle === null) {
          return reply.code(500).send({ error: `agent bundle not found: ${bundlePath} (run npm run build:agent)` });
        }

        const transport: BootstrapTransport =
          opts.installTransport ?? {
            run: (script) => runSsh({ host: node.lanIp!, user: node.sshUser! }, script, { timeoutMs: 120_000, identityPath: opts.sshIdentity }),
          };
        const waitHello = async (sparkId: string, timeoutMs: number): Promise<boolean> => {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            if (registry.isConnected(sparkId)) return true;
            if (Date.now() >= deadline) return false;
            await new Promise((r) => setTimeout(r, 250));
          }
        };

        const dashboardUrl = `http://${request.headers.host ?? "localhost:5566"}`;
        const outcome = await runInstallAgent(
          { host: node.lanIp, user: node.sshUser },
          { sparkId: id, dashboardUrl, token: hubDeps.agentToken(), agentBundle: bundle, sshUser: node.sshUser },
          { transport, waitHello, helloTimeoutMs },
        );
        return reply.send(outcome);
      });
    }
  }

  return app;
}
