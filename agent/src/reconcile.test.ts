import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentState, reconcileClocks, setDesiredProfile } from "./reconcile.js";

async function tmpFile() {
  const dir = await mkdtemp(join(tmpdir(), "cc-agent-reconcile-"));
  return { dir, file: join(dir, "state.json") };
}

describe("agent local reconcile (F1a edge autonomy)", () => {
  it("applies the desired profile on first boot and records it", async () => {
    const { file } = await tmpFile();
    await setDesiredProfile(file, "cool");
    const calls: Array<{ profileId: string | null; caps: unknown }> = [];
    const outcome = await reconcileClocks(file, { applyProfile: async (p) => void calls.push(p) }, 5_000);
    expect(outcome).toEqual({ applied: true });
    expect(calls).toEqual([{ profileId: "cool", caps: null }]);
    const state = await loadAgentState(file);
    expect(state.lastApplied).toEqual({ clockProfileId: "cool", at: 5_000, caps: null });
  });

  it("never applies when desired and lastApplied are both unset (first boot)", async () => {
    const { file } = await tmpFile();
    const calls: Array<{ profileId: string | null; caps: unknown }> = [];
    const outcome = await reconcileClocks(file, { applyProfile: async (p) => void calls.push(p) }, 5_000);
    expect(outcome).toEqual({ applied: false });
    expect(calls).toEqual([]);
  });

  it("is idempotent: no apply when lastApplied matches the desired profile", async () => {
    const { file } = await tmpFile();
    await setDesiredProfile(file, "cool");
    await reconcileClocks(file, { applyProfile: async () => {} }, 5_000);
    const calls: Array<{ profileId: string | null; caps: unknown }> = [];
    const outcome = await reconcileClocks(file, { applyProfile: async (p) => void calls.push(p) }, 6_000);
    expect(outcome).toEqual({ applied: false });
    expect(calls).toEqual([]);
  });

  it("re-applies when the desired profile changes", async () => {
    const { file } = await tmpFile();
    await setDesiredProfile(file, "cool");
    await reconcileClocks(file, { applyProfile: async () => {} }, 5_000);
    await setDesiredProfile(file, "whisper");
    const calls: Array<{ profileId: string | null; caps: unknown }> = [];
    await reconcileClocks(file, { applyProfile: async (p) => void calls.push(p) }, 6_000);
    expect(calls).toEqual([{ profileId: "whisper", caps: null }]);
  });

  it("reverts to default (null profile) and still applies", async () => {
    const { file } = await tmpFile();
    await setDesiredProfile(file, "cool");
    await reconcileClocks(file, { applyProfile: async () => {} }, 5_000);
    await setDesiredProfile(file, null);
    const calls: Array<{ profileId: string | null; caps: unknown }> = [];
    await reconcileClocks(file, { applyProfile: async (p) => void calls.push(p) }, 6_000);
    expect(calls).toEqual([{ profileId: null, caps: null }]);
  });

  it("failed applies are not recorded — next reconcile retries", async () => {
    const { file } = await tmpFile();
    await setDesiredProfile(file, "cool");
    const failing = { applyProfile: async () => { throw new Error("sudo: no tty"); } };
    const outcome = await reconcileClocks(file, failing, 5_000);
    expect(outcome).toEqual({ applied: false, error: "Error: sudo: no tty" });
    const state = await loadAgentState(file);
    expect(state.lastApplied).toBeNull();

    const calls: Array<{ profileId: string | null; caps: unknown }> = [];
    await reconcileClocks(file, { applyProfile: async (p) => void calls.push(p) }, 6_000);
    expect(calls).toEqual([{ profileId: "cool", caps: null }]);
  });

  it("state survives a reload from disk (atomic write)", async () => {
    const { file } = await tmpFile();
    await setDesiredProfile(file, "whisper");
    await reconcileClocks(file, { applyProfile: async () => {} }, 5_000);
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw).toMatchObject({ version: 1, clockProfileId: "whisper", lastApplied: { clockProfileId: "whisper" } });
  });
});

describe("caps-aware reconcile (M5)", () => {
  it("re-applies when caps change under the same profile id", async () => {
    const { file } = await tmpFile();
    const calls: Array<{ profileId: string | null; caps: unknown }> = [];
    const applier = { applyProfile: async (p: { profileId: string | null; caps: unknown }) => void calls.push(p) };
    await setDesiredProfile(file, "eco", { gpuMaxMhz: 2200, cpuMaxMhz: 2000 });
    await reconcileClocks(file, applier, 1_000);
    await setDesiredProfile(file, "eco", { gpuMaxMhz: 2200, cpuMaxMhz: 1500 });
    const outcome = await reconcileClocks(file, applier, 2_000);
    expect(outcome).toEqual({ applied: true });
    expect(calls[1]).toEqual({ profileId: "eco", caps: { gpuMaxMhz: 2200, cpuMaxMhz: 1500 } });
  });

  it("keeps caps when only the id is pushed, drops caps when the profile clears", async () => {
    const { file } = await tmpFile();
    await setDesiredProfile(file, "eco", { gpuMaxMhz: 2200, cpuMaxMhz: 2000 });
    expect((await loadAgentState(file)).clockCaps).toEqual({ gpuMaxMhz: 2200, cpuMaxMhz: 2000 });
    await setDesiredProfile(file, null);
    expect((await loadAgentState(file)).clockCaps).toBeNull();
  });
});
