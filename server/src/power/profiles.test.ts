import { describe, expect, it } from "vitest";
import {
  CLOCK_PROFILES,
  applyCommands,
  profileById,
  resolveProfile,
  revertCommands,
  verifyCommands,
} from "./profiles.js";
import { ClockProfileStore } from "./clockStore.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("clock profiles", () => {
  it("defines the verified profile set", () => {
    expect(CLOCK_PROFILES.map((p) => p.id)).toEqual(["full", "eco", "quiet"]);
    const eco = profileById("eco")!;
    expect(eco).toMatchObject({ gpuMaxMhz: 2200, cpuMaxMhz: 2000 });
    expect(profileById("nope")).toBeNull();
  });

  it("emits exact sudoers-scoped apply commands", () => {
    const eco = resolveProfile(profileById("eco")!, null);
    expect(applyCommands(eco)).toEqual(["sudo nvidia-smi -lgc 0,2200", "sudo cpupower frequency-set -u 2000MHz"]);
    // full = no caps → no commands
    expect(applyCommands(resolveProfile(profileById("full")!, null))).toEqual([]);
  });

  it("clamps profile values into reported hw limits", () => {
    const eco = profileById("eco")!;
    // GB10 CPU hw max 2.81 GHz; a node reporting a lower max clamps the request.
    const r = resolveProfile(eco, { gpuMinMhz: 0, gpuMaxMhz: 2010, cpuMinMhz: 338, cpuMaxMhz: 2810 });
    expect(r).toMatchObject({ profileId: "eco", gpuMaxMhz: 2010, cpuMaxMhz: 2000, clamped: true });
    // Values below the hw floor clamp up.
    const low = resolveProfile({ ...eco, gpuMaxMhz: 100, cpuMaxMhz: 100 }, { gpuMinMhz: 300, gpuMaxMhz: 2670, cpuMinMhz: 338, cpuMaxMhz: 2810 });
    expect(low).toMatchObject({ gpuMaxMhz: 300, cpuMaxMhz: 338, clamped: true });
    // No hw data → pass-through.
    expect(resolveProfile(eco, null)).toMatchObject({ gpuMaxMhz: 2200, cpuMaxMhz: 2000, clamped: false });
  });

  it("revert lifts caps within the sudoers scope; verify is read-only", () => {
    expect(revertCommands()).toEqual(["sudo nvidia-smi -rgc", "sudo cpupower frequency-set -u 2810MHz"]);
    expect(verifyCommands()).toEqual(["nvidia-smi -q -d CLOCK", "cpupower frequency-info"]);
  });
});

describe("ClockProfileStore", () => {
  async function store() {
    const file = join(await mkdtemp(join(tmpdir(), "cc-clock-")), "clock-profiles.json");
    return new ClockProfileStore({ filePath: file, now: () => 1_000 });
  }

  it("defaults to full, persists set desires across reloads", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "cc-clock-")), "clock-profiles.json");
    const s = new ClockProfileStore({ filePath: file, now: () => 1_000 });
    expect(s.desiredFor("dgx1").profile).toBe("full");
    s.set("dgx1", "eco", "ui");
    expect(s.desiredFor("dgx1")).toMatchObject({ profile: "eco", updatedBy: "ui", updatedAt: 1_000 });
    expect(s.set("dgx1", "turbo")).toBeNull();

    const reloaded = new ClockProfileStore({ filePath: file, now: () => 2_000 });
    expect(reloaded.desiredFor("dgx1").profile).toBe("eco");
    expect(reloaded.desiredFor("dgx2").profile).toBe("full");
  });

  it("clears back to default", async () => {
    const s = await store();
    s.set("dgx1", "quiet");
    expect(s.clear("dgx1")).toBe(true);
    expect(s.desiredFor("dgx1").profile).toBe("full");
    expect(s.clear("dgx1")).toBe(false);
  });
});
