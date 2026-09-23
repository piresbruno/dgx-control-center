import Database from "better-sqlite3";

/**
 * SQLite open + migrations (ADR-0003: file-backed, WAL, version table).
 * Migration 001 creates the telemetry rollup tables (1m raw-retained,
 * 1h/1d long-retained).
 */

export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE metrics_1m (
        node_id TEXT NOT NULL,
        domain  TEXT NOT NULL,
        bucket  INTEGER NOT NULL,
        n       INTEGER NOT NULL,
        avg     TEXT NOT NULL,
        max     TEXT NOT NULL,
        PRIMARY KEY (node_id, domain, bucket)
      );
      CREATE INDEX idx_metrics_1m_bucket ON metrics_1m (domain, bucket);
      CREATE TABLE metrics_1h (
        node_id TEXT NOT NULL,
        domain  TEXT NOT NULL,
        bucket  INTEGER NOT NULL,
        n       INTEGER NOT NULL,
        avg     TEXT NOT NULL,
        max     TEXT NOT NULL,
        PRIMARY KEY (node_id, domain, bucket)
      );
      CREATE INDEX idx_metrics_1h_bucket ON metrics_1h (domain, bucket);
      CREATE TABLE metrics_1d (
        node_id TEXT NOT NULL,
        domain  TEXT NOT NULL,
        bucket  INTEGER NOT NULL,
        n       INTEGER NOT NULL,
        avg     TEXT NOT NULL,
        max     TEXT NOT NULL,
        PRIMARY KEY (node_id, domain, bucket)
      );
      CREATE INDEX idx_metrics_1d_bucket ON metrics_1d (domain, bucket);
    `,
  },
];

export function openDb(file: string, now: number = Date.now()): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (" +
      "version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        now,
      );
    })();
  }
  return db;
}
