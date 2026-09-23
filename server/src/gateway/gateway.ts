/**
 * Gateway proxy (M4/F4): `/v1/*` on the dashboard → engines via the
 * served-models router. Bearer-key client auth, alias resolution with
 * healthy-first fallback chains, upstream auth injection where the client's
 * own Authorization header wins, SSE pass-through.
 */
import { resolveRoute, type ServedModelConfig, type ServedModelTarget, type TargetHealth } from "./servedModels.js";

export interface GatewayTargetState {
  nodeId: string;
  port: number;
  /** lanIp of the node (proxy target host). */
  host: string | null;
  /** Observed deployment state ("healthy" | ... ) for ranking. */
  state: string;
}

export type HealthOf = (t: ServedModelTarget) => TargetHealth;

/** Map deployment observed states to router health grades. */
export function healthFromState(state: string | undefined): TargetHealth {
  if (state === "healthy" || state === "healthy-keyed") return "healthy";
  if (state === "starting" || state === "up") return "degraded";
  if (state === undefined) return "unknown";
  return "down";
}

export interface GatewayDeps {
  /** Alias configs (from ServedModelsStore.list()). */
  servedModels: ServedModelConfig[];
  clients: { verify(key: string): { name: string } | null } | null;
  /** Live per-target host/state lookup (from node directory + deployments). */
  targetState: (t: ServedModelTarget) => GatewayTargetState | null;
  fetchImpl?: typeof fetch;
  /** Default upstream Authorization injected when the client sends none. */
  upstreamAuth?: string | null;
  now?: () => number;
  /** Per-alias round-robin counters (mutated). */
  rrCounters?: Map<string, number>;
  /** Per-request hook (request recorder lands in its own task). */
  onAttempt?: (info: { alias: string; nodeId: string; port: number; status: number | null; error?: string; startedAt: number; endedAt: number }) => void;
}

export interface GatewayRequest {
  method: string;
  /** e.g. /v1/chat/completions */
  path: string;
  query?: string;
  headers: Record<string, string>;
  body?: string | null;
}

export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
  /** Which target served the request (for tracing). */
  servedBy: { nodeId: string; port: number } | null;
  /** All attempted targets in order (failover drill evidence). */
  attempts: Array<{ nodeId: string; port: number; status: number | null; error?: string }>;
}

function extractAlias(path: string, body: string | null | undefined): { alias: string | null; isModels: boolean } {
  if (path.endsWith("/models")) return { alias: null, isModels: true };
  // Chat-style APIs carry the model in the JSON body.
  try {
    const parsed = JSON.parse(body ?? "{}") as { model?: string };
    return { alias: typeof parsed.model === "string" ? parsed.model : null, isModels: false };
  } catch {
    return { alias: null, isModels: false };
  }
}

export async function handleGatewayRequest(deps: GatewayDeps, req: GatewayRequest): Promise<GatewayResponse> {
  const attempts: GatewayResponse["attempts"] = [];
  const fetchImpl = deps.fetchImpl ?? fetch;

  // 1. Client auth (HTTP clients must present a bearer key).
  if (deps.clients) {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const client = token ? deps.clients.verify(token) : null;
    if (!client) {
      return {
        status: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: { message: "invalid or missing API key", type: "auth" } }),
        servedBy: null,
        attempts,
      };
    }
  }

  // 2. Route resolution.
  const { alias, isModels } = extractAlias(req.path, req.body);
  if (isModels) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object: "list",
        data: deps.servedModels.map((m) => ({ id: m.alias, object: "model", owned_by: "controlcenter" })),
      }),
      servedBy: null,
      attempts,
    };
  }
  if (!alias) {
    return {
      status: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: { message: "missing model in request", type: "request" } }),
      servedBy: null,
      attempts,
    };
  }
  const rrCounters = deps.rrCounters ?? new Map<string, number>();
  const route = resolveRoute(deps.servedModels, alias, (t) => {
    const st = deps.targetState(t);
    return healthFromState(st?.state);
  }, rrCounters.get(alias) ?? 0);
  if ("error" in route) {
    const status = route.error === "unknown-alias" ? 404 : 409;
    return {
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: {
          message: route.error === "unknown-alias" ? `unknown model ${alias}` : `model ${alias} has no targets`,
          type: "routing",
          ...(route.error === "unknown-alias" ? { served: route.servedNames } : {}),
        },
      }),
      servedBy: null,
      attempts,
    };
  }
  rrCounters.set(alias, (rrCounters.get(alias) ?? 0) + 1);

  // 3. Try the chain in order; failover on network error or 5xx.
  const upstreamHeaders: Record<string, string> = {};
  if (req.headers["content-type"]) upstreamHeaders["content-type"] = req.headers["content-type"];
  // Client header wins over the injected upstream credential.
  upstreamHeaders.authorization = req.headers.authorization ?? deps.upstreamAuth ?? "";

  for (const target of route.chain) {
    const st = deps.targetState(target);
    if (!st?.host) {
      attempts.push({ nodeId: target.nodeId, port: target.port, status: null, error: "no lanIp" });
      continue;
    }
    const url = `http://${st.host}:${target.port}${req.path}${req.query ? `?${req.query}` : ""}`;
    const startedAt = deps.now?.() ?? Date.now();
    try {
      const upstream = await fetchImpl(url, {
        method: req.method,
        headers: upstreamHeaders,
        ...(req.method !== "GET" && req.method !== "HEAD" && req.body != null ? { body: req.body } : {}),
        signal: AbortSignal.timeout(300_000),
      });
      const endedAt = deps.now?.() ?? Date.now();
      const text = await upstream.text();
      attempts.push({ nodeId: target.nodeId, port: target.port, status: upstream.status });
      deps.onAttempt?.({ alias, nodeId: target.nodeId, port: target.port, status: upstream.status, startedAt, endedAt });
      const headers: Record<string, string> = {};
      for (const h of ["content-type", "cache-control"]) {
        const v = upstream.headers.get(h);
        if (v) headers[h] = v;
      }
      if (upstream.status >= 500) continue; // failover to the next target
      return { status: upstream.status, headers, body: text, servedBy: { nodeId: target.nodeId, port: target.port }, attempts };
    } catch (err) {
      const endedAt = deps.now?.() ?? Date.now();
      attempts.push({ nodeId: target.nodeId, port: target.port, status: null, error: err instanceof Error ? err.message : String(err) });
      deps.onAttempt?.({ alias, nodeId: target.nodeId, port: target.port, status: null, error: "unreachable", startedAt, endedAt });
    }
  }

  return {
    status: 502,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: { message: `no healthy upstream for ${alias}`, type: "routing", attempts } }),
    servedBy: null,
    attempts,
  };
}
