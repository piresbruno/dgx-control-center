import type { Database } from "better-sqlite3";
import type { MetricsMsg } from "@cc/shared";

/**
 * Metrics rollup store (F5): atomic snapshots are flattened to numeric leaves
 * and merged into 1-minute buckets (n/avg/max per leaf); every flush also
 * merges into the 1h and 1d buckets so long retention needs no cascade.
 * Retention: 1m ≈ 7 d (raw), 1h/1d ≈ 90 d. Deterministic via injected `now`.
 */

export interface RollupData {
  n: number;
  avg: Record<string, number>;
  max: Record<string, number>;
}

export interface MetricsStoreOptions {
  /** Buckets are computed from message ts; prune uses this clock. */
  now?: () => number;
  retentionDays?: Partial<Record<Granularity, number>>;
}

const GRANULARITIES = {
  "1m": { table: "metrics_1m", ms: 60_000, days: 7 },
  "1h": { table: "metrics_1h", ms: 3_600_000, days: 90 },
  "1d": { table: "metrics_1d", ms: 86_400_000, days: 365 },
} as const;

type Granularity = keyof typeof GRANULARITIES;

export function flattenNumbers(value: unknown, prefix = "", out: Record<string, number> = {}): Record<string, number> {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && Number.isFinite(value)) out[prefix] = value;
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    flattenNumbers(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

function bucketOf(ts: number, granularity: Granularity): number {
  return Math.floor(ts / GRANULARITIES[granularity].ms) * GRANULARITIES[granularity].ms;
}

interface Acc {
  n: number;
  sum: Record<string, number>;
  max: Record<string, number>;
}

export class MetricsStore {
  /** Buffer key: `${nodeId}|${domain}|${minuteBucket}` — node-scoped. */
  private buffer = new Map<string, Acc>();

  constructor(
    private readonly db: Database,
    private readonly opts: MetricsStoreOptions = {},
  ) {}

  /** Ingest one atomic snapshot into the 1m buffer (no I/O). */
  ingest(sparkId: string, msg: Pick<MetricsMsg, "ts" | "domains">): void {
    for (const [domain, data] of Object.entries(msg.domains)) {
      const leaves = flattenNumbers(data);
      if (Object.keys(leaves).length === 0) continue;
      const key = `${sparkId}|${domain}|${bucketOf(msg.ts, "1m")}`;
      const acc = this.buffer.get(key) ?? { n: 0, sum: {}, max: {} };
      acc.n += 1;
      for (const [leaf, v] of Object.entries(leaves)) {
        acc.sum[leaf] = (acc.sum[leaf] ?? 0) + v;
        acc.max[leaf] = Math.max(acc.max[leaf] ?? v, v);
      }
      this.buffer.set(key, acc);
    }
  }

  /** Persist buffered 1m buckets; each is also merged into 1h + 1d. */
  flush(): void {
    const write = this.db.transaction(() => {
      for (const [key, acc] of this.buffer) {
        const [nodeId, domain, bucketStr] = key.split("|");
        const bucket = Number(bucketStr);
        const avg: Record<string, number> = {};
        for (const [leaf, sum] of Object.entries(acc.sum)) avg[leaf] = sum / acc.n;
        const data: RollupData = { n: acc.n, avg, max: acc.max };
        this.merge("1m", nodeId!, domain!, bucket, data);
        this.merge("1h", nodeId!, domain!, bucketOf(bucket, "1h"), data);
        this.merge("1d", nodeId!, domain!, bucketOf(bucket, "1d"), data);
      }
    });
    write();
    this.buffer.clear();
  }

  query(
    domain: string,
    opts: { node?: string; from: number; to: number; granularity: Granularity },
  ): Array<{ nodeId: string; bucket: number; data: RollupData }> {
    const table = GRANULARITIES[opts.granularity].table;
    const nodeFilter = opts.node ? "AND node_id = ?" : "";
    const params = opts.node ? [domain, opts.from, opts.to, opts.node] : [domain, opts.from, opts.to];
    const rows = this.db
      .prepare(
        `SELECT node_id, bucket, n, avg, max FROM ${table} WHERE domain = ? AND bucket >= ? AND bucket <= ? ${nodeFilter} ORDER BY bucket`,
      )
      .all(...params) as Array<{ node_id: string; bucket: number; n: number; avg: string; max: string }>;
    return rows.map((r) => ({
      nodeId: r.node_id,
      bucket: r.bucket,
      data: { n: r.n, avg: JSON.parse(r.avg), max: JSON.parse(r.max) },
    }));
  }

  /** Delete buckets older than retention. Returns deleted row counts. */
  prune(now: number = (this.opts.now ?? Date.now)()): Record<Granularity, number> {
    const out = { "1m": 0, "1h": 0, "1d": 0 } as Record<Granularity, number>;
    for (const g of Object.keys(GRANULARITIES) as Granularity[]) {
      const days = this.opts.retentionDays?.[g] ?? GRANULARITIES[g].days;
      const cutoff = now - days * 86_400_000;
      out[g] = this.db.prepare(`DELETE FROM ${GRANULARITIES[g].table} WHERE bucket < ?`).run(cutoff).changes;
    }
    return out;
  }

  private merge(granularity: Granularity, nodeId: string, domain: string, bucket: number, data: RollupData): void {
    const table = GRANULARITIES[granularity].table;
    const existing = this.db
      .prepare(`SELECT n, avg, max FROM ${table} WHERE node_id = ? AND domain = ? AND bucket = ?`)
      .get(nodeId, domain, bucket) as { n: number; avg: string; max: string } | undefined;
    if (!existing) {
      this.db
        .prepare(`INSERT INTO ${table} (node_id, domain, bucket, n, avg, max) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(nodeId, domain, bucket, data.n, JSON.stringify(data.avg), JSON.stringify(data.max));
      return;
    }
    const old: RollupData = { n: existing.n, avg: JSON.parse(existing.avg), max: JSON.parse(existing.max) };
    const merged: RollupData = { n: old.n + data.n, avg: {}, max: { ...old.max } };
    for (const [leaf, v] of Object.entries(data.avg)) {
      const oldAvg = old.avg[leaf];
      const value = oldAvg === undefined ? v : (oldAvg * old.n + v * data.n) / merged.n;
      merged.avg[leaf] = Math.round(value * 1000) / 1000;
    }
    for (const [leaf, v] of Object.entries(old.avg)) {
      if (merged.avg[leaf] === undefined) merged.avg[leaf] = v;
    }
    for (const [leaf, v] of Object.entries(data.max)) {
      merged.max[leaf] = Math.max(merged.max[leaf] ?? v, v);
    }
    this.db
      .prepare(`UPDATE ${table} SET n = ?, avg = ?, max = ? WHERE node_id = ? AND domain = ? AND bucket = ?`)
      .run(merged.n, JSON.stringify(merged.avg), JSON.stringify(merged.max), nodeId, domain, bucket);
  }
}
