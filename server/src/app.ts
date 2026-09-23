import Fastify from "fastify";
import type { AgentHubDeps } from "./agentHub.js";
import { registerAgentHub } from "./agentHub.js";
import { VERSION } from "@cc/shared";

export interface AppOptions {
  logger?: boolean;
  /** When provided, /agent-ws is live with these deps (real fleet or --fake-fleet). */
  agentHubDeps?: AgentHubDeps;
}

/**
 * Fastify app factory (ports-and-adapters: everything is injectable; the
 * entrypoint in index.ts owns listen). M0 ships the health contract only.
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

  return app;
}
