import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDb } from "./stores/db.js";
import { MetricsStore } from "./stores/metricsStore.js";
import { TracesStore } from "./stores/tracesStore.js";
import { AlertsStore } from "./stores/alertsStore.js";
import { EnergyStore } from "./stores/energyStore.js";
import { ClientsStore } from "./gateway/clients.js";
import { ServedModelsStore } from "./gateway/servedModels.js";
import { RecipeStore } from "./serving/recipes.js";
import { DeploymentStore } from "./serving/deployments.js";
import { ChatStore } from "./chat/store.js";
import { seedMockData, fakeJobBehavior, type SeedDeps } from "./mockData.js";

const DAY = 86_400_000;
const FIXED_NOW = 1_750_000_000_000; // deterministic anchor; every row is relative to it

interface Harness extends SeedDeps {
  db: Database;
  close(): void;
}

async function scratchDeps(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "cc-mockdata-"));
  const db = openDb(join(dir, "m.db"), 0);
  const now = () => FIXED_NOW;
  return {
    db,
    metrics: new MetricsStore(db, { now }),
    traces: new TracesStore({ db, now }),
    alerts: new AlertsStore({ db, now }),
    clients: new ClientsStore({ filePath: join(dir, "clients.json"), now }),
    servedModels: new ServedModelsStore({ filePath: join(dir, "served.json"), now }),
    recipes: new RecipeStore({ filePath: join(dir, "recipes.json"), now }),
    deployments: new DeploymentStore({ filePath: join(dir, "deployments.json"), now }),
    chat: new ChatStore({ db, now }),
    now,
    close: () => db.close(),
  };
}

describe("seedMockData", () => {
  it("seeds gateway traces over the last 24 h with failures and slow tails", async () => {
    const deps = await scratchDeps();
    seedMockData(deps);
    const traces = deps.traces.list({ since: FIXED_NOW - DAY });
    expect(traces.length).toBeGreaterThanOrEqual(35);
    expect(traces.length).toBeLessThanOrEqual(45);
    expect(Math.max(...traces.map((t) => t.ts))).toBeLessThanOrEqual(FIXED_NOW);
    expect(Math.min(...traces.map((t) => t.ts))).toBeGreaterThanOrEqual(FIXED_NOW - DAY);

    const failed = traces.filter((t) => t.status === 502);
    expect(failed.length).toBeGreaterThanOrEqual(3);
    for (const f of failed) {
      expect(f.error).toBeTruthy();
      expect(f.attempts.length).toBeGreaterThanOrEqual(2);
      expect(f.ttftMs).toBeNull(); // no first chunk reached the recorder on a 502
    }
    expect(traces.filter((t) => t.ttftMs !== null && t.ttftMs > 2000).length).toBeGreaterThanOrEqual(2);
    expect(traces.some((t) => t.stream && t.itl.length > 0)).toBe(true);
    expect(traces.filter((t) => t.attempts.length > 1).length).toBeGreaterThanOrEqual(2);
    expect(traces.every((t) => t.alias === "glm-live" || t.alias === "qwen-local")).toBe(true);
    expect(traces.some((t) => (t.promptTokens ?? 0) > 0 && (t.completionTokens ?? 0) > 0)).toBe(true);
    deps.close();
  });

  it("trace client names match the seeded gateway clients", async () => {
    const deps = await scratchDeps();
    seedMockData(deps);
    const names = new Set(deps.clients.list().map((c) => c.name));
    for (const t of deps.traces.list({})) {
      if (t.client) expect(names.has(t.client)).toBe(true);
    }
    deps.close();
  });

  it("seeds clients (one revoked), served-model chains, recipes + deployments", async () => {
    const deps = await scratchDeps();
    seedMockData(deps);
    const clients = deps.clients.list();
    expect(clients.length).toBe(4);
    expect(clients.filter((c) => c.revokedAt !== null).length).toBe(1);
    expect(clients.filter((c) => c.lastSeenAt !== null).length).toBeGreaterThanOrEqual(2);
    for (const c of clients) expect(c.scopes.length).toBeGreaterThan(0);

    expect(deps.servedModels.byAlias("glm-live")?.targets.map((t) => t.nodeId)).toEqual(["dgx1", "dgx2"]);
    expect(deps.servedModels.byAlias("qwen-local")).not.toBeNull();

    const recipes = deps.recipes.list();
    expect(recipes.length).toBeGreaterThanOrEqual(2);
    for (const r of recipes) expect(r.versions?.gitHead).toMatch(/^[0-9a-f]{40}$/);
    const deployments = deps.deployments.list();
    expect(deployments.length).toBeGreaterThanOrEqual(1);
    const running = deployments.find((d) => d.desired === "running");
    expect(running?.servedName).toBeTruthy();
    expect(running?.port).toBeTypeOf("number");
    deps.close();
  });

  it("seeds a firing critical and a resolved warning with their event trail", async () => {
    const deps = await scratchDeps();
    seedMockData(deps);
    const alerts = deps.alerts.list({});
    const firing = alerts.filter((a) => a.state === "firing" && a.severity === "critical");
    expect(firing).toHaveLength(1);
    expect(firing[0]!.entity).toBeTruthy();
    const resolved = alerts.filter((a) => a.state === "resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.severity).toBe("warning");
    const kinds = deps.alerts.events({ alertId: resolved[0]!.id }).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["fired", "acknowledged", "resolved"]));
    deps.close();
  });

  it("backfills 7 days of energy buckets readable by EnergyStore", async () => {
    const deps = await scratchDeps();
    seedMockData(deps);
    const energy = new EnergyStore(deps.db, { kwhCost: 0.3 });
    const week = energy.summary(FIXED_NOW - 7 * DAY);
    expect(week.totalKwh).toBeGreaterThan(1);
    expect(week.totalCost).toBeGreaterThan(0);
    expect(week.daily.length).toBeGreaterThanOrEqual(5);
    const nodeIds = new Set(week.daily.map((b) => b.nodeId));
    expect(nodeIds.has("dgx1")).toBe(true);
    expect(nodeIds.has("dgx2")).toBe(true);
    // Watt leaves stay in the 120–450 realism band across all 1m buckets.
    const rows = deps.db
      .prepare(`SELECT avg FROM metrics_1m WHERE domain = 'gpu'`)
      .all() as Array<{ avg: string }>;
    expect(rows.length).toBeGreaterThan(5000);
    for (const r of rows) {
      for (const v of Object.values(JSON.parse(r.avg) as Record<string, number>)) {
        if (!String(Object.keys(JSON.parse(r.avg) as Record<string, number>)[0]).includes("watts")) continue;
        expect(v).toBeGreaterThanOrEqual(100);
        expect(v).toBeLessThanOrEqual(460);
      }
    }
  });

  it("seeds a chat conversation", async () => {
    const deps = await scratchDeps();
    seedMockData(deps);
    expect(deps.chat.listConversations().length).toBeGreaterThanOrEqual(1);
    expect(deps.chat.listFolders().length).toBeGreaterThanOrEqual(1);
    deps.close();
  });

  it("is idempotent: a second seed pass duplicates no rows", { timeout: 60_000 }, async () => {
    const deps = await scratchDeps();
    seedMockData(deps);
    const energy = new EnergyStore(deps.db, { kwhCost: 0.3 });
    const before = {
      traces: deps.traces.list({}).length,
      clients: deps.clients.list().length,
      alerts: deps.alerts.list({}).length,
      events: deps.alerts.events({}).length,
      recipes: deps.recipes.list().length,
      deployments: deps.deployments.list().length,
      served: deps.servedModels.list().length,
      convs: deps.chat.listConversations().length,
      folders: deps.chat.listFolders().length,
      kwh: energy.summary(FIXED_NOW - 7 * DAY).totalKwh,
    };
    seedMockData(deps);
    expect(deps.traces.list({}).length).toBe(before.traces);
    expect(deps.clients.list().length).toBe(before.clients);
    expect(deps.alerts.list({}).length).toBe(before.alerts);
    expect(deps.alerts.events({}).length).toBe(before.events);
    expect(deps.recipes.list().length).toBe(before.recipes);
    expect(deps.deployments.list().length).toBe(before.deployments);
    expect(deps.servedModels.list().length).toBe(before.served);
    expect(deps.chat.listConversations().length).toBe(before.convs);
    expect(deps.chat.listFolders().length).toBe(before.folders);
    // Same-minute buckets merge, never double-count.
    expect(energy.summary(FIXED_NOW - 7 * DAY).totalKwh).toBeCloseTo(before.kwh, 6);
    deps.close();
  });
});

describe("fakeJobBehavior", () => {
  it("routes `modelctl list --json` to the store catalog", () => {
    const res = fakeJobBehavior("nas1", ["modelctl", "list", "--json"]);
    expect(res?.exitCode).toBe(0);
    const catalog = JSON.parse(res!.output![0]!) as Array<{ name: string; repository: string; runtime?: string; bytes?: number }>;
    expect(catalog.length).toBeGreaterThanOrEqual(4);
    for (const m of catalog) {
      expect(m.name).toBeTruthy();
      expect(m.repository).toBeTruthy();
      if (m.bytes !== undefined) expect(m.bytes).toBeGreaterThan(0);
    }
  });

  it("routes `modelctl list --local --json` to per-node subsets of the catalog", () => {
    const catalog = new Set(
      (JSON.parse(fakeJobBehavior("nas1", ["modelctl", "list", "--json"])!.output![0]!) as Array<{ name: string }>).map((m) => m.name),
    );
    for (const node of ["dgx1", "dgx2"]) {
      const local = fakeJobBehavior(node, ["modelctl", "list", "--local", "--json"]);
      expect(local?.exitCode).toBe(0);
      const rows = JSON.parse(local!.output![0]!) as Array<{ name: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const m of rows) expect(catalog.has(m.name)).toBe(true);
    }
    // Unknown nodes report an empty local cache, never garbage.
    expect(fakeJobBehavior("zzz", ["modelctl", "list", "--local", "--json"])!.output).toEqual(["[]"]);
  });

  it("falls through to null for unmatched argv (FakeNode default placeholder preserved)", () => {
    expect(fakeJobBehavior("dgx1", ["modelctl", "pull", "x"])).toBeNull();
    expect(fakeJobBehavior("dgx1", ["uptime"])).toBeNull();
  });
});
