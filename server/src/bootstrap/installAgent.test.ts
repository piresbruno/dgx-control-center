import { describe, expect, it } from "vitest";
import {
  buildInstallScript,
  buildSystemdUnit,
  MARKER_PREFIX,
  parseInstallMarker,
  runInstallAgent,
  type InstallInput,
} from "./installAgent.js";

const INPUT: InstallInput = {
  sparkId: "dgx1",
  dashboardUrl: "http://cc.home.local:5566",
  token: "a".repeat(64),
  agentBundle: "console.log('agent');",
  sshUser: "piresbruno",
};

describe("buildSystemdUnit", () => {
  it("pins user, node path, agent path and Restart=always", () => {
    const unit = buildSystemdUnit({ sshUser: "piresbruno", nodeBin: "/usr/bin/node", agentPath: "/home/u/agent.mjs" });
    expect(unit).toContain("User=piresbruno");
    expect(unit).toContain("ExecStart=/usr/bin/node /home/u/agent.mjs run");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=multi-user.target");
  });
});

describe("buildInstallScript", () => {
  it("embeds the bundle as base64, config.json and both unit modes", () => {
    const script = buildInstallScript(INPUT);
    const b64 = Buffer.from(INPUT.agentBundle, "utf8").toString("base64");
    expect(script).toContain(`printf '%s' '${b64}' | base64 -d`);
    expect(script).toContain("\"sparkId\":\"dgx1\"");
    expect(script).toContain('"dashboardUrl":"http://cc.home.local:5566"');
    expect(script).toContain("sudo -n true");
    expect(script).toContain("systemctl --user enable --now");
    expect(script).toContain("loginctl enable-linger");
    expect(script).toContain("-lt 22");
    expect(script).toContain(MARKER_PREFIX);
  });

  it("script is deterministic for the same input", () => {
    expect(buildInstallScript(INPUT)).toBe(buildInstallScript(INPUT));
  });
});

describe("parseInstallMarker", () => {
  it("parses the trailing marker", () => {
    const out = `some noise\n${MARKER_PREFIX}{"ok":true,"mode":"system","reason":null}`;
    expect(parseInstallMarker(out)).toEqual({ ok: true, mode: "system", reason: null });
  });

  it("returns null without a marker and tolerates trailing output", () => {
    expect(parseInstallMarker("nothing here")).toBeNull();
    const out = `${MARKER_PREFIX}{"ok":false,"mode":"user","reason":"linger"}\ntrailing`;
    expect(parseInstallMarker(out)).toEqual({ ok: false, mode: "user", reason: "linger" });
  });
});

describe("runInstallAgent", () => {
  it("happy path: script runs, marker ok, hello seen", async () => {
    let received = "";
    const hub = { registry: { connected: false } };
    const outcome = await runInstallAgent(
      { host: "10.0.30.11", user: "piresbruno" },
      INPUT,
      {
        transport: {
          run: async (script) => {
            received = script;
            return {
              exitCode: 0,
              stdout: `${MARKER_PREFIX}{"ok":true,"mode":"system","reason":null}`,
              stderr: "",
            };
          },
        },
        waitHello: async (sparkId, timeoutMs) => {
          expect(sparkId).toBe("dgx1");
          expect(timeoutMs).toBeGreaterThan(0);
          void hub;
          return true;
        },
      },
    );
    expect(received).toContain(MARKER_PREFIX);
    expect(outcome).toEqual({ ok: true, mode: "system", reason: null, helloSeen: true });
  });

  it("failure path: node too old reports reason, hello never waited", async () => {
    let helloWaited = false;
    const outcome = await runInstallAgent(
      { host: "10.0.30.11", user: "piresbruno" },
      INPUT,
      {
        transport: {
          run: async () => ({
            exitCode: 1,
            stdout: `${MARKER_PREFIX}{"ok":false,"mode":"system","reason":"node too old: 18, >=22 required"}`,
            stderr: "",
          }),
        },
        waitHello: async () => {
          helloWaited = true;
          return true;
        },
      },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("node too old");
    expect(helloWaited).toBe(false);
  });

  it("no marker (e.g. ssh failure) surfaces stderr", async () => {
    const outcome = await runInstallAgent(
      { host: "10.0.30.11", user: "piresbruno" },
      INPUT,
      {
        transport: { run: async () => ({ exitCode: 255, stdout: "", stderr: "Permission denied (publickey)" }) },
        waitHello: async () => true,
      },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("Permission denied");
  });
});
