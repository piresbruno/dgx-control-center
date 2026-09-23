import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

/**
 * systemd sd_notify integration (F1a agent hardening): READY=1 on start and
 * WATCHDOG=1 on an interval. Shells out to `systemd-notify` (NOTIFY_SOCKET is
 * read from the inherited env by the binary). All no-ops when NOTIFY_SOCKET
 * is absent (non-systemd runs, tests).
 */

const execFile = promisify(execFileCb);

export interface SdNotifyDeps {
  exec?: (cmd: string, args: string[]) => Promise<unknown>;
}

/** Send READY=1 once when NOTIFY_SOCKET is set. Returns whether it fired. */
export async function notifyReady(
  env: NodeJS.ProcessEnv = process.env,
  deps: SdNotifyDeps = {},
): Promise<boolean> {
  if (!env["NOTIFY_SOCKET"]) return false;
  const exec = deps.exec ?? execFile;
  await exec("systemd-notify", ["READY=1"]);
  return true;
}

/** Half of WatchdogSec, floored to 1 s (systemd kills at the full value). */
export function watchdogIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const spec = env["WATCHDOG_SEC"];
  if (!spec) return 0;
  const seconds = Number(spec);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(1_000, Math.floor((seconds * 1_000) / 2));
}

/**
 * Watchdog pinger: notifies WATCHDOG=1 every half the WatchdogSec interval.
 * Returns a stop function; resolves immediately without systemd.
 */
export function startWatchdog(
  env: NodeJS.ProcessEnv = process.env,
  intervalMs: number = watchdogIntervalMs(env),
  schedule: (fn: () => void, ms: number) => NodeJS.Timeout = (fn, ms) => setInterval(fn, ms),
  deps: SdNotifyDeps = {},
): ((...args: unknown[]) => void) | null {
  if (!env["NOTIFY_SOCKET"] || intervalMs <= 0) return null;
  const exec = deps.exec ?? execFile;
  const timer = schedule(() => {
    void exec("systemd-notify", ["WATCHDOG=1"]).catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
