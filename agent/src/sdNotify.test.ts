import { describe, expect, it, vi } from "vitest";
import { notifyReady, startWatchdog, watchdogIntervalMs } from "./sdNotify.js";

describe("sd_notify", () => {
  it("is a no-op without NOTIFY_SOCKET", async () => {
    expect(await notifyReady({})).toBe(false);
    expect(startWatchdog({})).toBeNull();
  });

  it("sends READY=1 via systemd-notify with the inherited env", async () => {
    const env = { NOTIFY_SOCKET: "/run/systemd/notify" };
    const calls: Array<[string, string[]]> = [];
    const sent = await notifyReady(env, { exec: async (cmd, args) => void calls.push([cmd, args]) });
    expect(sent).toBe(true);
    expect(calls).toEqual([["systemd-notify", ["READY=1"]]]);
  });

  it("watchdog pings on the injected scheduler until stopped", () => {
    const env = { NOTIFY_SOCKET: "/run/systemd/notify" };
    const calls: Array<[string, string[]]> = [];
    const scheduled: Array<() => void> = [];
    const stop = startWatchdog(
      env,
      10,
      (fn) => {
        scheduled.push(fn);
        return 1 as unknown as NodeJS.Timeout;
      },
      { exec: async (cmd, args) => void calls.push([cmd, args]) },
    );
    expect(stop).not.toBeNull();
    scheduled[0]?.();
    scheduled[0]?.();
    expect(calls).toEqual([
      ["systemd-notify", ["WATCHDOG=1"]],
      ["systemd-notify", ["WATCHDOG=1"]],
    ]);
    stop?.();
  });

  it("computes half of WatchdogSec, floored to 1 s; zero without systemd", () => {
    expect(watchdogIntervalMs({ WATCHDOG_SEC: "60" })).toBe(30_000);
    expect(watchdogIntervalMs({ WATCHDOG_SEC: "1" })).toBe(1_000);
    expect(watchdogIntervalMs({})).toBe(0);
  });
});
