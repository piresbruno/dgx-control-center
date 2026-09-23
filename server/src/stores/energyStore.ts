/**
 * Energy accounting (M5): derives kWh + cost from the GPU power leaves
 * (`gpus.N.watts`, watts) already rolled up per minute in metrics_1m.
 * A 1-minute bucket's avg watts is assumed to represent the whole bucket
 * (partial sample coverage is documented tolerance). Cost uses a flat rate
 * (CC_KWH_COST, default 0.30/kWh) — meters differ per deployment.
 */
import type { Database } from "better-sqlite3";

export interface EnergyBucket {
  nodeId: string;
  bucket: number;
  kwh: number;
  cost: number;
  /** Minutes of data underlying the bucket (coverage signal). */
  minutes: number;
}

export interface EnergySummary {
  hourly: EnergyBucket[];
  daily: EnergyBucket[];
  monthly: EnergyBucket[];
  totalKwh: number;
  totalCost: number;
}

export interface EnergyStoreOptions {
  /** Currency units per kWh. */
  kwhCost?: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export class EnergyStore {
  constructor(
    private readonly db: Database,
    private readonly opts: EnergyStoreOptions = {},
  ) {}

  private rows(since: number, nodeId: string | null): Array<{ node_id: string; bucket: number; n: number; avg: string }> {
    if (nodeId) {
      return this.db
        .prepare(`SELECT node_id, bucket, n, avg FROM metrics_1m WHERE domain = 'gpu' AND bucket >= ? AND node_id = ? ORDER BY bucket`)
        .all(since, nodeId) as never;
    }
    return this.db
      .prepare(`SELECT node_id, bucket, n, avg FROM metrics_1m WHERE domain = 'gpu' AND bucket >= ? ORDER BY bucket`)
      .all(since) as never;
  }

  /** kWh for one 1m bucket row: avgW across GPUs × 1 min. */
  private static wattsOf(avgJson: string): number {
    try {
      const parsed = JSON.parse(avgJson) as Record<string, number>;
      let total = 0;
      for (const [leaf, v] of Object.entries(parsed)) {
        if (leaf.endsWith(".watts") && typeof v === "number") total += v;
      }
      return total;
    } catch {
      return 0;
    }
  }

  private aggregate(since: number, nodeId: string | null, bucketMs: number): EnergyBucket[] {
    const acc = new Map<string, { nodeId: string; bucket: number; wattMinutes: number; minutes: number }>();
    for (const row of this.rows(since, nodeId)) {
      const bucket = Math.floor(row.bucket / bucketMs) * bucketMs;
      const key = `${row.node_id}|${bucket}`;
      const entry = acc.get(key) ?? { nodeId: row.node_id, bucket, wattMinutes: 0, minutes: 0 };
      entry.wattMinutes += EnergyStore.wattsOf(row.avg); // avgW × 1 minute
      entry.minutes += 1;
      acc.set(key, entry);
    }
    const rate = this.opts.kwhCost ?? 0;
    return [...acc.values()]
      .map((e) => {
        const kwh = Math.round((e.wattMinutes / 1000 / 60) * 1e6) / 1e6;
        return { nodeId: e.nodeId, bucket: e.bucket, kwh, cost: Math.round(kwh * rate * 1e4) / 1e4, minutes: e.minutes };
      })
      .sort((a, b) => a.bucket - b.bucket);
  }

  summary(since: number, nodeId: string | null = null): EnergySummary {
    const hourly = this.aggregate(since, nodeId, HOUR_MS);
    const daily = this.aggregate(since, nodeId, DAY_MS);
    const monthly = this.aggregate(since, nodeId, 30 * DAY_MS);
    const totalKwh = hourly.reduce((s, h) => s + h.kwh, 0);
    return {
      hourly,
      daily,
      monthly,
      totalKwh: Math.round(totalKwh * 1e4) / 1e4,
      totalCost: Math.round(totalKwh * (this.opts.kwhCost ?? 0) * 1e4) / 1e4,
    };
  }
}
