import { describe, expect, it } from "vitest";
import { OnDemandManager } from "./onDemand.js";
import { ServedModelsStore } from "./servedModels.js";
import { DeploymentStore, DeploymentSupervisor } from "../serving/deployments.js";
import { JobsManager } from "../jobs/jobsManager.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

function harness(now: { t: number }) {
  const served = new ServedModelsStore({ filePath: join(tmpdir(), `od-${Math.random().toString(36).slice(2)}-sm.json`), now: () => now.t });
  const deployments = new DeploymentStore({ filePath: join(tmpdir(), `od-${Math.random().toString(36).slice(2)}-d.json`), now: () => now.t });
  const jobs = new JobsManager({ send: () => true, isConnected: () => true });
  const supervisor = new DeploymentSupervisor({
    jobs,
    recipes: {
      get: (id: string) => ({ id, sparkId: "dgx1", path: "/r", entry: "start.sh", meta: null, versions: null }),
    },
    store: deployments,
  });
  served.upsert({
    alias: "spun",
    targets: [{ nodeId: "dgx1", port: 9999 }],
    onDemand: { recipeId: "r1", idleStopS: 60 },
  });
  const manager = new OnDemandManager({ servedModels: served, deployments, supervisor, now: () => now.t, defaultIdleStopS: 300 });
  return { manager, served, deployments, jobs, supervisor };
}

describe("OnDemandManager", () => {
  it("spins up the recipe deployment on first request (single-flight)", async () => {
    const now = { t: 1_000 };
    const h = harness(now);
    const [a, b] = await Promise.all([h.manager.ensureUp("spun"), h.manager.ensureUp("spun")]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.reason).toBe("started");
    // Exactly one start driver was dispatched (single-flight per alias).
    const startJobs = h.jobs.list().filter((j) => j.kind === "recipe-verb:start");
    expect(startJobs).toHaveLength(1);
    expect(startJobs[0]!.argv[2]).toContain("./start.sh start");
  });

  it("reports running when the deployment is already up", async () => {
    const now = { t: 1_000 };
    const h = harness(now);
    h.deployments.upsertForRecipe("r1", { sparkId: "dgx1", entry: "start.sh" }, { desired: "running", jobState: "done" });
    const out = await h.manager.ensureUp("spun");
    expect(out).toEqual({ ok: true, reason: "running" });
  });

  it("sweeps idle router-managed deployments after idleStopS", async () => {
    const now = { t: 1_000 };
    const h = harness(now);
    h.deployments.upsertForRecipe("r1", { sparkId: "dgx1", entry: "start.sh" }, { desired: "running", jobState: "done" });
    h.manager.touch("spun"); // last request now
    now.t = 30_000;
    expect(h.manager.sweepIdle()).toEqual([]); // 29s idle < 60s
    now.t = 90_000;
    const stopped = h.manager.sweepIdle(); // 89s idle > 60s → stop dispatched
    expect(stopped).toHaveLength(1);
    const stopJobs = h.jobs.list().filter((j) => j.kind === "recipe-verb:stop");
    expect(stopJobs).toHaveLength(1);
  });

  it("never touches always-on models", () => {
    const now = { t: 1_000 };
    const h = harness(now);
    h.served.upsert({ alias: "always", targets: [{ nodeId: "dgx1", port: 1 }] });
    h.deployments.upsertForRecipe("r-always", { sparkId: "dgx1", entry: "start.sh" }, { desired: "running", jobState: "done" });
    expect(h.manager.sweepIdle()).toEqual([]);
  });

  it("refuses aliases without onDemand config", async () => {
    const h = harness({ t: 1_000 });
    const out = await h.manager.ensureUp("nope");
    expect(out).toEqual({ ok: false, reason: "no-config" });
  });
});
