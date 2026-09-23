import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { MetricsStore, flattenNumbers } from "./metricsStore.js";
import { EnergyStore } from "./energyStore.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOUR = 3_600_000;

async function dbWithSamples() {
  const file = join(await mkdtemp(join(tmpdir(), "cc-energy-")), "e.db");
  const db = openDb(file, 0);
  const metrics = new MetricsStore(db, { now: () => 0 });
  const H = (h: number, m: number) => h * HOUR + m * 60_000;
  // Node dgx1: two GPUs at 100 W each for two full hours (per-minute buckets).
  for (let m = 0; m < 120; m++) {
    metrics.ingest("dgx1", { ts: H(1, m), domains: { gpu: { gpus: [{ watts: 100 }, { watts: 100 }] } } });
  }
  // Node dgx2: one GPU at 50 W for one hour.
  for (let m = 0; m < 60; m++) {
    metrics.ingest("dgx2", { ts: H(3, m), domains: { gpu: { gpus: [{ watts: 50 }] } } });
  }
  metrics.flush();
  return { db };
}

describe("EnergyStore", () => {
  it("computes kWh and cost from 1m power leaves", async () => {
    const { db } = await dbWithSamples();
    const energy = new EnergyStore(db, { kwhCost: 0.3 });
    const s = energy.summary(0);
    // dgx1: 200 W × 120 min = 0.4 kWh; dgx2: 50 W × 60 min = 0.05 kWh → 0.45 kWh.
    expect(s.totalKwh).toBeCloseTo(0.45, 5);
    expect(s.totalCost).toBeCloseTo(0.135, 5);
    expect(s.hourly).toHaveLength(3);
    expect(s.hourly[0]).toMatchObject({ nodeId: "dgx1", kwh: 0.2, minutes: 60, cost: 0.06 });
    // Daily buckets are per-node (the Energy view breaks down per node).
    expect(s.daily.map((d) => d.kwh).sort()).toEqual([0.05, 0.4]);
  });

  it("filters by node", async () => {
    const { db } = await dbWithSamples();
    const energy = new EnergyStore(db, { kwhCost: 0.1 });
    const s = energy.summary(0, "dgx2");
    expect(s.totalKwh).toBeCloseTo(0.05, 5);
    expect(s.hourly[0]!.nodeId).toBe("dgx2");
  });

  it("rolls monthly buckets", async () => {
    const { db } = await dbWithSamples();
    const energy = new EnergyStore(db, {});
    const s = energy.summary(0);
    expect(s.monthly).toHaveLength(2);
    expect(s.monthly.map((m) => m.kwh).sort((a, b) => a - b)).toEqual([0.05, 0.4]);
  });

  it("ignore-rectifier: flattenNumbers yields leaf paths ending in .watts", () => {
    const leaves = flattenNumbers({ gpus: [{ watts: 1 }, { watts: 2 }] });
    expect(Object.keys(leaves)).toEqual(["gpus.0.watts", "gpus.1.watts"]);
  });
});
