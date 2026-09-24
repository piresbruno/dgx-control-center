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
  {
    version: 2,
    sql: `
      CREATE TABLE gateway_traces (
        id                TEXT PRIMARY KEY,
        ts                INTEGER NOT NULL,
        client            TEXT,
        alias             TEXT NOT NULL,
        model             TEXT,
        node_id           TEXT,
        port              INTEGER,
        status            INTEGER,
        ttft_ms           INTEGER,
        duration_ms       INTEGER NOT NULL,
        stream            INTEGER NOT NULL DEFAULT 0,
        prompt_tokens     INTEGER,
        completion_tokens INTEGER,
        itl               TEXT,
        attempts          TEXT,
        error             TEXT
      );
      CREATE INDEX idx_traces_ts ON gateway_traces (ts);
      CREATE INDEX idx_traces_alias ON gateway_traces (alias, ts);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE alerts (
        id          TEXT PRIMARY KEY,
        rule_id     TEXT NOT NULL,
        rule_name   TEXT NOT NULL,
        severity    TEXT NOT NULL,
        entity      TEXT NOT NULL,
        detail      TEXT NOT NULL,
        state       TEXT NOT NULL,
        fired_at    INTEGER NOT NULL,
        acked_at    INTEGER,
        acked_by    TEXT,
        resolved_at INTEGER,
        resolved_note TEXT,
        muted_until INTEGER
      );
      CREATE INDEX idx_alerts_state ON alerts (state, fired_at);
      CREATE TABLE alert_events (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts        INTEGER NOT NULL,
        alert_id  TEXT NOT NULL,
        rule_id   TEXT NOT NULL,
        kind      TEXT NOT NULL,
        actor     TEXT,
        note      TEXT
      );
      CREATE INDEX idx_alert_events_ts ON alert_events (ts);
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
