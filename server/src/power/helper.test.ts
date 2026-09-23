import { describe, expect, it } from "vitest";
import {
  CLOCK_HELPER_SCRIPT,
  buildApplyScript,
  buildClockStatusCommand,
  buildInstallClockScript,
  parseClockStatus,
  parseInstallMarker,
  profileToOps,
} from "./helper.js";

describe("cc-clock helper", () => {
  it("guards numeric args and uses scaling_max_freq, not max_perf", () => {
    expect(CLOCK_HELPER_SCRIPT).toContain("scaling_max_freq");
    expect(CLOCK_HELPER_SCRIPT).not.toContain("max_perf\"");
    expect(CLOCK_HELPER_SCRIPT).toContain("cpu[0-9]*");
  });
});

describe("status probe", () => {
  it("builds a marker-delimited read-only probe", () => {
    const cmd = buildClockStatusCommand();
    expect(cmd).toContain("__C_GPU__");
    expect(cmd).toContain("nvidia-smi --query-gpu=clocks.applications.graphics");
    expect(cmd).toContain("cpuinfo_max_freq");
  });

  it("parses probe output", () => {
    const out = [
      "__C_GPU__",
      "2200, 2670, 2670, 1500",
      "__C_CPU__",
      "2000000",
      "__C_HWM__",
      "338000",
      "__C_HWX__",
      "2810000",
      "__C_HELPER__",
      "yes",
      "__C_END__",
    ].join("\n");
    const s = parseClockStatus(out);
    expect(s).toEqual({
      gpuLockedMhz: 2200,
      gpuDefaultMhz: 2670,
      gpuMaxSmMhz: 2670,
      gpuCurrentMhz: 1500,
      cpuMaxKhz: 2000000,
      cpuMinKhz: 338000,
      cpuHwMaxKhz: 2810000,
      helperPresent: true,
    });
  });

  it("tolerates missing sections", () => {
    const s = parseClockStatus("__C_END__");
    expect(s.gpuLockedMhz).toBeNull();
    expect(s.helperPresent).toBe(false);
  });
});

describe("apply script", () => {
  it("probes the helper before ops and formats khz for cpu-max", () => {
    const script = buildApplyScript([
      { kind: "gpu-lock", mhz: 2200 },
      { kind: "cpu-max", khz: 2000000 },
    ]);
    expect(script).toContain("sudo -n /usr/local/bin/cc-clock check");
    expect(script).toContain("gpu-lock 2200");
    expect(script).toContain("cpu-max 2000000");
  });

  it("maps a resolved profile to helper ops", () => {
    expect(profileToOps({ gpuMaxMhz: 2200, cpuMaxMhz: 2000 })).toEqual([
      { kind: "gpu-lock", mhz: 2200 },
      { kind: "cpu-max", khz: 2000000 },
    ]);
    expect(profileToOps({ gpuMaxMhz: null, cpuMaxMhz: null })).toEqual([]);
  });
});

describe("installer", () => {
  it("validates the user and embeds an exact sudoers line", () => {
    const script = buildInstallClockScript("piresbruno");
    expect(script).toContain("piresbruno ALL=(root) NOPASSWD: /usr/local/bin/cc-clock");
    expect(script).toContain("visudo -cf");
    expect(script).toContain("__CLOCK_INSTALL__:ok");
  });

  it("rejects bad users and falls back to manual instructions without passwordless sudo", () => {
    expect(() => buildInstallClockScript("bad user; rm -rf")).toThrow(/invalid user/);
    const script = buildInstallClockScript("piresbruno");
    expect(script).toContain("__CLOCK_INSTALL__:fail:no passwordless sudo");
    expect(script).toContain("sudo tee /etc/sudoers.d/cc-clock");
  });

  it("parses the install marker", () => {
    expect(parseInstallMarker("noise\n__CLOCK_INSTALL__:ok")).toEqual({ ok: true, reason: null, output: expect.any(String) });
    const fail = parseInstallMarker("__CLOCK_INSTALL__:fail:sudoers validation");
    expect(fail.ok).toBe(false);
    expect(fail.reason).toBe("sudoers validation");
    expect(parseInstallMarker("").reason).toContain("no output");
  });
});
