import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { handleGatewayRequest, healthFromState, type GatewayDeps } from "./gateway.js";
import type { ServedModelConfig } from "./servedModels.js";

async function engine(responses: Array<{ status?: number; body?: string; fail?: boolean }>) {
  const seen: Array<{ auth: string | null; path: string }> = [];
  let i = 0;
  const server: Server = createServer((req, res) => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    seen.push({ auth: req.headers.authorization ?? null, path: req.url ?? "" });
    if (r.fail) {
      res.destroy();
      return;
    }
    res.writeHead(r.status ?? 200, { "content-type": "application/json" });
    res.end(r.body ?? "{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port, seen };
}

function baseDeps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  const configs: ServedModelConfig[] = [
    { id: "sm-1", alias: "glm", targets: [{ nodeId: "a", port: 1 }, { nodeId: "b", port: 2 }], onDemand: null, createdAt: 1, updatedAt: 1 },
  ];
  return {
    servedModels: configs,
    clients: null,
    targetState: (t) => ({ nodeId: t.nodeId, port: t.port, host: "127.0.0.1", state: "healthy" }),
    ...overrides,
  };
}

describe("gateway proxy", () => {
  it("401s without a valid bearer key when clients are enforced", async () => {
    const verifier = { verify: (k: string) => (k === "cc-good" ? { id: "c1", name: "x" } : null) };
    const res = await handleGatewayRequest(baseDeps({ clients: verifier }), {
      method: "POST",
      path: "/v1/chat/completions",
      headers: {},
      body: JSON.stringify({ model: "glm" }),
    });
    expect(res.status).toBe(401);
    const ok = await handleGatewayRequest(baseDeps({ clients: verifier }), {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { authorization: "Bearer cc-good" },
      body: JSON.stringify({ model: "glm" }),
    });
    expect(ok.status).not.toBe(401);
  });

  it("lists served aliases on /v1/models", async () => {
    const res = await handleGatewayRequest(baseDeps(), { method: "GET", path: "/v1/models", headers: {} });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!).data.map((m: { id: string }) => m.id)).toEqual(["glm"]);
  });

  it("404s unknown aliases with the served list", async () => {
    const res = await handleGatewayRequest(baseDeps(), {
      method: "POST",
      path: "/v1/chat/completions",
      headers: {},
      body: JSON.stringify({ model: "nope" }),
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body!).error.served).toEqual(["glm"]);
  });

  it("fails over to the second target when the first is unreachable", async () => {
    const down = await engine([{ fail: true }]);
    const up = await engine([{ status: 200, body: '{"ok":true}' }]);
    const res = await handleGatewayRequest(
      baseDeps({
        servedModels: [
          {
            id: "sm-f",
            alias: "glm",
            targets: [
              { nodeId: "a", port: down.port },
              { nodeId: "b", port: up.port },
            ],
            onDemand: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        targetState: (t) => ({ nodeId: t.nodeId, port: t.port, host: "127.0.0.1", state: "healthy" }),
      }),
      { method: "POST", path: "/v1/chat/completions", headers: {}, body: JSON.stringify({ model: "glm" }) },
    ).finally(() => {
      down.server.close();
      up.server.close();
    });
    expect(res.status).toBe(200);
    expect(res.servedBy).toEqual({ nodeId: "b", port: up.port });
    expect(res.attempts).toHaveLength(2);
    expect(res.attempts[0]).toMatchObject({ nodeId: "a", error: expect.any(String) });
    expect(res.attempts[1]).toMatchObject({ nodeId: "b", status: 200 });
  });

  it("injects upstream auth unless the client sent their own (client header wins)", async () => {
    const e1 = await engine([{ status: 200, body: "{}" }]);
    const deps = baseDeps({
      targetState: (t) => ({ nodeId: t.nodeId, port: t.port, host: "127.0.0.1", state: "healthy" }),
      // Both targets map to the same fake engine for this assertion.
      servedModels: [
        { id: "s", alias: "glm", targets: [{ nodeId: "a", port: e1.port }], onDemand: null, createdAt: 1, updatedAt: 1 },
      ],
      upstreamAuth: "Bearer upstream-secret",
    });
    const injected = await handleGatewayRequest(deps, { method: "POST", path: "/v1/chat/completions", headers: {}, body: JSON.stringify({ model: "glm" }) });
    const clientWon = await handleGatewayRequest(deps, { method: "POST", path: "/v1/chat/completions", headers: { authorization: "Bearer client-key" }, body: JSON.stringify({ model: "glm" }) });
    expect(e1.seen[0]!.auth).toBe("Bearer upstream-secret");
    expect(e1.seen[1]!.auth).toBe("Bearer client-key");
    expect(injected.status).toBe(200);
    expect(clientWon.status).toBe(200);
    e1.server.close();
  });

  it("maps deployment states to health grades", () => {
    expect(healthFromState("healthy")).toBe("healthy");
    expect(healthFromState("healthy-keyed")).toBe("healthy");
    expect(healthFromState("starting")).toBe("degraded");
    expect(healthFromState("up")).toBe("degraded");
    expect(healthFromState("failed")).toBe("down");
    expect(healthFromState(undefined)).toBe("unknown");
  });

  it("round-robins consecutive requests across equal targets", async () => {
    const a = await engine([{ status: 200, body: '{"from":"a"}' }]);
    const b = await engine([{ status: 200, body: '{"from":"b"}' }]);
    const rr = new Map<string, number>();
    const deps = baseDeps({
      rrCounters: rr,
      servedModels: [
        { id: "s", alias: "glm", targets: [{ nodeId: "a", port: a.port }, { nodeId: "b", port: b.port }], onDemand: null, createdAt: 1, updatedAt: 1 },
      ],
    });
    const r1 = await handleGatewayRequest(deps, { method: "POST", path: "/v1/chat/completions", headers: {}, body: JSON.stringify({ model: "glm" }) });
    const r2 = await handleGatewayRequest(deps, { method: "POST", path: "/v1/chat/completions", headers: {}, body: JSON.stringify({ model: "glm" }) });
    expect(r1.servedBy).toEqual({ nodeId: "a", port: a.port });
    expect(r2.servedBy).toEqual({ nodeId: "b", port: b.port });
    a.server.close();
    b.server.close();
  });

  it("502s with attempt evidence when every target fails", async () => {
    const res = await handleGatewayRequest(
      baseDeps({
        targetState: () => null,
      }),
      { method: "POST", path: "/v1/chat/completions", headers: {}, body: JSON.stringify({ model: "glm" }) },
    );
    expect(res.status).toBe(502);
    expect(res.attempts).toHaveLength(2);
    expect(res.attempts.every((a) => a.error === "no lanIp")).toBe(true);
  });
});

describe("502 recording (failover drill evidence)", () => {
  it("records exhausted chains as traces with full attempt trails", async () => {
    const down1 = await engine([{ fail: true }]);
    const down2 = await engine([{ fail: true }]);
    const seen: unknown[] = [];
    const res = await handleGatewayRequest(
      baseDeps({
        servedModels: [
          { id: "s", alias: "glm", targets: [{ nodeId: "a", port: down1.port }, { nodeId: "b", port: down2.port }], onDemand: null, createdAt: 1, updatedAt: 1 },
        ],
        onAttempt: (info) => seen.push(info),
      }),
      { method: "POST", path: "/v1/chat/completions", headers: {}, body: JSON.stringify({ model: "glm" }) },
    ).finally(() => {
      down1.server.close();
      down2.server.close();
    });
    expect(res.status).toBe(502);
    expect(res.attempts).toHaveLength(2);
    // The recorder hook observed both attempts with timings.
    expect(seen).toHaveLength(2);
    expect((seen[0] as { status: number | null }).status).toBeNull();
  });
});
