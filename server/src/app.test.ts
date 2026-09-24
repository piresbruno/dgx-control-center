import { describe, expect, it } from "vitest";
import { VERSION } from "@cc/shared";
import { buildApp } from "./app.js";
import { NodeDirectory } from "./nodeDirectory.js";
import { ModelctlService } from "./modelctl/service.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAYLOAD = JSON.stringify([
  { name: "GLM-5.3-Flash-EXL3", runtime: "vllm", repository: "zai-org/GLM-5.3-Flash-EXL3", bytes: 123 },
  { name: "Qwen3.6-35B", repository: "Qwen/Qwen3.6-35B", bytes: 0 },
]);

async function testDirectory(): Promise<NodeDirectory> {
  const dir = new NodeDirectory({ file: join(await mkdtemp(join(tmpdir(), "cc-")), "nodes.json") });
  await dir.load();
  return dir;
}

describe("model inventories (M2)", () => {
  it("GET /api/models serves the NAS inventory via modelctl", async () => {
    const modelctl = new ModelctlService({ runner: async () => PAYLOAD });
    const app = buildApp({ nodeDirectory: await testDirectory(), modelctl });
    const res = await app.inject({ method: "GET", url: "/api/models" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stale).toBe(false);
    expect(body.models[0]).toMatchObject({ name: "GLM-5.3-Flash-EXL3", bytes: 123 });
    await app.close();
  });

  it("GET /api/nodes/:id/models runs modelctl --local over the node SSH transport", async () => {
    const modelctl = new ModelctlService({ runner: async () => PAYLOAD });
    const seen: Array<{ host: string; user: string; args: string[] }> = [];
    const dir = await testDirectory();
    const app = buildApp({
      nodeDirectory: dir,
      modelctl,
      nodeInventoryRunner: async (host, user, args) => {
        seen.push({ host, user, args });
        return PAYLOAD;
      },
    });
    await dir.upsert({ id: "dgx1", name: "dgx-1", kind: "spark", role: "head", lanIp: "10.0.0.11", sshUser: "piresbruno" });

    const res = await app.inject({ method: "GET", url: "/api/nodes/dgx1/models" });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toHaveLength(2);
    expect(seen[0]).toMatchObject({ host: "10.0.0.11", user: "piresbruno" });
    await app.close();
  });

  it("returns 404 for unknown nodes and 400 when lanIp/sshUser are missing", async () => {
    const dir = await testDirectory();
    const app = buildApp({ nodeDirectory: dir, modelctl: new ModelctlService({ runner: async () => PAYLOAD }) });
    expect((await app.inject({ method: "GET", url: "/api/nodes/nope/models" })).statusCode).toBe(404);
    await dir.upsert({ id: "nas1", name: "nas1", kind: "nas", role: "standalone" });
    expect((await app.inject({ method: "GET", url: "/api/nodes/nas1/models" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("remote jobs API (M2)", () => {
  async function jobsApp() {
    const dir = await testDirectory();
    const { JobsManager } = await import("./jobs/jobsManager.js");
    const sent: unknown[] = [];
    let connected = true;
    const manager = new JobsManager({
      send: (_nodeId, msg) => {
        sent.push(msg);
        return connected;
      },
      isConnected: () => connected,
    });
    await dir.upsert({ id: "dgx1", name: "dgx-1", kind: "spark", role: "head", lanIp: "10.0.0.11", sshUser: "piresbruno" });
    const app = buildApp({ nodeDirectory: dir, jobsManager: manager });
    return { app, manager, sent, setConnected: (v: boolean) => (connected = v) };
  }

  it("dispatches a named kind, then lists and reads it", async () => {
    const { app, sent } = await jobsApp();
    const post = await app.inject({ method: "POST", url: "/api/nodes/dgx1/jobs", payload: { kind: "modelctl-list-local" } });
    expect(post.statusCode).toBe(202);
    const { reqId } = post.json();
    expect(sent[0]).toMatchObject({ type: "job-run", reqId });

    const list = await app.inject({ method: "GET", url: "/api/jobs?nodeId=dgx1&active=1" });
    expect(list.json().jobs).toHaveLength(1);

    const one = await app.inject({ method: "GET", url: `/api/jobs/${reqId}` });
    expect(one.json()).toMatchObject({ reqId, kind: "modelctl-list-local", state: "running" });
    await app.close();
  });

  it("rejects unknown kinds (400), conflicts (409), and disconnected nodes (503)", async () => {
    const { app, setConnected, manager } = await jobsApp();
    expect(
      (await app.inject({ method: "POST", url: "/api/nodes/dgx1/jobs", payload: { kind: "rm -rf /" } })).statusCode,
    ).toBe(400);
    await app.inject({ method: "POST", url: "/api/nodes/dgx1/jobs", payload: { kind: "modelctl-version" } });
    expect(
      (await app.inject({ method: "POST", url: "/api/nodes/dgx1/jobs", payload: { kind: "modelctl-version" } })).statusCode,
    ).toBe(409);
    setConnected(false);
    expect(manager.list({ active: true })).toHaveLength(1);
    expect(
      (await app.inject({ method: "POST", url: "/api/nodes/dgx1/jobs", payload: { kind: "uv-version" } })).statusCode,
    ).toBe(503);
    await app.close();
  });

  it("404s unknown nodes", async () => {
    const { app } = await jobsApp();
    expect(
      (await app.inject({ method: "POST", url: "/api/nodes/nope/jobs", payload: { kind: "modelctl-version" } })).statusCode,
    ).toBe(404);
    await app.close();
  });
});

describe("modelctl provisioning API (M2)", () => {
  it("provisions via SSH transport and returns the outcome", async () => {
    const dir = await testDirectory();
    const app = buildApp({
      nodeDirectory: dir,
      provisionTransport: async () => ({
        exitCode: 0,
        stdout: `__CC_MODELCTL__:${JSON.stringify({ ok: true, mode: "installed", version: "modelctl 0.20.1", reason: null })}`,
        stderr: "",
      }),
    });
    await dir.upsert({ id: "dgx2", name: "dgx-2", kind: "spark", role: "worker", lanIp: "10.0.0.12", sshUser: "piresbruno" });
    const res = await app.inject({ method: "POST", url: "/api/nodes/dgx2/provision-modelctl" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, mode: "installed" });
    await app.close();
  });
});

describe("GET /api/health", () => {
  it("returns ok with the shared version", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, name: "controlcenter", version: VERSION });
    expect(typeof body.time).toBe("string");
    await app.close();
  });
});

describe("recipes API (M3)", () => {
  const PROBE_OUT = [
    "__P_FILES__",
    "./start.sh 1024",
    "./start-tp4.sh 2048",
    "__P_GIT__",
    "abc1234",
    "__P_DISPATCH__",
    "start)",
    "stop)",
    "status)",
    "__P_ENV__",
    "PORT=8888",
    "MODEL=glm53",
    "VLLM_API_KEY=sk-x",
    "__P_END__",
  ].join("\n");

  async function recipesApp() {
    const dir = await testDirectory();
    const { JobsManager } = await import("./jobs/jobsManager.js");
    const { RecipeStore } = await import("./serving/recipes.js");
    const manager = new JobsManager({ send: () => true, isConnected: () => true });
    const store = new RecipeStore({ filePath: join(await mkdtemp(join(tmpdir(), "cc-")), "serve-recipes.json") });
    await dir.upsert({ id: "dgx1", name: "dgx-1", kind: "spark", role: "head", lanIp: "10.0.0.11", sshUser: "piresbruno" });
    await dir.upsert({ id: "nas1", name: "nas1", kind: "nas", role: "standalone" });
    const app = buildApp({ nodeDirectory: dir, jobsManager: manager, recipeStore: store });
    return { app, manager, store };
  }

  it("registers a recipe, runs one probe, and merges parsed meta", async () => {
    const { app, manager } = await recipesApp();
    const post = await app.inject({
      method: "POST",
      url: "/api/recipes",
      payload: { nodeId: "dgx1", path: "/home/pires/recipes/GLM", label: "GLM TP4" },
    });
    expect(post.statusCode).toBe(201);
    const { recipe, jobId } = post.json();
    expect(recipe.entry).toBeNull();
    expect(manager.get(jobId)).toMatchObject({ kind: "recipe-probe", nodeId: "dgx1" });
    expect(manager.get(jobId)!.argv[2]).toContain("'/home/pires/recipes/GLM'");

    manager.observeMessage("dgx1", { type: "job-out", reqId: jobId, stream: "out", chunk: PROBE_OUT });
    manager.observeMessage("dgx1", { type: "job-exit", reqId: jobId, code: 0 });

    const read = await app.inject({ method: "GET", url: `/api/recipes/${recipe.id}` });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      entry: "start.sh",
      label: "GLM TP4",
      probeError: null,
    });
    expect(read.json().meta).toMatchObject({ port: 8888, model: "glm53", class: "repo", entry: "start.sh" });
    expect(read.json().meta.secretPresence).toEqual({ VLLM_API_KEY: true });
    await app.close();
  });

  it("re-registering the same folder returns the existing recipe (202)", async () => {
    const { app } = await recipesApp();
    const payload = { nodeId: "dgx1", path: "/home/pires/recipes/GLM" };
    const first = await app.inject({ method: "POST", url: "/api/recipes", payload });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: "/api/recipes", payload });
    expect(second.statusCode).toBe(202);
    expect(second.json().recipe.id).toBe(first.json().recipe.id);
    await app.close();
  });

  it("validates path/node (400) and guards NAS nodes", async () => {
    const { app } = await recipesApp();
    expect(
      (await app.inject({ method: "POST", url: "/api/recipes", payload: { nodeId: "dgx1", path: "relative" } })).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/recipes", payload: { nodeId: "nope", path: "/x" } })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: "/api/recipes", payload: { nodeId: "nas1", path: "/mnt/nas/recipes" } })).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("re-probes an existing recipe and reports 503 when the node is gone", async () => {
    const { app, manager } = await recipesApp();
    const post = await app.inject({
      method: "POST",
      url: "/api/recipes",
      payload: { nodeId: "dgx1", path: "/home/pires/recipes/GLM" },
    });
    const { recipe } = post.json();
    // Let the first probe finish so the second isn't a single-flight conflict.
    const jobId = post.json().jobId;
    manager.observeMessage("dgx1", { type: "job-exit", reqId: jobId, code: 0 });

    const reprobe = await app.inject({ method: "POST", url: `/api/recipes/${recipe.id}/probe` });
    expect(reprobe.statusCode).toBe(202);

    manager.observeMessage("dgx1", { type: "job-exit", reqId: reprobe.json().jobId, code: 0 });
    expect((await app.inject({ method: "POST", url: "/api/recipes/nope/probe" })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/recipes/${recipe.id}` })).json()).toEqual({ removed: true });
    expect((await app.inject({ method: "GET", url: `/api/recipes/${recipe.id}` })).statusCode).toBe(404);
    await app.close();
  });

  it("stores the probe error when the folder is missing on the node", async () => {
    const { app, manager } = await recipesApp();
    const post = await app.inject({
      method: "POST",
      url: "/api/recipes",
      payload: { nodeId: "dgx1", path: "/gone" },
    });
    const { recipe, jobId } = post.json();
    manager.observeMessage("dgx1", { type: "job-out", reqId: jobId, stream: "out", chunk: "__P_NOPATH__" });
    manager.observeMessage("dgx1", { type: "job-exit", reqId: jobId, code: 0 });
    const read = await app.inject({ method: "GET", url: `/api/recipes/${recipe.id}` });
    expect(read.json().probeError).toContain("not found");
    await app.close();
  });

  it("409s a second probe while one is running on the node", async () => {
    const { app } = await recipesApp();
    await app.inject({ method: "POST", url: "/api/recipes", payload: { nodeId: "dgx1", path: "/a" } });
    const second = await app.inject({ method: "POST", url: "/api/recipes", payload: { nodeId: "dgx1", path: "/b" } });
    expect(second.statusCode).toBe(409);
    await app.close();
  });
});

describe("serve deployments API (M3)", () => {
  const PROBE_OUT = [
    "__P_FILES__",
    "./start.sh 1024",
    "__P_GIT__",
    "abc1234",
    "__P_DISPATCH__",
    "start)",
    "stop)",
    "status)",
    "__P_ENV__",
    "PORT=8888",
    "MODEL=glm53",
    "SERVED_MODEL_NAME=GLM-5.3",
    "NNODES=2",
    "WORKER_IP=10.0.0.12",
    "__P_CONTAINERS__",
    'start.sh:CONTAINER_HEAD="${CONTAINER_HEAD:-glm-head}"',
    "__P_END__",
  ].join("\n");

  async function serveApp() {
    const dir = await testDirectory();
    const { JobsManager } = await import("./jobs/jobsManager.js");
    const { RecipeStore } = await import("./serving/recipes.js");
    const { DeploymentStore } = await import("./serving/deployments.js");
    const manager = new JobsManager({ send: () => true, isConnected: () => true });
    const tmp = await mkdtemp(join(tmpdir(), "cc-serve-"));
    const store = new RecipeStore({ filePath: join(tmp, "recipes.json") });
    const deployments = new DeploymentStore({ filePath: join(tmp, "deployments.json") });
    await dir.upsert({ id: "dgx1", name: "dgx-1", kind: "spark", role: "head", lanIp: "10.0.0.11", sshUser: "piresbruno" });
    await dir.upsert({ id: "dgx2", name: "dgx-2", kind: "spark", role: "worker", lanIp: "10.0.0.12", sshUser: "piresbruno" });
    const app = buildApp({ nodeDirectory: dir, jobsManager: manager, recipeStore: store, deploymentStore: deployments });
    const reg = await app.inject({
      method: "POST",
      url: "/api/recipes",
      payload: { nodeId: "dgx1", path: "/opt/recipes/GLM" },
    });
    const { recipe, jobId } = reg.json();
    manager.observeMessage("dgx1", { type: "job-out", reqId: jobId, stream: "out", chunk: PROBE_OUT });
    manager.observeMessage("dgx1", { type: "job-exit", reqId: jobId, code: 0 });
    return { app, manager, deployments, recipe };
  }

  it("creates a deployment from a probed recipe and lists joined state", async () => {
    const { app, manager, recipe } = await serveApp();
    const create = await app.inject({ method: "POST", url: "/api/serve/deployments", payload: { recipeId: recipe.id } });
    expect(create.statusCode).toBe(201);
    const dep = create.json();
    expect(dep).toMatchObject({ recipeId: recipe.id, sparkId: "dgx1", port: 8888, entry: "start.sh" });
    expect(dep.state.state).toBe("stopped"); // no job yet, no probe

    // Probe through the supervisor → state still stopped but probe captured.
    const probe = await app.inject({ method: "POST", url: `/api/serve/deployments/${dep.id}/probe` });
    expect(probe.statusCode).toBe(202);
    manager.observeMessage("dgx1", { type: "job-out", reqId: probe.json().reqId, stream: "out", chunk: "__S_CONTAINERS__\nglm-head|running\n__S_HEALTH__\n200\n" });
    manager.observeMessage("dgx1", { type: "job-exit", reqId: probe.json().reqId, code: 0 });

    const list = await app.inject({ method: "GET", url: "/api/serve/deployments" });
    const row = list.json().deployments[0];
    expect(row.lastProbe.ranks).toEqual({ CONTAINER_HEAD: "running" });
    expect(row.state.state).toBe("healthy");
    await app.close();
  });

  it("start dispatches when the declared worker matches, 409s when not", async () => {
    const { app, manager, recipe } = await serveApp();
    // Happy path: declared worker 10.0.0.12 == dgx2's lanIp → 202.
    const dep = (await app.inject({ method: "POST", url: "/api/serve/deployments", payload: { recipeId: recipe.id } })).json();
    const ok = await app.inject({ method: "POST", url: `/api/serve/deployments/${dep.id}/start` });
    expect(ok.statusCode).toBe(202);
    manager.observeMessage("dgx1", { type: "job-exit", reqId: ok.json().reqId, code: 0 });

    // A recipe whose declared worker matches nothing in the directory → 409.
    const reg = await app.inject({ method: "POST", url: "/api/recipes", payload: { nodeId: "dgx1", path: "/opt/recipes/OTHER" } });
    const other = reg.json();
    manager.observeMessage("dgx1", { type: "job-out", reqId: other.jobId, stream: "out", chunk: PROBE_OUT.replace("10.0.0.12", "10.9.9.9") });
    manager.observeMessage("dgx1", { type: "job-exit", reqId: other.jobId, code: 0 });
    const dep2 = (await app.inject({ method: "POST", url: "/api/serve/deployments", payload: { recipeId: other.recipe.id } })).json();
    const refused = await app.inject({ method: "POST", url: `/api/serve/deployments/${dep2.id}/start` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "multi-node guard refused start", guard: { ok: false, code: "worker-unmatched" } });
    await app.close();
  });

  it("stop and restart dispatch verbs; delete removes; unknown 404s", async () => {
    const { app, manager, recipe } = await serveApp();
    const dep = (await app.inject({ method: "POST", url: "/api/serve/deployments", payload: { recipeId: recipe.id } })).json();
    const start = await app.inject({ method: "POST", url: `/api/serve/deployments/${dep.id}/start` });
    expect(start.statusCode).toBe(202);
    const startJobId = start.json().reqId;
    manager.observeMessage("dgx1", { type: "job-exit", reqId: startJobId, code: 0 });
    expect((await app.inject({ method: "GET", url: `/api/serve/deployments/${dep.id}` })).json()).toMatchObject({ desired: "running", jobState: "done" });

    const stop = await app.inject({ method: "POST", url: `/api/serve/deployments/${dep.id}/stop` });
    expect(stop.statusCode).toBe(202);
    manager.observeMessage("dgx1", { type: "job-exit", reqId: stop.json().reqId, code: 0 });
    expect((await app.inject({ method: "GET", url: `/api/serve/deployments/${dep.id}` })).json()).toMatchObject({ desired: "stopped" });

    expect((await app.inject({ method: "DELETE", url: `/api/serve/deployments/${dep.id}` })).json()).toEqual({ removed: true });
    expect((await app.inject({ method: "GET", url: `/api/serve/deployments/${dep.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/serve/deployments/nope/stop" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/serve/deployments", payload: { recipeId: "nope" } })).statusCode).toBe(404);
    await app.close();
  });
});

describe("llm pass-through (M3)", () => {
  async function engineApp(mode: "json" | "sse" | "down") {
    const { createServer } = await import("node:http");
    const engine = createServer((req, res) => {
      if (mode === "down") {
        res.destroy();
        return;
      }
      if (req.url?.includes("/v1/chat/completions")) {
        if (mode === "sse") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"delta":"a"}\n\n');
          setTimeout(() => {
            res.write('data: {"delta":"b"}\n\n');
            res.write("data: [DONE]\n\n");
            res.end();
          }, 20);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "hello" } }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: req.headers.authorization ?? null }));
    });
    await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
    const port = (engine.address() as { port: number }).port;

    const dir = await testDirectory();
    const app = buildApp({ nodeDirectory: dir });
    await dir.upsert({ id: "dgx1", name: "dgx-1", kind: "spark", role: "head", lanIp: "127.0.0.1", sshUser: "piresbruno" });
    return { app, engine, port };
  }

  it("proxies JSON requests and passes the authorization header", async () => {
    const { app, engine, port } = await engineApp("json");
    const res = await app.inject({
      method: "GET",
      url: `/llm/node/dgx1/${port}/health`,
      headers: { authorization: "Bearer sk-test" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: "Bearer sk-test" });
    await app.close();
    engine.close();
  });

  it("streams SSE chunks through", async () => {
    const { app, engine, port } = await engineApp("sse");
    const res = await app.inject({
      method: "POST",
      url: `/llm/node/dgx1/${port}/v1/chat/completions`,
      payload: { model: "glm", stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain('{"delta":"a"}');
    expect(res.body).toContain("[DONE]");
    await app.close();
    engine.close();
  });

  it("502s when the engine is unreachable and 400s invalid ports", async () => {
    const { app, engine, port } = await engineApp("down");
    const res = await app.inject({ method: "GET", url: `/llm/node/dgx1/${port}/health` });
    expect(res.statusCode).toBe(502);
    expect((await app.inject({ method: "GET", url: "/llm/node/dgx1/notaport/health" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/llm/node/nope/${port}/health` })).statusCode).toBe(404);
    await app.close();
    engine.close();
  });
});

describe("gateway /v1 + analysis API (M4)", () => {
  async function gatewayApp() {
    const { createServer } = await import("node:http");
    const engine = createServer((req, res) => {
      if (req.url?.includes("/v1/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
    const port = (engine.address() as { port: number }).port;

    const dir = await testDirectory();
    const { ServedModelsStore } = await import("./gateway/servedModels.js");
    const { ClientsStore } = await import("./gateway/clients.js");
    const { openDb } = await import("./stores/db.js");
    const { TracesStore } = await import("./stores/tracesStore.js");
    const { TraceQueries } = await import("./stores/traceQueries.js");
    const tmp = await mkdtemp(join(tmpdir(), "cc-gw-"));
    const db = openDb(join(tmp, "t.db"), 0);
    const served = new ServedModelsStore({ filePath: join(tmp, "sm.json") });
    served.upsert({ alias: "glm", targets: [{ nodeId: "dgx1", port }] });
    const clients = new ClientsStore({ filePath: join(tmp, "clients.json") });
    const { key } = clients.create({ name: "tester" });
    const traces = new TracesStore({ db });
    const queries = new TraceQueries(db);
    await dir.upsert({ id: "dgx1", name: "dgx-1", kind: "spark", role: "head", lanIp: "127.0.0.1", sshUser: "u" });
    const app = buildApp({
      nodeDirectory: dir,
      servedModelsStore: served,
      clientsStore: clients,
      tracesStore: traces,
      traceQueries: queries,
      upstreamAuth: "Bearer upstream",
    });
    return { app, key, traces, served, clients };
  }

  it("authenticates, routes, records a trace with usage", async () => {
    const { app, key, traces } = await gatewayApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: { model: "glm", messages: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(traces.count()).toBe(1);
    const trace = traces.list()[0]!;
    expect(trace).toMatchObject({ alias: "glm", client: "tester", status: 200, promptTokens: 3, completionTokens: 4 });
    expect(trace.nodeId).toBe("dgx1");
    await app.close();
  });

  it("401s bad keys (no trace recorded) and 404s unknown aliases with served list", async () => {
    const { app, traces, key } = await gatewayApp();
    const bad = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer nope" }, payload: { model: "glm" } });
    expect(bad.statusCode).toBe(401);
    const unknown = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload: { model: "ghost" } });
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(unknown.body).error.served).toEqual(["glm"]);
    // Rejected requests are recorded too — they count toward error rates.
    expect(traces.count()).toBe(2);
    expect(traces.list().map((t) => t.status).sort()).toEqual([401, 404]);
    await app.close();
  });

  it("manages served models and clients over REST", async () => {
    const { app, served, clients, key } = await gatewayApp();
    const models = await app.inject({ method: "GET", url: "/api/gateway/served-models" });
    expect(models.json().models.map((m: { alias: string }) => m.alias)).toEqual(["glm"]);

    const created = await app.inject({ method: "POST", url: "/api/gateway/served-models", payload: { alias: "qwen", targets: [{ nodeId: "dgx1", port: 9999 }] } });
    expect(created.statusCode).toBe(201);
    const dup = await app.inject({ method: "POST", url: "/api/gateway/served-models", payload: { alias: "glm", targets: [] } });
    expect(dup.statusCode).toBe(409);

    const client = await app.inject({ method: "POST", url: "/api/gateway/clients", payload: { name: "ci", scopes: ["qwen"] } });
    expect(client.statusCode).toBe(201);
    expect(client.json().key).toMatch(/^cc-/);
    const listed = await app.inject({ method: "GET", url: "/api/gateway/clients" });
    expect([...listed.json().clients.map((c: { name: string }) => c.name)].sort()).toEqual(["ci", "tester"]);
    void key;
    void served;
    void clients;
    await app.close();
  });

  it("serves analysis summary, CSV export, and prometheus metrics", async () => {
    const { app, key } = await gatewayApp();
    await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload: { model: "glm" } });

    const summary = await app.inject({ method: "GET", url: "/api/analysis/summary?windowHours=24" });
    expect(summary.json().kpis.requests).toBe(1);
    expect(summary.json().byAlias[0]).toMatchObject({ key: "glm", requests: 1 });

    const csvRes = await app.inject({ method: "GET", url: "/api/analysis/export.csv" });
    expect(csvRes.headers["content-type"]).toContain("text/csv");
    expect(csvRes.body.split("\n")[0]).toContain("alias");
    expect(csvRes.body).toContain("glm");

    const prom = await app.inject({ method: "GET", url: "/api/metrics/prometheus" });
    expect(prom.body).toContain("cc_gateway_requests_total{alias=\"glm\"} 1");
    expect(prom.body).toContain("cc_gateway_ttft_p50_ms");
    await app.close();
  });
});

describe("power & clocks API (M5)", () => {
  async function powerApp() {
    const dir = await testDirectory();
    const { ClockProfileStore } = await import("./power/clockStore.js");
    const store = new ClockProfileStore({ filePath: join(await mkdtemp(join(tmpdir(), "cc-pw-")), "clock.json") });
    await dir.upsert({ id: "dgx1", name: "dgx-1", kind: "spark", role: "head", lanIp: "10.0.0.11", sshUser: "u" });
    await dir.upsert({ id: "nas1", name: "nas1", kind: "nas", role: "standalone" });
    return { app: buildApp({ nodeDirectory: dir, clockStore: store }), store };
  }

  it("lists profiles and per-spark desires", async () => {
    const { app } = await powerApp();
    const profiles = await app.inject({ method: "GET", url: "/api/power/profiles" });
    expect(profiles.json().profiles.map((p: { id: string }) => p.id)).toEqual(["full", "eco", "quiet"]);
    const clocks = await app.inject({ method: "GET", url: "/api/power/clocks" });
    expect(clocks.json().clocks).toEqual([expect.objectContaining({ sparkId: "dgx1", desired: "full" })]);
    await app.close();
  });

  it("sets desires for sparks, 409s nas, 404s unknown, 400s bad profile", async () => {
    const { app } = await powerApp();
    const ok = await app.inject({ method: "PUT", url: "/api/power/clocks/dgx1", payload: { profile: "eco" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().resolved).toMatchObject({ gpuMaxMhz: 2200, cpuMaxMhz: 2000, clamped: false });

    const nas = await app.inject({ method: "PUT", url: "/api/power/clocks/nas1", payload: { profile: "eco" } });
    expect(nas.statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: "/api/power/clocks/nope", payload: { profile: "eco" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/api/power/clocks/dgx1", payload: { profile: "turbo" } })).statusCode).toBe(400);

    const clocks = await app.inject({ method: "GET", url: "/api/power/clocks" });
    expect(clocks.json().clocks[0]).toMatchObject({ sparkId: "dgx1", desired: "eco" });
    await app.close();
  });
});

describe("thermal guard API (M5)", () => {
  it("reports per-node states and events from the injected guard", async () => {
    const dir = await testDirectory();
    const { ThermalGuard } = await import("./power/thermal.js");
    const { ClockProfileStore } = await import("./power/clockStore.js");
    const guard = new ThermalGuard({ filePath: join(await mkdtemp(join(tmpdir(), "cc-")), "t.json"), now: () => 1_000 });
    guard.tick([{ sparkId: "dgx1", gpuTempC: 85 }]);
    await dir.upsert({ id: "dgx1", name: "dgx-1", kind: "spark", role: "head", lanIp: "10.0.0.11", sshUser: "u" });
    await dir.upsert({ id: "nas1", name: "nas1", kind: "nas", role: "standalone" });
    const clockStore = new ClockProfileStore({ filePath: join(await mkdtemp(join(tmpdir(), "cc-")), "c.json") });
    const app = buildApp({ nodeDirectory: dir, clockStore, thermalGuard: guard });
    const res = await app.inject({ method: "GET", url: "/api/power/thermal" });
    expect(res.json()).toMatchObject({
      nodes: [expect.objectContaining({ sparkId: "dgx1", state: "derated" })],
      events: [expect.objectContaining({ kind: "derate", tempC: 85 })],
    });
    await app.close();
  });

  it("defaults to nominal without a guard", async () => {
    const dir = await testDirectory();
    const { ClockProfileStore } = await import("./power/clockStore.js");
    await dir.upsert({ id: "dgx1", name: "dgx-1", kind: "spark", role: "head", lanIp: "10.0.0.11", sshUser: "u" });
    const clockStore = new ClockProfileStore({ filePath: join(await mkdtemp(join(tmpdir(), "cc-")), "c.json") });
    const app = buildApp({ nodeDirectory: dir, clockStore });
    const res = await app.inject({ method: "GET", url: "/api/power/thermal" });
    expect(res.json().nodes).toEqual([{ sparkId: "dgx1", state: "nominal" }]);
    await app.close();
  });
});

describe("clock schedules API (M5)", () => {
  it("sets, lists, and removes per-node schedules with tz validation", async () => {
    const dir = await testDirectory();
    const { ClockProfileStore } = await import("./power/clockStore.js");
    const { ScheduleStore } = await import("./power/schedules.js");
    const clockStore = new ClockProfileStore({ filePath: join(await mkdtemp(join(tmpdir(), "cc-")), "c.json") });
    const scheduleStore = new ScheduleStore({ filePath: join(await mkdtemp(join(tmpdir(), "cc-")), "s.json") });
    await dir.upsert({ id: "dgx1", name: "dgx-1", kind: "spark", role: "head", lanIp: "10.0.0.11", sshUser: "u" });
    const app = buildApp({ nodeDirectory: dir, clockStore, scheduleStore });

    const put = await app.inject({
      method: "PUT",
      url: "/api/power/schedules/dgx1",
      payload: { tz: "Europe/Berlin", rules: [{ profileId: "eco", start: "22:00", end: "06:00" }] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ sparkId: "dgx1", tz: "Europe/Berlin" });

    const bad = await app.inject({ method: "PUT", url: "/api/power/schedules/dgx1", payload: { tz: "Nowhere/X", rules: [] } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/power/schedules/nope", payload: { tz: "UTC", rules: [] } })).statusCode).toBe(404);

    const list = await app.inject({ method: "GET", url: "/api/power/schedules" });
    expect(list.json().schedules).toHaveLength(1);
    expect((await app.inject({ method: "DELETE", url: "/api/power/schedules/dgx1" })).json()).toEqual({ removed: true });
    expect((await app.inject({ method: "DELETE", url: "/api/power/schedules/dgx1" })).statusCode).toBe(404);
    await app.close();
  });
});

describe("energy API (M5)", () => {
  it("serves kWh/cost summaries from injected store", async () => {
    const dir = await testDirectory();
    const { EnergyStore } = await import("./stores/energyStore.js");
    const { ClockProfileStore } = await import("./power/clockStore.js");
    const clockStore = new ClockProfileStore({ filePath: join(await mkdtemp(join(tmpdir(), "cc-")), "c.json") });
    const { openDb } = await import("./stores/db.js");
    const { MetricsStore } = await import("./stores/metricsStore.js");
    const db = openDb(":memory:", 0);
    const metrics = new MetricsStore(db, { now: () => 0 });
    const base = Date.now() - 3_600_000; // inside the queried 24h window
    for (let m = 0; m < 30; m++) {
      metrics.ingest("dgx1", { ts: base + m * 60_000, domains: { gpu: { gpus: [{ watts: 100 }] } } });
    }
    metrics.flush();
    const app = buildApp({ nodeDirectory: dir, clockStore, energyStore: new EnergyStore(db, { kwhCost: 0.3 }) });
    const res = await app.inject({ method: "GET", url: "/api/power/energy?windowHours=24" });
    expect(res.json().totalKwh).toBeGreaterThan(0);
    expect(res.json().hourly.length).toBeGreaterThan(0);
    await app.close();
  });
});

describe("alerts API (M6)", () => {
  async function alertsApp() {
    const { AlertsStore } = await import("./stores/alertsStore.js");
    const { AlertRulesStore } = await import("./alerts/rules.js");
    const db = (await import("./stores/db.js")).openDb(":memory:", 0);
    const alertsStore = new AlertsStore({ db, now: () => 1_000 });
    const rules = new AlertRulesStore({ filePath: join(await mkdtemp(join(tmpdir(), "cc-")), "rules.json"), seed: true });
    const app = buildApp({ alertsStore, alertRulesStore: rules });
    return { app, alertsStore, rules };
  }

  it("CRUDs rules (seed read-only) and manages alert lifecycle over REST", async () => {
    const { app, alertsStore } = await alertsApp();
    const rules = await app.inject({ method: "GET", url: "/api/alerts/rules" });
    expect(rules.json().rules.map((r: { id: string }) => r.id)).toContain("seed-node-down");

    const created = await app.inject({
      method: "PUT",
      url: "/api/alerts/rules/u-test",
      payload: { name: "Custom", severity: "info", enabled: true, condition: { source: "gateway-5xx", op: ">=", value: 5, forMs: 0 } },
    });
    expect(created.statusCode).toBe(200);

    const seedEdit = await app.inject({ method: "DELETE", url: "/api/alerts/rules/seed-node-down" });
    expect(seedEdit.statusCode).toBe(409);

    // Simulate a firing alert, then ack → resolve over REST.
    const a = alertsStore.insert({ ruleId: "u-test", ruleName: "Custom", severity: "info", entity: "_fleet", detail: "d", state: "firing", firedAt: 1_000 });
    const ack = await app.inject({ method: "POST", url: `/api/alerts/${a.id}/ack`, payload: { by: "me" } });
    expect(ack.json()).toEqual({ acknowledged: true });
    const resolve = await app.inject({ method: "POST", url: `/api/alerts/${a.id}/resolve`, payload: { note: "done" } });
    expect(resolve.json()).toEqual({ resolved: true });
    const events = await app.inject({ method: "GET", url: "/api/alerts/events" });
    expect(events.json().events.map((e: { kind: string }) => e.kind)).toEqual(["resolved", "acknowledged", "fired"]);

    const csv = await app.inject({ method: "GET", url: "/api/alerts/history.csv" });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect((await app.inject({ method: "POST", url: `/api/alerts/${a.id}/resolve`, payload: {} })).statusCode).toBe(409);
    await app.close();
  });
});

describe("system export/import/backup API (M7)", () => {
  it("exports config, imports it back (202), and creates listable backups", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-sys-"));
    const db = (await import("./stores/db.js")).openDb(join(dir, "cc.db"), 0);
    await (await import("node:fs/promises")).writeFile(join(dir, "nodes.json"), JSON.stringify([{ id: "dgx1", kind: "spark" }]));
    const app = buildApp({ systemDb: db, configDir: dir });

    const exported = await app.inject({ method: "GET", url: "/api/system/export" });
    expect(exported.json().kind).toBe("controlcenter-config-export");
    expect(exported.json().files["nodes.json"]).toEqual([{ id: "dgx1", kind: "spark" }]);

    const manifest = exported.json();
    manifest.files["nodes.json"] = [{ id: "dgx2", kind: "spark" }];
    const imp = await app.inject({ method: "POST", url: "/api/system/import", payload: manifest });
    expect(imp.statusCode).toBe(202);
    expect(imp.json().restartRequired).toBe(true);
    const bad = await app.inject({ method: "POST", url: "/api/system/import", payload: { kind: "nope" } });
    expect(bad.statusCode).toBe(400);

    const backup = await app.inject({ method: "POST", url: "/api/system/backup" });
    expect(backup.json().files).toContain("nodes.json");
    expect(backup.json().dbBytes).toBeGreaterThan(0);
    const listed = await app.inject({ method: "GET", url: "/api/system/backups" });
    expect(listed.json().backups).toHaveLength(1);
    await app.close();
  });
});
