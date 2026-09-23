import Fastify from "fastify";
import { readFile } from "node:fs/promises";
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
import { VERSION } from "@cc/shared";

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
  /** Test seam: overrides the SSH run used by modelctl provisioning. */
  provisionTransport?: (script: string) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  /** SSH identity key passed to every node SSH call (CC_SSH_IDENTITY default). */
  sshIdentity?: string;
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
