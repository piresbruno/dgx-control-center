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
