import { describe, expect, it } from "vitest";
import { VERSION } from "@cc/shared";
import { parseAgentConfig } from "./config.js";
import { watchdogIntervalMs } from "./sdNotify.js";

describe("loadAgentConfig", () => {
  it("parses the install-job config", () => {
    const config = parseAgentConfig({
      dashboardUrl: "http://cc.home.local:5566",
      sparkId: "dgx1",
      token: "a".repeat(64),
    });
    expect(config).toEqual({ dashboardUrl: "http://cc.home.local:5566", sparkId: "dgx1", token: "a".repeat(64) });
  });

  it("lets args override file values and rejects incomplete configs", () => {
    const file = { dashboardUrl: "http://cc:5566", sparkId: "dgx1", token: "a".repeat(64) };
    expect(parseAgentConfig(file, { sparkId: "dgx2" }).sparkId).toBe("dgx2");
    expect(() => parseAgentConfig({ dashboardUrl: "http://cc:5566" })).toThrow();
  });

  it("keeps the agent version in sync with shared", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("watchdog interval", () => {
  it("is half of WatchdogSec, floored to 1 s; zero without systemd", () => {
    expect(watchdogIntervalMs({ WATCHDOG_SEC: "60" })).toBe(30_000);
    expect(watchdogIntervalMs({ WATCHDOG_SEC: "1" })).toBe(1_000);
    expect(watchdogIntervalMs({})).toBe(0);
  });
});
