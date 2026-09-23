/**
 * spark-clock helper port (M5): privileged `cc-clock` helper installed to
 * /usr/local/bin/cc-clock on nodes, run as root via sudo -n. Sudoers is
 * scoped to EXACTLY that binary (no wildcarded nvidia-smi/cpupower).
 *
 * GB10-verified: the CPU cap must write scaling_max_freq; writing max_perf
 * is accepted but re-derives the policy from firmware and reverts
 * scaling_max_freq. The cpu[0-9]* glob cannot match the top-level cpufreq
 * policy dir.
 */
import { shellQuote } from "../util/shellQuote.js";

export const CLOCK_BIN = "/usr/local/bin/cc-clock";

export const CLOCK_HELPER_SCRIPT = `#!/bin/sh
# cc-clock — GPU/CPU clock control for ControlCenter (runs as root via sudo).
set -u
usage() { echo "usage: cc-clock check|gpu-lock MHZ|gpu-reset|cpu-max KHZ|cpu-reset" >&2; exit 64; }
[ $# -ge 1 ] || usage
case "$1" in
  check) exit 0 ;;
  gpu-lock)
    [ $# -eq 2 ] || usage
    case "$2" in ''|*[!0-9]*) echo "cc-clock: MHz must be a positive integer" >&2; exit 64;; esac
    exec nvidia-smi -lgc "$2"
    ;;
  gpu-reset) [ $# -eq 1 ] || usage; exec nvidia-smi -rgc ;;
  cpu-max)
    [ $# -eq 2 ] || usage
    case "$2" in ''|*[!0-9]*) echo "cc-clock: kHz must be a positive integer" >&2; exit 64;; esac
    for d in /sys/devices/system/cpu/cpu[0-9]*/cpufreq; do
      # scaling_max_freq is the knob the cpufreq core enforces. Do NOT also
      # write max_perf here: on GB10 its write is accepted but re-derives the
      # policy from firmware and reverts scaling_max_freq (verified).
      [ -f "$d/scaling_max_freq" ] || continue
      echo "$2" > "$d/scaling_max_freq" || { echo "cc-clock: failed writing $d/scaling_max_freq" >&2; exit 1; }
    done
    ;;
  cpu-reset)
    [ $# -eq 1 ] || usage
    for d in /sys/devices/system/cpu/cpu[0-9]*/cpufreq; do
      [ -f "$d/scaling_max_freq" ] || continue
      cat "$d/cpuinfo_max_freq" > "$d/scaling_max_freq" || { echo "cc-clock: failed resetting $d/scaling_max_freq" >&2; exit 1; }
    done
    ;;
  *) usage ;;
esac
`;

/** Unprivileged status probe: GPU csv / cpu ceilings / hw limits / helper presence. */
export function buildClockStatusCommand(): string {
  return [
    "echo __C_GPU__",
    "nvidia-smi --query-gpu=clocks.applications.graphics,clocks.default_applications.graphics,clocks.max.sm,clocks.current.sm --format=csv,noheader,nounits 2>/dev/null",
    "echo __C_CPU__",
    'for d in /sys/devices/system/cpu/cpu[0-9]*/cpufreq; do cat "$d/scaling_max_freq" 2>/dev/null; done | sort -n | tail -1',
    "echo __C_HWM__",
    'for d in /sys/devices/system/cpu/cpu[0-9]*/cpufreq; do cat "$d/cpuinfo_min_freq" 2>/dev/null; done | sort -n | head -1',
    "echo __C_HWX__",
    'for d in /sys/devices/system/cpu/cpu[0-9]*/cpufreq; do cat "$d/cpuinfo_max_freq" 2>/dev/null; done | sort -n | tail -1',
    "echo __C_HELPER__",
    `test -x ${CLOCK_BIN} && echo yes || echo no`,
    "echo __C_END__",
  ].join("\n");
}

function toInt(text: string): number | null {
  const t = text.trim();
  if (!t || !/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface ClockStatus {
  gpuLockedMhz: number | null;
  gpuDefaultMhz: number | null;
  gpuMaxSmMhz: number | null;
  gpuCurrentMhz: number | null;
  /** Effective CPU ceiling (kHz), from scaling_max_freq. */
  cpuMaxKhz: number | null;
  cpuMinKhz: number | null;
  cpuHwMaxKhz: number | null;
  helperPresent: boolean;
}

/** Parse the status probe output (pure). */
export function parseClockStatus(out: string): ClockStatus {
  const sections: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const line of String(out ?? "").split("\n")) {
    const m = line.trim().match(/^__C_([A-Z]+)__$/);
    if (m) {
      cur = m[1]!.toLowerCase();
      sections[cur] = [];
      continue;
    }
    if (cur) sections[cur]!.push(line);
  }
  const gpuFields = (sections.gpu?.[0] ?? "").split(",").map((s) => s.trim());
  return {
    gpuLockedMhz: toInt(gpuFields[0] ?? ""),
    gpuDefaultMhz: toInt(gpuFields[1] ?? ""),
    gpuMaxSmMhz: toInt(gpuFields[2] ?? ""),
    gpuCurrentMhz: toInt(gpuFields[3] ?? ""),
    cpuMaxKhz: toInt((sections.cpu ?? []).join("\n")),
    cpuMinKhz: toInt((sections.hwm ?? []).join("\n")),
    cpuHwMaxKhz: toInt((sections.hwx ?? []).join("\n")),
    helperPresent: (sections.helper?.[0] ?? "").trim() === "yes",
  };
}

/** Apply verbs through the helper (checked up front, per sparkControl). */
export function buildApplyScript(ops: Array<{ kind: "gpu-lock" | "gpu-reset" | "cpu-max" | "cpu-reset"; mhz?: number; khz?: number }>): string {
  if (ops.length === 0) throw new Error("clock apply needs at least one op");
  const lines = ops.map((op) => {
    switch (op.kind) {
      case "gpu-lock":
        return `sudo -n ${CLOCK_BIN} gpu-lock ${op.mhz}`;
      case "gpu-reset":
        return `sudo -n ${CLOCK_BIN} gpu-reset`;
      case "cpu-max":
        return `sudo -n ${CLOCK_BIN} cpu-max ${op.khz}`;
      case "cpu-reset":
        return `sudo -n ${CLOCK_BIN} cpu-reset`;
    }
  });
  return [
    `test -x ${CLOCK_BIN} || { echo "cc-clock helper missing — run Install clock control first" >&2; exit 127; }`,
    // Probe the helper itself, not `sudo -n true`: nodes may grant NOPASSWD
    // for cc-clock only (exactly what the installer sets up).
    `sudo -n ${CLOCK_BIN} check 2>/dev/null || { echo "passwordless sudo for ${CLOCK_BIN} required — run Install clock control first" >&2; exit 126; }`,
    ...lines,
  ].join("\n");
}

/** Server-side convenience: resolved profile → helper ops. */
export function profileToOps(resolved: { gpuMaxMhz: number | null; cpuMaxMhz: number | null }): Array<{ kind: "gpu-lock" | "cpu-max"; mhz?: number; khz?: number }> {
  const ops: Array<{ kind: "gpu-lock" | "cpu-max"; mhz?: number; khz?: number }> = [];
  if (resolved.gpuMaxMhz != null) ops.push({ kind: "gpu-lock", mhz: resolved.gpuMaxMhz });
  if (resolved.cpuMaxMhz != null) ops.push({ kind: "cpu-max", khz: (resolved.cpuMaxMhz) * 1000 });
  return ops;
}

/**
 * One-off installer (idempotent; sudoers validated via visudo -cf before
 * install). Passwordless path only — agent jobs have no stdin, so when
 * sudo -n fails the output carries exact manual instructions.
 * Ends with a __CLOCK_INSTALL__:ok | fail:<reason> marker.
 */
export function buildInstallClockScript(user: string): string {
  if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(user)) throw new Error(`invalid user: ${JSON.stringify(user)}`);
  const helperB64 = Buffer.from(CLOCK_HELPER_SCRIPT, "utf8").toString("base64");
  const sudoers = `${user} ALL=(root) NOPASSWD: ${CLOCK_BIN}\n`;
  const sudoersB64 = Buffer.from(sudoers, "utf8").toString("base64");
  const manual = [
    `echo "  1) write the cc-clock helper to ${CLOCK_BIN} (mode 0755)"`,
    `echo "  2) echo '${sudoers.trim()}' | sudo tee /etc/sudoers.d/cc-clock && sudo chmod 0440 /etc/sudoers.d/cc-clock"`,
  ];
  return [
    "set -u",
    "if ! sudo -n true 2>/dev/null; then",
    'echo "__CLOCK_INSTALL__:fail:no passwordless sudo — install manually:"',
    ...manual,
    "exit 126",
    "fi",
    `printf '%s' ${shellQuote(helperB64)} | base64 -d > /tmp/cc-clock.$$.tmp`,
    `sudo -n install -m 0755 /tmp/cc-clock.$$.tmp ${CLOCK_BIN} || { echo "__CLOCK_INSTALL__:fail:helper install"; exit 1; }`,
    "rm -f /tmp/cc-clock.$$.tmp",
    `printf '%s' ${shellQuote(sudoersB64)} | base64 -d > /tmp/cc-clock-sudoers.$$`,
    `sudo -n visudo -cf /tmp/cc-clock-sudoers.$$ >/dev/null || { echo "__CLOCK_INSTALL__:fail:sudoers validation"; rm -f /tmp/cc-clock-sudoers.$$; exit 1; }`,
    `sudo -n install -m 0440 /tmp/cc-clock-sudoers.$$ /etc/sudoers.d/cc-clock || { echo "__CLOCK_INSTALL__:fail:sudoers install"; rm -f /tmp/cc-clock-sudoers.$$; exit 1; }`,
    "rm -f /tmp/cc-clock-sudoers.$$",
    `sudo -n ${CLOCK_BIN} check || { echo "__CLOCK_INSTALL__:fail:smoke test"; exit 1; }`,
    'echo "__CLOCK_INSTALL__:ok"',
  ].join("\n");
}

export function parseInstallMarker(out: string): { ok: boolean; reason: string | null; output: string } {
  const text = String(out ?? "");
  const idx = text.lastIndexOf("__CLOCK_INSTALL__:");
  if (idx < 0) return { ok: false, reason: text.trim() ? "no install marker in output" : "no output", output: text };
  const value = text.slice(idx + "__CLOCK_INSTALL__:".length).trim();
  const ok = value === "ok";
  return { ok, reason: ok ? null : value.replace(/^fail:/, ""), output: text };
}
