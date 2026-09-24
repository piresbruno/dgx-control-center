import { describe, expect, it } from "vitest";
import { JOB_KINDS, jobArgv } from "./commands.js";

describe("job command registry", () => {
  it("resolves simple kinds without params", () => {
    expect(jobArgv("modelctl-version")).toEqual(["modelctl", "--version"]);
    expect(jobArgv("modelctl-list-local")).toEqual(["modelctl", "list", "--local", "--json"]);
    expect(jobArgv("uv-version")).toEqual(["uv", "--version"]);
  });

  it("resolves parameterized kinds", () => {
    expect(jobArgv("modelctl-download", { source: "unsloth/Qwen3.6-35B" })).toEqual([
      "modelctl",
      "download",
      "unsloth/Qwen3.6-35B",
    ]);
    expect(jobArgv("modelctl-sync-local", { model: "DeepSeek-V4-Flash-0731" })).toEqual([
      "modelctl",
      "sync-local",
      "DeepSeek-V4-Flash-0731",
    ]);
    expect(jobArgv("modelctl-push", { model: "m", host: "dgx-2.tail913922.ts.net" })).toEqual([
      "modelctl",
      "push",
      "--host",
      "dgx-2.tail913922.ts.net",
      "m",
    ]);
  });

  it("rejects unknown kinds and hostile params", () => {
    expect(jobArgv("rm -rf /")).toBeNull();
    expect(jobArgv("modelctl-download", { source: "a; shutdown now" })).toBeNull();
    expect(jobArgv("modelctl-push", { model: "m", host: "$(reboot)" })).toBeNull();
    expect(jobArgv("modelctl-download", {})).toBeNull(); // missing source
    expect(jobArgv("modelctl-version", { extra: 1 })).toBeNull(); // strict
  });

  it("exposes the kinds list for UI validation", () => {
    expect(JOB_KINDS).toContain("modelctl-download");
  });
});

describe("capability sweep (M7)", () => {
  it("resolves to a python harness that emits JSON with node capabilities", async () => {
    const { jobArgv } = await import("./commands.js");
    const argv = jobArgv("capability-sweep", {});
    expect(argv?.[0]).toBe("bash");
    expect(argv?.[2]).toContain("ccClock");
    // The harness actually runs on this machine and emits valid JSON.
    const { execFile } = await import("node:child_process");
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile("bash", ["-c", argv![2]!], { timeout: 20_000 }, (err, out) => (err ? reject(err) : resolve(out))),
    );
    const parsed = JSON.parse(stdout) as Record<string, string | null>;
    expect(parsed.node).toBeTruthy();
    expect(parsed.nodejs).toMatch(/^v\d+/);
    expect(parsed.ccClock).toMatch(/installed|missing/);
  });
});
