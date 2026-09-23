import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import type { AgentHubDeps } from "./agentHub.js";
import { registerAgentHub } from "./agentHub.js";
import { runInstallAgent, type BootstrapTransport } from "./bootstrap/installAgent.js";
import { runSsh } from "./transport/ssh.js";
import type { NodeDirectory } from "./nodeDirectory.js";
import { ModelctlService, NAS_TTL_MS, NODE_TTL_MS } from "./modelctl/service.js";
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

    // NAS store inventory (modelctl configured against the mounted store).
    app.get("/api/models", async () =>
      modelctl.inventory({ targetId: "nas", args: ["list", "--json"], ttlMs: NAS_TTL_MS }),
    );

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
          const result = await runSsh({ host, user }, `modelctl ${args.join(" ")}`, { timeoutMs: 120_000 });
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
            run: (script) => runSsh({ host: node.lanIp!, user: node.sshUser! }, script, { timeoutMs: 120_000 }),
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
