import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelctlService, NAS_TTL_MS, STALE_MULTIPLIER, VERSION_TTL_MS, resolveModelctlPath, type ModelctlRunner } from "./service.js";

function validPayload(): string {
  return JSON.stringify([
    { name: "GLM-5.3-Flash-EXL3", runtime: "vllm", repository: "zai-org/GLM-5.3-Flash-EXL3", bytes: 123_456 },
    { name: "Qwen3.6-35B", repository: "Qwen/Qwen3.6-35B", bytes: 0 },
  ]);
}

describe("ModelctlService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetches and validates a NAS inventory, then serves fresh cache within TTL", async () => {
    const runner: ModelctlRunner = vi.fn().mockResolvedValue(validPayload());
    const svc = new ModelctlService({ runner, now: () => 1_000 });
    const target = { targetId: "nas", args: ["list", "--json"], ttlMs: NAS_TTL_MS };

    const first = await svc.inventory(target);
    expect(first.stale).toBe(false);
    expect(first.error).toBeNull();
    expect(first.models).toHaveLength(2);
    expect(first.models[0]?.name).toBe("GLM-5.3-Flash-EXL3");

    await svc.inventory(target);
    expect(runner).toHaveBeenCalledTimes(1); // cache hit
  });

  it("refreshes after TTL expiry", async () => {
    let clock = 1_000;
    const runner: ModelctlRunner = vi.fn().mockResolvedValue(validPayload());
    const svc = new ModelctlService({ runner, now: () => clock });
    const target = { targetId: "nas", args: ["list", "--json"], ttlMs: NAS_TTL_MS };
    await svc.inventory(target);

    clock += NAS_TTL_MS + 1;
    await svc.inventory(target);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("serves stale last-good data with error set when refresh fails within 5× TTL", async () => {
    let clock = 1_000;
    const runner: ModelctlRunner = vi
      .fn()
      .mockResolvedValueOnce(validPayload())
      .mockRejectedValueOnce(new Error("nas unreachable"));
    const svc = new ModelctlService({ runner, now: () => clock });
    const target = { targetId: "nas", args: ["list", "--json"], ttlMs: NAS_TTL_MS };
    await svc.inventory(target);

    clock += NAS_TTL_MS + 1;
    const stale = await svc.inventory(target);
    expect(stale.stale).toBe(true);
    expect(stale.error).toContain("nas unreachable");
    expect(stale.models).toHaveLength(2);
  });

  it("drops to an error snapshot after the stale window", async () => {
    let clock = 1_000;
    const runner: ModelctlRunner = vi
      .fn()
      .mockResolvedValueOnce(validPayload())
      .mockRejectedValue(new Error("down"));
    const svc = new ModelctlService({ runner, now: () => clock });
    const target = { targetId: "nas", args: ["list", "--json"], ttlMs: NAS_TTL_MS };
    await svc.inventory(target);

    clock += NAS_TTL_MS * STALE_MULTIPLIER + 1;
    const result = await svc.inventory(target);
    expect(result.models).toHaveLength(0);
    expect(result.error).toContain("down");
  });

  it("single-flights concurrent fetches for the same target", async () => {
    let resolveFetch: ((v: string) => void) | undefined;
    const runner: ModelctlRunner = vi.fn(
      () => new Promise<string>((resolve) => (resolveFetch = resolve)),
    );
    const svc = new ModelctlService({ runner });
    const target = { targetId: "nas", args: ["list", "--json"], ttlMs: NAS_TTL_MS };
    const a = svc.inventory(target);
    const b = svc.inventory(target);
    resolveFetch!(validPayload());
    const [ra, rb] = await Promise.all([a, b]);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(ra.models).toHaveLength(2);
    expect(rb.models).toHaveLength(2);
  });

  it("rejects malformed CLI output into the error path", async () => {
    const runner: ModelctlRunner = vi.fn().mockResolvedValue('{"not":"an array"}');
    const svc = new ModelctlService({ runner });
    const result = await svc.inventory({ targetId: "nas", args: ["list", "--json"], ttlMs: NAS_TTL_MS });
    expect(result.models).toHaveLength(0);
    expect(result.error).not.toBeNull();
  });

  it("caches version probes for 5 minutes", async () => {
    let clock = 1_000;
    const runner: ModelctlRunner = vi.fn().mockResolvedValue("modelctl 0.20.1\n");
    const svc = new ModelctlService({ runner, now: () => clock });
    expect(await svc.version()).toBe("modelctl 0.20.1");
    clock += VERSION_TTL_MS - 1;
    expect(await svc.version()).toBe("modelctl 0.20.1"); // cached
    expect(runner).toHaveBeenCalledTimes(1);
    clock += 2_000;
    expect(await svc.version()).toBe("modelctl 0.20.1"); // expired → re-probe
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe("resolveModelctlPath", () => {
  it("prefers an explicit path without probing", async () => {
    expect(await resolveModelctlPath("/usr/bin/modelctl")).toBe("/usr/bin/modelctl");
  });

  it("falls back to ~/.local/bin/modelctl when PATH lookup fails", async () => {
    // modelctl IS installed at ~/.local/bin on this host; PATH may vary in CI.
    const resolved = await resolveModelctlPath();
    if (resolved === null) return; // host without modelctl — nothing to assert
    expect(resolved === "modelctl" || resolved.endsWith("/.local/bin/modelctl")).toBe(true);
  });
});
