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
    const calls: Array<string | null> = [];
    const outcome = await reconcileClocks(file, { applyProfile: async (p) => void calls.push(p) }, 5_000);
    expect(outcome).toEqual({ applied: true });
    expect(calls).toEqual(["cool"]);
    const state = await loadAgentState(file);
    expect(state.lastApplied).toEqual({ clockProfileId: "cool", at: 5_000 });
  });

  it("never applies when desired and lastApplied are both unset (first boot)", async () => {
    const { file } = await tmpFile();
    const calls: Array<string | null> = [];
    const outcome = await reconcileClocks(file, { applyProfile: async (p) => void calls.push(p) }, 5_000);
    expect(outcome).toEqual({ applied: false });
    expect(calls).toEqual([]);
  });

  it("is idempotent: no apply when lastApplied matches the desired profile", async () => {
    const { file } = await tmpFile();
    await setDesiredProfile(file, "cool");
    await reconcileClocks(file, { applyProfile: async () => {} }, 5_000);
    const calls: Array<string | null> = [];
    const outcome = await reconcileClocks(file, { applyProfile: async (p) => void calls.push(p) }, 6_000);
    expect(outcome).toEqual({ applied: false });
    expect(calls).toEqual([]);
  });

  it("re-applies when the desired profile changes", async () => {
    const { file } = await tmpFile();
    await setDesiredProfile(file, "cool");
    await reconcileClocks(file, { applyProfile: async () => {} }, 5_000);
    await setDesiredProfile(file, "whisper");
    const calls: Array<string | null> = [];
    await reconcileClocks(file, { applyProfile: async (p) => void calls.push(p) }, 6_000);
    expect(calls).toEqual(["whisper"]);
  });

  it("reverts to default (null profile) and still applies", async () => {
    const { file } = await tmpFile();
    await setDesiredProfile(file, "cool");
    await reconcileClocks(file, { applyProfile: async () => {} }, 5_000);
    await setDesiredProfile(file, null);
    const calls: Array<string | null> = [];
    await reconcileClocks(file, { applyProfile: async (p) => void calls.push(p) }, 6_000);
    expect(calls).toEqual([null]);
  });

  it("failed applies are not recorded — next reconcile retries", async () => {
    const { file } = await tmpFile();
    await setDesiredProfile(file, "cool");
    const failing = { applyProfile: async () => { throw new Error("sudo: no tty"); } };
    const outcome = await reconcileClocks(file, failing, 5_000);
    expect(outcome).toEqual({ applied: false, error: "Error: sudo: no tty" });
    const state = await loadAgentState(file);
    expect(state.lastApplied).toBeNull();

    const calls: Array<string | null> = [];
    await reconcileClocks(file, { applyProfile: async (p) => void calls.push(p) }, 6_000);
    expect(calls).toEqual(["cool"]);
  });

  it("state survives a reload from disk (atomic write)", async () => {
    const { file } = await tmpFile();
    await setDesiredProfile(file, "whisper");
    await reconcileClocks(file, { applyProfile: async () => {} }, 5_000);
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw).toMatchObject({ version: 1, clockProfileId: "whisper", lastApplied: { clockProfileId: "whisper" } });
  });
});
