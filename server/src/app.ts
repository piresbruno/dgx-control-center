import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import type { AgentHubDeps } from "./agentHub.js";
import { registerAgentHub } from "./agentHub.js";
import { runInstallAgent, type BootstrapTransport } from "./bootstrap/installAgent.js";
import { runSsh } from "./transport/ssh.js";
import type { NodeDirectory } from "./nodeDirectory.js";
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
