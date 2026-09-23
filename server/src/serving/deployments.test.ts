import { describe, expect, it } from "vitest";
import {
  buildRecipeVerbScript,
  buildServeProbeCommand,
  parseServeProbe,
  parseModelIds,
  rankStates,
  joinServeState,
  DeploymentStore,
  DeploymentSupervisor,
} from "./deployments.js";
import { JobsManager } from "../jobs/jobsManager.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("verb script builders", () => {
  it("builds a verb script with env bootstrap and quoted path", () => {
    const script = buildRecipeVerbScript("/opt/my recipes/GLM", "start.sh", "start");
    expect(script).toContain("USER=$(id -un)");
    expect(script).toContain("cd '/opt/my recipes/GLM'");
    expect(script).toContain("./start.sh start");
  });

  it("rejects invalid verbs", () => {
    expect(() => buildRecipeVerbScript("/x", "start.sh", "reboot" as never)).toThrow("invalid recipe verb");
  });
});

describe("serve probe builder/parser", () => {
  it("includes health and models sections only when a port is set", () => {
    expect(buildServeProbeCommand(null)).not.toContain("__S_HEALTH__");
    expect(buildServeProbeCommand(8081)).toContain("http://127.0.0.1:8081/health");
  });

  it("parses container states, health code, and model ids", () => {
    const out = [
      "__S_CONTAINERS__",
      "glm53-exl3-head|running",
      "glm53-exl3-worker|exited",
      "permission denied for docker socket",
      "__S_HEALTH__",
      "200",
      "__S_MODELS__",
      '{"data":[{"id":"org/GLM-5.3-Flash-EXL3"}]}',
    ].join("\n");
    const probe = parseServeProbe(out);
    expect(probe.containers).toEqual({ "glm53-exl3-head": "running", "glm53-exl3-worker": "exited" });
    expect(probe.dockerError).toContain("permission denied");
    expect(probe.health).toBe(200);
    expect(parseModelIds(probe.modelsRaw)).toEqual(["org/GLM-5.3-Flash-EXL3"]);
  });

  it("flags missing probe output", () => {
    expect(parseServeProbe("garbage").parseError).toBeTruthy();
  });

  it("ranks expected containers with absent/error fallbacks", () => {
    const probe = parseServeProbe("__S_CONTAINERS__\nhead|running\n__S_HEALTH__\n000\n");
    expect(rankStates({ CONTAINER_HEAD: "head", CONTAINER_WORKER: "worker" }, probe)).toEqual({
      CONTAINER_HEAD: "running",
      CONTAINER_WORKER: "absent",
    });
    expect(rankStates({ CONTAINER_HEAD: "head" }, { containers: {}, dockerError: "cannot connect" })).toEqual({
      CONTAINER_HEAD: "error",
    });
  });
});

describe("joinServeState", () => {
  const runningJob = { state: "running" as const, exitCode: null };
  const base = { desired: "running" as const };

  it("orphan wins over everything", () => {
    expect(joinServeState({ ...base, orphaned: true, job: runningJob, probe: { health: 200 } }).state).toBe("orphan");
  });

  it("desired=stopped with a live job is stopping, never failed", () => {
    expect(joinServeState({ desired: "stopped", job: runningJob }).state).toBe("stopping");
  });

  it("healthy when API up; warmup while the driver still runs", () => {
    expect(joinServeState({ desired: "running", probe: { health: 200 }, servedName: "glm" })).toMatchObject({ state: "healthy", warmup: false });
    expect(joinServeState({ desired: "running", job: runningJob, probe: { health: 200 }, servedName: "glm" })).toMatchObject({ state: "healthy", warmup: true });
  });

  it("foreign when the port answers with another engine", () => {
    expect(
      joinServeState({ desired: "running", probe: { health: 200, modelsRaw: '{"id":"other/model"}' }, servedName: "glm" }).state,
    ).toBe("foreign");
  });

  it("model-id match normalizes case and org prefix", () => {
    expect(
      joinServeState({ desired: "running", probe: { health: 200, modelsRaw: '{"id":"org/glm"}' }, servedName: "GLM" }).state,
    ).toBe("healthy");
  });

  it("starting while API is silent and the driver runs", () => {
    expect(joinServeState({ desired: "running", job: runningJob, ranks: { H: "running" } }).state).toBe("starting");
  });

  it("keyed engines with 401 are healthy-keyed when containers run", () => {
    expect(joinServeState({ desired: "running", probe: { health: 401 }, ranks: { H: "running" } }).state).toBe("healthy-keyed");
  });

  it("unknown on docker probe errors, up when containers run but API silent", () => {
    expect(joinServeState({ desired: "running", probe: { dockerError: "x" } }).state).toBe("unknown");
    expect(joinServeState({ desired: "running", ranks: { H: "running" } })).toMatchObject({ state: "up" });
  });

  it("failed when the driver exits nonzero with desired running", () => {
    expect(joinServeState({ desired: "running", job: { state: "failed", exitCode: 3 } }).state).toBe("failed");
  });

  it("stopped when nothing runs", () => {
    expect(joinServeState({ desired: "stopped" }).state).toBe("stopped");
  });
});

describe("DeploymentStore", () => {
  async function store() {
    const file = join(await mkdtemp(join(tmpdir(), "cc-deps-")), "serve-deployments.json");
    return new DeploymentStore({ filePath: file, now: () => 1_000 });
  }

  it("one deployment per recipe; seed fields apply on create", async () => {
    const s = await store();
    const a = s.upsertForRecipe("r1", { sparkId: "dgx1", entry: "start.sh", port: 8081 });
    const b = s.upsertForRecipe("r1", { sparkId: "dgx2", entry: "other.sh" });
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ sparkId: "dgx1", entry: "start.sh", port: 8081, desired: "stopped" });
  });

  it("persists patches across reloads", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "cc-deps-")), "serve-deployments.json");
    const s = new DeploymentStore({ filePath: file, now: () => 1_000 });
    const d = s.upsertForRecipe("r1", { sparkId: "dgx1", entry: "start.sh", port: 8081 }, { desired: "running" });
    const reloaded = new DeploymentStore({ filePath: file, now: () => 2_000 });
    expect(reloaded.get(d.id)?.desired).toBe("running");
    expect(reloaded.byRecipe("r1")?.id).toBe(d.id);
  });
});

describe("DeploymentSupervisor", () => {
  interface Harness {
    supervisor: DeploymentSupervisor;
    store: DeploymentStore;
    jobs: JobsManager;
    sent: Array<{ type: string; reqId?: string; argv?: string[] }>;
    deploymentId: string;
    finish(reqId: string, code: number, output?: string): void;
  }

  async function harness(): Promise<Harness> {
    const file = join(await mkdtemp(join(tmpdir(), "cc-deps-")), "d.json");
    const store = new DeploymentStore({ filePath: file, now: () => 1_000 });
    const sent: Array<{ type: string; reqId?: string; argv?: string[] }> = [];
    const jobs = new JobsManager({ send: (_n, msg) => (sent.push(msg as never), true), isConnected: () => true });
    const recipes = {
      get: (id: string) =>
        id === "r1"
          ? {
              id: "r1",
              sparkId: "dgx1",
              path: "/opt/recipes/GLM",
              entry: "start.sh",
              meta: { port: 8081, servedName: "GLM", containers: { CONTAINER_HEAD: "head" } },
              versions: { gitHead: "abc", dirtyBuild: false },
            }
          : id === "r2"
            ? { id: "r2", sparkId: "dgx1", path: "/opt/recipes/X", entry: null, meta: null, versions: null }
            : null,
    };
    const supervisor = new DeploymentSupervisor({ jobs, recipes, store });
    const d = store.upsertForRecipe("r1", { sparkId: "dgx1", entry: "start.sh", port: 8081, servedName: "GLM" });
    return {
      supervisor,
      store,
      jobs,
      sent,
      deploymentId: d.id,
      finish: (reqId, code, output = "") => {
        if (output) jobs.observeMessage("dgx1", { type: "job-out", reqId, stream: "out", chunk: output });
        jobs.observeMessage("dgx1", { type: "job-exit", reqId, code });
      },
    };
  }

  it("start dispatches the verb script and merges done into the record", async () => {
    const h = await harness();
    const result = h.supervisor.start(h.deploymentId);
    if ("error" in result) throw new Error(result.error);
    expect(h.sent[0]!).toMatchObject({ type: "job-run" });
    expect(h.sent[0]!.argv?.[2]).toContain("./start.sh start");
    h.finish(result.reqId, 0);
    expect(h.store.get(h.deploymentId)!).toMatchObject({ desired: "running", jobState: "done" });
    expect(h.store.get(h.deploymentId)?.startedWith).toEqual({ gitHead: "abc", dirtyBuild: false });
  });

  it("probe captures parsed container/health state with ranks", async () => {
    const h = await harness();
    const result = h.supervisor.probe(h.deploymentId);
    if ("error" in result) throw new Error(result.error);
    h.finish(result.reqId, 0, "__S_CONTAINERS__\nhead|running\n__S_HEALTH__\n200\n");
    const d = h.store.get(h.deploymentId)!;
    expect(d.lastProbe).toMatchObject({ health: 200, parsedAt: expect.any(Number) });
    expect((d.lastProbe as Record<string, unknown>).ranks).toEqual({ CONTAINER_HEAD: "running" });
  });

  it("stop flips desired only when the verb succeeds", async () => {
    const h = await harness();
    h.store.upsertForRecipe("r1", { sparkId: "dgx1" }, { desired: "running" });
    const result = h.supervisor.stop(h.deploymentId);
    if ("error" in result) throw new Error(result.error);
    h.finish(result.reqId, 1);
    expect(h.store.get(h.deploymentId)).toMatchObject({ desired: "running", jobState: "failed" });
  });

  it("rejects verbs on unknown deployments and unprobed recipes", async () => {
    const h = await harness();
    expect(h.supervisor.start("nope")).toEqual({ error: "unknown deployment" });
    h.store.upsertForRecipe("r2", { sparkId: "dgx1", entry: null });
    const noEntry = h.supervisor.start(h.store.byRecipe("r2")!.id);
    expect("error" in noEntry && noEntry.error).toBe("recipe not probed yet — no entry script");
  });
});
