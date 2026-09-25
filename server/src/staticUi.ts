import { existsSync, createReadStream, statSync } from "node:fs";
import { join, resolve, sep, extname } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Serves the built web UI (`web/dist`) from the dashboard process so the
 * compose container is the whole product — UI + API + WS — with no dev
 * server needed (ADR-0009: the dashboard runs anywhere, browser included).
 *
 * Registered as the not-found handler: explicit API/WS/gateway routes always
 * win; anything else resolves to a file under webDist or falls back to
 * index.html (the UI is a single page with in-app navigation).
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Path prefixes owned by the API plane — their 404s stay JSON. */
const API_PREFIXES = ["/api", "/ws", "/v1", "/llm"];

export interface StaticUiOpts {
  /** Directory containing the built UI (index.html + assets/). */
  webDist: string;
}

export function registerStaticUi(app: FastifyInstance, opts: StaticUiOpts): void {
  const webDist = resolve(opts.webDist);
  const indexHtml = join(webDist, "index.html");
  const uiAvailable = existsSync(indexHtml);
  if (!uiAvailable) {
    app.log.warn(`[ui] ${indexHtml} not found — the dashboard serves API/WS only (build the web app to enable the UI)`);
  }

  const sendFile = (path: string, reply: FastifyReply): void => {
    const stat = statSync(path);
    const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
    void reply
      .code(200)
      .headers({
        "content-type": type,
        "content-length": String(stat.size),
        "cache-control": path === indexHtml ? "no-cache" : "public, max-age=31536000, immutable",
      })
      .send(createReadStream(path));
  };

  app.setNotFoundHandler((request, reply) => {
    const url = request.url.split("?")[0] ?? "/";
    const jsonNotFound = (): void => {
      void reply.code(404).send({ message: `Route ${request.method}:${url} not found`, error: "Not Found", statusCode: 404 });
    };
    if (!uiAvailable || request.method !== "GET" || API_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`))) {
      jsonNotFound();
      return;
    }
    // Extension-bearing paths are asset requests: never mask a miss with the SPA fallback.
    const hasExtension = extname(url) !== "";
    if (hasExtension) {
      const asset = resolve(join(webDist, url));
      if (asset === webDist || (asset.startsWith(webDist + sep) && existsSync(asset) && statSync(asset).isFile())) {
        sendFile(asset, reply);
        return;
      }
      jsonNotFound();
      return;
    }
    sendFile(indexHtml, reply);
  });
}
