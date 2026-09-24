/**
 * Maintenance (M7): one entry point that enforces every retention policy and
 * checkpoints the WAL. Runs hourly from index.ts (and on demand via REST):
 *   - metrics 1m/1h/1d pruning (per-granularity windows)
 *   - gateway traces past tracesDays
 *   - backups beyond backupsKeep
 *   - `wal_checkpoint(TRUNCATE)` so the on-disk db stays compact
 */
import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import type { MetricsStore } from "../stores/metricsStore.js";
import type { TracesStore } from "../stores/tracesStore.js";
import type { SystemSettings } from "./settings.js";

export interface MaintenanceDeps {
  db: Database;
  metrics: MetricsStore;
  traces: TracesStore;
  configDir: string;
  settings: () => SystemSettings;
  now?: () => number;
}

export interface MaintenanceReport {
  ts: number;
  metricsPruned: Record<string, number>;
  tracesPruned: number;
  backupsDeleted: string[];
  checkpoint: "done";
}

export function runMaintenance(deps: MaintenanceDeps): MaintenanceReport {
  const now = deps.now?.() ?? Date.now();
  const settings = deps.settings();
  const metricsPruned = deps.metrics.prune(now);
  const tracesCutoff = now - settings.retention.tracesDays * 86_400_000;
  const tracesPruned = deps.db
    .prepare(`DELETE FROM gateway_traces WHERE ts < ?`)
    .run(tracesCutoff).changes;

  // Backups: keep the newest N.
  const backupsRoot = path.join(deps.configDir, "backups");
  const backupsDeleted: string[] = [];
  if (fs.existsSync(backupsRoot)) {
    const ids = fs
      .readdirSync(backupsRoot)
      .sort()
      .reverse();
    for (const id of ids.slice(settings.retention.backupsKeep)) {
      fs.rmSync(path.join(backupsRoot, id), { recursive: true, force: true });
      backupsDeleted.push(id);
    }
  }

  deps.db.pragma("wal_checkpoint(TRUNCATE)");
  return { ts: now, metricsPruned, tracesPruned, backupsDeleted, checkpoint: "done" };
}
