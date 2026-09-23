import Fastify from "fastify";
import { VERSION } from "@cc/shared";

export interface AppOptions {
  logger?: boolean;
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

  return app;
}
