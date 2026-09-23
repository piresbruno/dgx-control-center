import { describe, expect, it } from "vitest";
import {
  MARKER_PREFIX,
  buildModelctlCheckScript,
  buildProvisionScript,
  checkModelctl,
  provisionModelctl,
} from "./provisionModelctl.js";

const marker = (payload: object): string => `${MARKER_PREFIX}${JSON.stringify(payload)}`;

describe("provision script builders", () => {
  it("check script emits a marker and installs nothing", () => {
    const script = buildModelctlCheckScript();
    expect(script).toContain("command -v modelctl");
    expect(script).not.toContain("uv tool install");
    expect(script).toContain(MARKER_PREFIX);
  });

  it("provision script installs uv when missing then modelctl from the repo", () => {
    const script = buildProvisionScript("https://example.com/modelctl");
    expect(script).toContain("astral.sh/uv/install.sh");
    expect(script).toContain("uv tool install --force");
    expect(script).toContain('"https://example.com/modelctl"');
    expect(script).toContain("command -v modelctl");
  });
});

describe("provisionModelctl orchestration", () => {
  it("reports present without installing when modelctl exists", async () => {
    const seen: string[] = [];
    const outcome = await provisionModelctl({ host: "h", user: "u" }, {
      transport: async (script) => {
        seen.push(script);
        return { exitCode: 0, stdout: marker({ ok: true, mode: "present", version: "modelctl 0.20.1", reason: null }), stderr: "" };
      },
    });
    expect(outcome).toMatchObject({ ok: true, mode: "present", version: "modelctl 0.20.1" });
    expect(seen).toHaveLength(1);
  });

  it("surfaces install failures with the reason", async () => {
    const outcome = await provisionModelctl({ host: "h", user: "u" }, {
      transport: async () => ({
        exitCode: 0,
        stdout: marker({ ok: false, mode: "failed", version: null, reason: "uv tool install failed (see /tmp/cc-modelctl-install.log)" }),
        stderr: "",
      }),
    });
    expect(outcome).toMatchObject({ ok: false, mode: "failed" });
    expect(outcome.reason).toContain("uv tool install failed");
  });

  it("reports a diagnostic when no marker arrives", async () => {
    const outcome = await provisionModelctl({ host: "h", user: "u" }, {
      transport: async () => ({ exitCode: 255, stdout: "", stderr: "ssh: connect refused" }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("ssh exited 255");
  });

  it("checkModelctl reports missing without provisioning", async () => {
    const outcome = await checkModelctl({ host: "h", user: "u" }, {
      transport: async (script) => {
        expect(script).toBe(buildModelctlCheckScript());
        return { exitCode: 0, stdout: marker({ ok: false, mode: "missing", version: null, reason: "modelctl not found" }), stderr: "" };
      },
    });
    expect(outcome).toMatchObject({ ok: false, mode: "missing" });
  });
});
