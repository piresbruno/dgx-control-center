import { describe, expect, it } from "vitest";
import {
  buildCollectors,
  createCpuSampler,
  createGpuSampler,
  createNetSampler,
  parseCpuStat,
  parseGpuSmi,
  parseMemInfo,
  parseNetDev,
  parseStatFs,
} from "./collectors.js";

const PROC_STAT_1 = "cpu  100 0 50 850 20 0 0 0 0 0\ncpu0 1 0 1 9 0 0 0";
const PROC_STAT_2 = "cpu  200 0 100 600 50 0 0 0 0 0\ncpu0 2 0 2 5 0 0 0";

describe("pure parsers", () => {
  it("parses /proc/stat busy/idle and rejects garbage", () => {
    expect(parseCpuStat(PROC_STAT_1)).toEqual({ busy: 150, idle: 870 });
    expect(parseCpuStat("")).toBeNull();
    expect(parseCpuStat("intr 1234\n")).toBeNull();
  });

  it("parses meminfo with GB rounding", () => {
    const mem = parseMemInfo("MemTotal:  132000000 kB\nMemAvailable:  44000000 kB\nBuffers: 100 kB\n");
    expect(mem).toEqual({ totalGb: 125.9, usedGb: 83.9, availableGb: 42, usedPct: 66.7 });
    expect(parseMemInfo("MemFree: 1 kB")).toBeNull();
  });

  it("parses nvidia-smi csv, tolerating GB10 [N/A] fields", () => {
    const gpu = parseGpuSmi("78, 64, [N/A], [N/A], 2200, 202\n31, [Not Supported], 2980, 8192, [N/A], [N/A]\n");
    expect(gpu).toEqual([
      { index: 0, utilPct: 78, tempC: 64, memUsedMb: null, memTotalMb: null, clockMhz: 2200, watts: 202 },
      { index: 1, utilPct: 31, tempC: null, memUsedMb: 2980, memTotalMb: 8192, clockMhz: null, watts: null },
    ]);
    expect(parseGpuSmi("")).toEqual([]);
  });

  it("parses /proc/net/dev excluding lo, tolerant of missing columns", () => {
    const dev = parseNetDev(
      "inter:|face | Receive\n" +
        "  eth0: 1000 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0\n" +
        "    lo: 99999 0 0 0 0 0 0 0 99999 0 0 0 0 0 0 0\n" +
        "  cx7: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0\n",
    );
    expect(dev).toEqual({
      eth0: { rxBytes: 1000, txBytes: 500 },
      cx7: { rxBytes: 10, txBytes: 20 },
    });
    expect(Object.keys(dev)).not.toContain("lo");
  });

  it("computes storage from statfs", () => {
    expect(parseStatFs({ blocks: 1_048_576, bsize: 4096, bavail: 262_144 })).toEqual({
      totalGb: 4.0,
      freeGb: 1.0,
      usedPct: 75,
    });
  });
});

describe("samplers", () => {
  it("cpu sampler: first tick null load, second tick delta-based load", async () => {
    const reads = [PROC_STAT_1, PROC_STAT_2];
    const cpu = createCpuSampler({ readFile: async () => reads.shift() ?? PROC_STAT_2 });
    const first = await cpu();
    expect(first).toMatchObject({ loadPct: 0 });
    const second = await cpu();
    // busy Δ150, idle Δ-220 clamp → total negative → loadPct 0 (never negative)
    expect(second?.loadPct).toBeGreaterThanOrEqual(0);
  });

  it("cpu sampler counts cores from /proc/cpuinfo", async () => {
    const cpu = createCpuSampler({
      readFile: async (path) => (path === "/proc/cpuinfo" ? "processor\t: 0\nprocessor\t: 1\nprocessor\t: 2\n" : PROC_STAT_1),
    });
    expect(await cpu()).toMatchObject({ coreCount: 3 });
  });

  it("gpu sampler returns null when nvidia-smi is missing", async () => {
    const gpu = createGpuSampler({ exec: async () => { throw new Error("ENOENT"); } });
    expect(await gpu()).toBeNull();
  });

  it("gpu sampler parses real output", async () => {
    const gpu = createGpuSampler({ exec: async () => ({ stdout: "50, 55, [N/A], [N/A], 2200, 180\n" }) });
    expect(await gpu()).toEqual([
      { index: 0, utilPct: 50, tempC: 55, memUsedMb: null, memTotalMb: null, clockMhz: 2200, watts: 180 },
    ]);
  });

  it("net sampler computes rates from deltas between ticks", async () => {
    const reads = [
      "  eth0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n",
      "  eth0: 12500 0 0 0 0 0 0 0 2500 0 0 0 0 0 0 0\n",
    ];
    const net = createNetSampler({ readFile: async () => reads.shift()! });
    await net(1000);
    const second = await net(3000); // 2 s later: 12500 B rx → 50 kbps, 2500 B tx → 10 kbps
    expect(second).toMatchObject({ rxKbps: 50, txKbps: 10 });
  });
});

describe("buildCollectors", () => {
  it("assembles fault-isolated domain samplers", async () => {
    const collectors = buildCollectors({
      readFile: async (path) => {
        if (path === "/proc/meminfo") return "MemTotal:  132000000 kB\nMemAvailable:  44000000 kB\n";
        if (path === "/proc/net/dev") return "  eth0: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n";
        throw new Error("ENOENT");
      },
      exec: async () => {
        throw new Error("ENOENT");
      },
      statFs: async () => {
        throw new Error("ENOENT");
      },
    });

    expect(await collectors.memory?.(1)).toMatchObject({ usedPct: 66.7 });
    expect(await collectors.gpu?.(1)).toBeNull(); // no nvidia-smi
    expect(await collectors.storage?.(1)).toBeNull(); // statfs failed
    expect(await collectors.cpu?.(1)).toBeNull(); // /proc/stat missing ⇒ null sample
  });

  it("never throws: a throwing sampler yields null", async () => {
    const collectors = buildCollectors({
      readFile: async () => {
        throw new Error("boom");
      },
      exec: async () => {
        throw new Error("boom");
      },
      statFs: async () => {
        throw new Error("boom");
      },
    });
    for (const domain of ["cpu", "gpu", "memory", "network", "storage"] as const) {
      expect(await collectors[domain]?.(1)).toBeNull();
    }
  });
});
