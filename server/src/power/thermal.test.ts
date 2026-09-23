import { describe, expect, it } from "vitest";
import { ThermalGuard, DEFAULT_THERMAL_CONFIG } from "./thermal.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function guard() {
  const file = join(await mkdtemp(join(tmpdir(), "cc-thermal-")), "thermal.json");
  const derated: string[] = [];
  const recovered: string[] = [];
  const g = new ThermalGuard({
    filePath: file,
    now: () => 1_000,
    onDerate: (id) => derated.push(id),
    onRecover: (id) => recovered.push(id),
    config: { recoverHoldMs: 60_000 },
  });
  return { g, derated, recovered, file };
}

describe("ThermalGuard", () => {
  it("uses the verified defaults", () => {
    expect(DEFAULT_THERMAL_CONFIG).toEqual({ derateTempC: 80, recoverTempC: 75, recoverHoldMs: 300_000 });
  });

  it("derates at the threshold and fires the hook once", async () => {
    const { g, derated } = await guard();
    const events = g.tick([{ sparkId: "dgx1", gpuTempC: 70 }]);
    expect(events).toEqual([]);
    expect(g.stateFor("dgx1")).toBe("nominal");
    const derate = g.tick([{ sparkId: "dgx1", gpuTempC: 81 }]);
    expect(derate).toHaveLength(1);
    expect(derate[0]).toMatchObject({ sparkId: "dgx1", kind: "derate", tempC: 81 });
    expect(g.stateFor("dgx1")).toBe("derated");
    expect(derated).toEqual(["dgx1"]);
    // Still hot — no repeated derate events.
    expect(g.tick([{ sparkId: "dgx1", gpuTempC: 83 }])).toEqual([]);
    expect(derated).toEqual(["dgx1"]);
  });

  it("recovers only after the hold window below the recovery threshold", async () => {
    let now = 1_000_000;
    const file = join(await mkdtemp(join(tmpdir(), "cc-thermal-")), "t.json");
    const recovered: string[] = [];
    const g = new ThermalGuard({ filePath: file, now: () => now, onRecover: (id) => recovered.push(id), config: { recoverHoldMs: 60_000 } });
    g.tick([{ sparkId: "dgx1", gpuTempC: 85 }]); // derate
    now += 10_000;
    g.tick([{ sparkId: "dgx1", gpuTempC: 70 }]); // below → hold starts
    now += 30_000; // 40s < 60s
    expect(g.tick([{ sparkId: "dgx1", gpuTempC: 71 }])).toEqual([]);
    now += 30_000; // 70s ≥ 60s
    const events = g.tick([{ sparkId: "dgx1", gpuTempC: 72 }]);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("recover");
    expect(g.stateFor("dgx1")).toBe("nominal");
    expect(recovered).toEqual(["dgx1"]);
  });

  it("breaks hysteresis when the temperature rises mid-hold", async () => {
    let now = 1_000_000;
    const file = join(await mkdtemp(join(tmpdir(), "cc-thermal-")), "t.json");
    const g = new ThermalGuard({ filePath: file, now: () => now, config: { recoverHoldMs: 60_000 } });
    g.tick([{ sparkId: "dgx1", gpuTempC: 85 }]);
    now += 10_000;
    g.tick([{ sparkId: "dgx1", gpuTempC: 70 }]);
    now += 50_000; // 60s — would recover…
    g.tick([{ sparkId: "dgx1", gpuTempC: 78 }]); // …but spiked above recoverTemp
    now += 20_000;
    g.tick([{ sparkId: "dgx1", gpuTempC: 70 }]); // hold restarts from here
    now += 30_000;
    expect(g.tick([{ sparkId: "dgx1", gpuTempC: 71 }])).toEqual([]);
    now += 31_000;
    const events = g.tick([{ sparkId: "dgx1", gpuTempC: 70 }]);
    expect(events.map((e) => e.kind)).toEqual(["recover"]);
  });

  it("holds state for nodes without temperature data and persists across reloads", async () => {
    let now = 1_000_000;
    const file = join(await mkdtemp(join(tmpdir(), "cc-thermal-")), "t.json");
    const g = new ThermalGuard({ filePath: file, now: () => now });
    g.tick([{ sparkId: "dgx1", gpuTempC: 85 }]);
    g.tick([{ sparkId: "dgx1", gpuTempC: null }]);
    expect(g.stateFor("dgx1")).toBe("derated");

    const reloaded = new ThermalGuard({ filePath: file, now: () => now });
    expect(reloaded.stateFor("dgx1")).toBe("derated");
    expect(reloaded.events("dgx1")).toHaveLength(1);
  });
});
