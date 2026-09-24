import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { MetricsStore } from "./metricsStore.js";

const dir = mkdtempSync(join(tmpdir(), "cc-metrics-"));
const dbPath = join(dir, "metrics.db");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SAMPLE = { gpu: { utilPct: 78, tempC: 64, watts: 202 }, cpu: { loadPct: 41 } };

function minute(tsBase: number, offsetMin: number): number {
  return tsBase + offsetMin * 60_000;
}

describe("db migrations", () => {
  it("creates tables once and is idempotent across opens", () => {
    const db = openDb(":memory:", 1_000);
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain("metrics_1m");
    expect(tables).toContain("metrics_1h");
    expect(tables).toContain("metrics_1d");
    expect(tables).toContain("schema_migrations");

    const again = openDb(":memory:", 2_000);
    const versions = (again.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version);
    expect(versions).toEqual([1, 2, 3, 4]);
    again.close();
    db.close();
  });
});

describe("MetricsStore", () => {
  it("merges snapshots within a minute and across granularities", () => {
    const db = openDb(":memory:");
    const store = new MetricsStore(db);
    const base = 1_700_000_000_000; // aligned-ish; buckets computed from ts

    store.ingest("dgx1", { ts: base, domains: SAMPLE });
    store.ingest("dgx1", { ts: base + 30_000, domains: { gpu: { utilPct: 90, tempC: 70, watts: 240 }, cpu: { loadPct: 60 } } });
    store.flush();

    const rows = store.query("gpu", { node: "dgx1", from: 0, to: Number.MAX_SAFE_INTEGER, granularity: "1m" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data.n).toBe(2);
    expect(rows[0]?.data.avg["utilPct"]).toBe(84);
    expect(rows[0]?.data.max["utilPct"]).toBe(90);
    expect(rows[0]?.data.max["tempC"]).toBe(70);

    const hour = store.query("gpu", { node: "dgx1", from: 0, to: Number.MAX_SAFE_INTEGER, granularity: "1h" });
    expect(hour).toHaveLength(1);
    expect(hour[0]?.data.n).toBe(2);
    expect(hour[0]?.data.max["watts"]).toBe(240);

    const day = store.query("gpu", { from: 0, to: Number.MAX_SAFE_INTEGER, granularity: "1d" });
    expect(day).toHaveLength(1);
    db.close();
  });

  it("keeps nodes isolated within the same bucket", () => {
    const db = openDb(":memory:");
    const store = new MetricsStore(db);
    const ts = 1_700_000_060_000;
    store.ingest("dgx1", { ts, domains: { cpu: { loadPct: 10 } } });
    store.ingest("dgx2", { ts, domains: { cpu: { loadPct: 90 } } });
    store.flush();
    const rows = store.query("cpu", { from: 0, to: Number.MAX_SAFE_INTEGER, granularity: "1m" });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.data.avg["loadPct"]).sort()).toEqual([10, 90]);
    db.close();
  });

  it("separates minutes into distinct buckets", () => {
    const db = openDb(":memory:");
    const store = new MetricsStore(db);
    const base = 1_700_000_000_000;
    store.ingest("dgx1", { ts: minuteAligned(base), domains: SAMPLE });
    store.ingest("dgx1", { ts: minuteAligned(base) + 60_000, domains: SAMPLE });
    store.flush();
    expect(store.query("gpu", { from: 0, to: Number.MAX_SAFE_INTEGER, granularity: "1m" })).toHaveLength(2);
    db.close();
  });

  it("prunes buckets older than retention per granularity", () => {
    const db = openDb(":memory:");
    const now = 1_800_000_000_000;
    const store = new MetricsStore(db, { now: () => now, retentionDays: { "1m": 7, "1h": 90, "1d": 365 } });
    const old = now - 8 * 86_400_000;
    store.ingest("dgx1", { ts: old, domains: SAMPLE });
    store.ingest("dgx1", { ts: now - 60_000, domains: SAMPLE });
    store.flush();
    const deleted = store.prune(now);
    expect(deleted["1m"]).toBeGreaterThanOrEqual(1);
    // fresh row survives at every granularity
    const fresh = store.query("gpu", { from: now - 120_000, to: now, granularity: "1m" });
    expect(fresh).toHaveLength(1);
    db.close();
  });

  it("round-trips through a real file (WAL, reopen preserves rows)", () => {
    const db = openDb(dbPath);
    const store = new MetricsStore(db);
    const ts = 1_700_000_000_000;
    store.ingest("dgx1", { ts, domains: SAMPLE });
    store.flush();
    db.close();

    const reopened = openDb(dbPath);
    const store2 = new MetricsStore(reopened);
    expect(store2.query("gpu", { node: "dgx1", from: 0, to: Number.MAX_SAFE_INTEGER, granularity: "1m" })).toHaveLength(1);
    reopened.close();
  });
});

function minuteAligned(ts: number): number {
  return Math.floor(ts / 60_000) * 60_000;
}
