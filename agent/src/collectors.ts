import { execFile as execFileCb } from "node:child_process";
import { readFile as readFileCb, statfs as statfsCb } from "node:fs/promises";
import { promisify } from "node:util";

/**
 * Domain collectors (F1a) — sequenced atomic snapshots are assembled by the
 * daemon from these per-domain samplers. Parsing is pure and fixture-tested;
 * acquisition is injected so tests never touch /proc or nvidia-smi.
 * Collectors never throw: a failed source yields null for that tick.
 */

const execFile = promisify(execFileCb);

type ReadFileFn = (path: string) => Promise<string>;
type StatFsFn = (path: string) => Promise<{ blocks: number; bsize: number; bavail: number }>;
type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

/** fs/promises readFile without an encoding returns Buffer — pin utf8. */
const defaultReadFile: ReadFileFn = (path) => readFileCb(path, "utf8");
const defaultStatFs: StatFsFn = (path) => statfsCb(path);
const defaultExec: ExecFn = (cmd, args) => execFile(cmd, args);

export interface CollectorsDeps {
  readFile?: ReadFileFn;
  exec?: ExecFn;
  statFs?: StatFsFn;
  /** Storage path to report (default /). */
  storagePath?: string;
}

// ── pure parsers ────────────────────────────────────────────────────────

/** /proc/stat `cpu  …` line → busy/idle jiffies. Returns null when absent. */
export function parseCpuStat(text: string): { busy: number; idle: number } | null {
  const line = text.split("\n")[0];
  if (!line?.startsWith("cpu ")) return null;
  const parts = line.split(/\s+/).slice(1).map(Number);
  if (parts.length < 5 || parts.some((n) => Number.isNaN(n))) return null;
  const [user, nice, system, idle, iowait, irq = 0, softirq = 0, steal = 0] = parts;
  const busy = user! + nice! + system! + irq + softirq + steal;
  return { busy, idle: idle! + iowait! };
}

export interface CpuSample {
  loadPct: number;
  coreCount: number;
}

/** /proc/meminfo (kB) → memory sample. */
export function parseMemInfo(text: string): {
  totalGb: number;
  usedGb: number;
  availableGb: number;
  usedPct: number;
} | null {
  const kv = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) kv.set(m[1]!, Number(m[2]));
  }
  const total = kv.get("MemTotal");
  const available = kv.get("MemAvailable");
  if (total === undefined || available === undefined) return null;
  const used = total - available;
  const gb = (kb: number) => Math.round((kb / 1024 / 1024) * 10) / 10;
  return {
    totalGb: gb(total),
    usedGb: gb(used),
    availableGb: gb(available),
    usedPct: Math.round((used / total) * 1000) / 10,
  };
}

export interface GpuSample {
  index: number;
  utilPct: number | null;
  tempC: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  clockMhz: number | null;
  watts: number | null;
}

/**
 * nvidia-smi csv (noheader, nounits). GB10 quirk (verified): memory and some
 * fields report `[N/A]` / `[Not Supported]` — parse to null, never NaN.
 */
export function parseGpuSmi(csv: string): GpuSample[] {
  return csv
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const cells = line.split(",").map((c) => c.trim());
      const num = (i: number): number | null => {
        const v = cells[i];
        if (v === undefined || /^\[?N\/?A\]?$/i.test(v) || /not supported/i.test(v)) return null;
        const n = Number(v);
        return Number.isNaN(n) ? null : n;
      };
      return {
        index,
        utilPct: num(0),
        tempC: num(1),
        memUsedMb: num(2),
        memTotalMb: num(3),
        clockMhz: num(4),
        watts: num(5),
      };
    });
}

export interface NetDevTotals {
  rxBytes: number;
  txBytes: number;
}

/** /proc/net/dev → summed rx/tx bytes, excluding lo. */
export function parseNetDev(text: string): Record<string, NetDevTotals> {
  const out: Record<string, NetDevTotals> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(\w+):\s*(.+)$/.exec(line);
    if (!m || m[1] === "lo") continue;
    const fields = m[2]!.trim().split(/\s+/).map(Number);
    const rx = fields[0];
    const tx = fields[8];
    if (rx === undefined || tx === undefined || Number.isNaN(rx) || Number.isNaN(tx)) continue;
    out[m[1]!] = { rxBytes: rx, txBytes: tx };
  }
  return out;
}

/** statfs → storage sample. */
export function parseStatFs(
  stats: { blocks: number; bsize: number; bavail: number },
): { totalGb: number; freeGb: number; usedPct: number } {
  const totalBytes = stats.blocks * stats.bsize;
  const freeBytes = stats.bavail * stats.bsize;
  const usedBytes = totalBytes - freeBytes;
  const gb = (b: number) => Math.round((b / 1024 ** 3) * 10) / 10;
  return {
    totalGb: gb(totalBytes),
    freeGb: gb(freeBytes),
    usedPct: totalBytes === 0 ? 0 : Math.round((usedBytes / totalBytes) * 1000) / 10,
  };
}

// ── stateful samplers ───────────────────────────────────────────────────

/** CPU sampler: utilization from /proc/stat deltas between ticks. */
export function createCpuSampler(deps: CollectorsDeps): (ts: number) => Promise<Record<string, unknown> | null> {
  const readFile = deps.readFile ?? defaultReadFile;
  let prev: { busy: number; idle: number } | null = null;
  return async (): Promise<Record<string, unknown> | null> => {
    try {
      const text = await readFile("/proc/stat");
      const cur = parseCpuStat(text);
      if (!cur) return null;
      let loadPct = 0;
      if (prev) {
        const dBusy = cur.busy - prev.busy;
        const dIdle = cur.idle - prev.idle;
        const total = dBusy + dIdle;
        loadPct = total > 0 ? Math.round((dBusy / total) * 1000) / 10 : 0;
      }
      prev = cur;
      const statText = await readFile("/proc/cpuinfo");
      const coreCount = (statText.match(/^processor\s*:/gm) ?? []).length || null;
      return { loadPct, coreCount: coreCount ?? 0 };
    } catch {
      return null;
    }
  };
}

/** GPU sampler via nvidia-smi (absent binary ⇒ null sample, no throw). */
export function createGpuSampler(deps: CollectorsDeps): (ts: number) => Promise<Record<string, unknown> | null> {
  const exec = deps.exec ?? defaultExec;
  const args = [
    "--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,clocks.current.graphics,power.draw",
    "--format=csv,noheader,nounits",
  ];
  return async (): Promise<Record<string, unknown> | null> => {
    try {
      const { stdout } = await exec("nvidia-smi", args);
      return { gpus: parseGpuSmi(stdout) };
    } catch {
      return null;
    }
  };
}

/** Network sampler: interface totals + rate deltas between ticks. */
export function createNetSampler(deps: CollectorsDeps): (ts: number) => Promise<Record<string, unknown> | null> {
  const readFile = deps.readFile ?? defaultReadFile;
  let prev: { ts: number; totals: NetDevTotals } | null = null;
  return async (ts: number): Promise<{ rxKbps: number; txKbps: number; totals: NetDevTotals } | null> => {
    try {
      const text = await readFile("/proc/net/dev");
      const perIface = parseNetDev(text);
      const totals = Object.values(perIface).reduce(
        (acc, v) => ({ rxBytes: acc.rxBytes + v.rxBytes, txBytes: acc.txBytes + v.txBytes }),
        { rxBytes: 0, txBytes: 0 },
      );
      let rxKbps = 0;
      let txKbps = 0;
      if (prev && ts > prev.ts) {
        const dtSec = (ts - prev.ts) / 1000;
        rxKbps = Math.max(0, ((totals.rxBytes - prev.totals.rxBytes) * 8) / dtSec / 1000);
        txKbps = Math.max(0, ((totals.txBytes - prev.totals.txBytes) * 8) / dtSec / 1000);
      }
      prev = { ts, totals };
      const round = (n: number) => Math.round(n * 10) / 10;
      return { rxKbps: round(rxKbps), txKbps: round(txKbps), totals };
    } catch {
      return null;
    }
  };
}

/** Storage sampler via statfs on the configured path. */
export function createStorageSampler(deps: CollectorsDeps): (ts: number) => Promise<Record<string, unknown> | null> {
  const statFs = deps.statFs ?? defaultStatFs;
  const path = deps.storagePath ?? "/";
  return async () => {
    try {
      return parseStatFs(await statFs(path));
    } catch {
      return null;
    }
  };
}

/**
 * Assemble the domain map consumed by the daemon: gpu, cpu, memory, network,
 * storage. Each sampler is fault-isolated — a throw becomes null.
 */
export type DomainCollector = (ts: number) => Promise<Record<string, unknown> | null>;

export function buildCollectors(deps: CollectorsDeps = {}): Record<string, DomainCollector> {
  const cpu = createCpuSampler(deps);
  const gpu = createGpuSampler(deps);
  const net = createNetSampler(deps);
  const storage = createStorageSampler(deps);
  const readFile = deps.readFile ?? defaultReadFile;

  const memory = async () => {
    try {
      return parseMemInfo(await readFile("/proc/meminfo"));
    } catch {
      return null;
    }
  };

  const isolated = (fn: (ts: number) => Promise<Record<string, unknown> | null>): DomainCollector => async (ts) => {
    try {
      return await fn(ts);
    } catch {
      return null;
    }
  };

  return {
    cpu: isolated(cpu),
    gpu: isolated(gpu),
    memory: isolated(memory),
    network: isolated(net),
    storage: isolated(storage),
  };
}
