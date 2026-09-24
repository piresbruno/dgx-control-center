/**
 * OpenAPI surface (M7): builds a spec skeleton from Fastify's route table
 * (collected via the onRoute hook). Full request/response schemas are not
 * auto-derived — the spec lists every path/method with tags so clients and
 * docs stay in sync with the real route table.
 */
import type { FastifyInstance } from "fastify";

export interface RouteEntry {
  method: string;
  url: string;
}

export function collectRoutes(app: FastifyInstance): RouteEntry[] {
  const routes: RouteEntry[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      routes.push({ method: method.toUpperCase(), url: route.url });
    }
  });
  return routes;
}

/** Build an OpenAPI 3 skeleton from collected routes. */
export function buildOpenApi(routes: RouteEntry[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    paths[r.url] ??= {};
    paths[r.url]![r.method.toLowerCase()] = {
      summary: `${r.method} ${r.url}`,
      tags: [tagFor(r.url)],
      responses: { "200": { description: "OK" } },
    };
  }
  return {
    openapi: "3.0.3",
    info: {
      title: "ControlCenter API",
      version: "0.1.0",
      description:
        "Control plane for a home LocalAI infrastructure: fleet telemetry, model plane, recipe serving, gateway, power/clock management, observability. Auth: dashboard routes are LAN-only by default; gateway /v1 routes require per-client bearer keys.",
    },
    servers: [{ url: "/" }],
    tags: [
      { name: "fleet" }, { name: "models" }, { name: "serving" }, { name: "gateway" },
      { name: "power" }, { name: "alerts" }, { name: "system" }, { name: "jobs" },
      { name: "llm" },
    ],
    paths,
  };
}

function tagFor(url: string): string {
  if (url.startsWith("/llm")) return "llm";
  if (url.startsWith("/v1")) return "gateway";
  if (url.startsWith("/api/power")) return "power";
  if (url.startsWith("/api/alerts")) return "alerts";
  if (url.startsWith("/api/gateway") || url.startsWith("/api/serve") || url.startsWith("/api/recipes") || url.startsWith("/api/models")) return "models";
  if (url.startsWith("/api/system") || url.startsWith("/api/metrics")) return "system";
  if (url.startsWith("/api/nodes") || url.startsWith("/api/jobs")) return "fleet";
  return "system";
}
