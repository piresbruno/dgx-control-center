import { describe, expect, it } from "vitest";
import { openDb } from "../stores/db.js";
import { MetricsStore } from "../stores/metricsStore.js";
import { TracesStore } from "../stores/tracesStore.js";
import { SettingsStore } from "./settings.js";
import { runMaintenance } from "./maintenance.js";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("SettingsStore", () => {
  it("defaults safely and persists patches", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "cc-set-")), "settings.json");
    const s = new SettingsStore({ filePath: file });
    expect(s.get()).toMatchObject({ retention: { tracesDays: 7, backupsKeep: 10 }, capture: { payloads: false }, corsOrigins: [] });
    s.patch({ retention: { tracesDays: 3 }, corsOrigins: ["https://dash.example.com"] });
    const reloaded = new SettingsStore({ filePath: file });
    expect(reloaded.get()).toMatchObject({ retention: { tracesDays: 3 }, corsOrigins: ["https://dash.example.com"] });
    // Untouched nested defaults survive a patch.
    expect(reloaded.get().retention.backupsKeep).toBe(10);
  });
});

describe("runMaintenance", () => {
  it("prunes metrics, traces, and extra backups; checkpoints the WAL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-maint-"));
    const db = openDb(join(dir, "cc.db"), 0);
    const metrics = new MetricsStore(db, { now: () => 0 });
    // Two 1m buckets: one fresh, one 10 days old.
    for (const ts of [Date.now(), Date.now() - 10 * DAY]) {
      metrics.ingest("dgx1", { ts, domains: { gpu: { gpus: [{ watts: 100 }] } } });
    }
    metrics.flush();
    const traces = new TracesStore({ db, now: () => 0 });
    traces.insert({ ts: Date.now() - 30 * DAY, client: "old", alias: "glm", model: null, nodeId: "dgx1", port: 1, status: 200, ttftMs: 1, durationMs: 1, stream: false, promptTokens: null, completionTokens: null, itl: [], attempts: [], error: null });

    // Two backups; keep 1.
    await writeFile(join(dir, "keep.txt"), "x");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "backups", "2026-01-01T00-00-00-000Z"), { recursive: true });
    mkdirSync(join(dir, "backups", "2026-09-24T00-00-00-000Z"), { recursive: true });

    const settings = new SettingsStore({ filePath: join(dir, "settings.json") });
    settings.patch({ retention: { tracesDays: 7, backupsKeep: 1 } });
    const report = runMaintenance({ db, metrics, traces, configDir: dir, settings: () => settings.get(), now: () => Date.now() });

    expect(report.metricsPruned["1m"]).toBe(1); // the 10-day-old bucket
    expect(report.tracesPruned).toBe(1);
    expect(report.backupsDeleted).toEqual(["2026-01-01T00-00-00-000Z"]);
    expect(report.checkpoint).toBe("done");
    expect((await readdir(join(dir, "backups"))).sort()).toEqual(["2026-09-24T00-00-00-000Z"]);
    // WAL truncated → no wal/shm growth beyond checkpoint.
    expect(report.metricsPruned["1h"]).toBe(0);
  });
});
