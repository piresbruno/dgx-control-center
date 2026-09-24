import type { Database } from "better-sqlite3";

/**
 * Alerts store (M6/F5a): alert rows + transition history in SQLite.
 * Lifecycle: firing → acknowledged (who/when) → resolved (auto/manual with
 * note); muted = suppressed until a timestamp (no re-fire while muted).
 */
import { randomUUID } from "node:crypto";

export type AlertState = "firing" | "acknowledged" | "resolved";
export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertRow {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  /** Entity the alert is about: sparkId, "_fleet", deployment id… */
  entity: string;
  detail: string;
  state: AlertState;
  firedAt: number;
  ackedAt: number | null;
  ackedBy: string | null;
  resolvedAt: number | null;
  resolvedNote: string | null;
  mutedUntil: number | null;
}

export interface AlertEventRow {
  id: number;
  ts: number;
  alertId: string;
  ruleId: string;
  kind: "fired" | "acknowledged" | "resolved" | "muted" | "unmuted" | "re-fired";
  actor: string | null;
  note: string | null;
}

export interface AlertsStoreDeps {
  db: Database;
  now?: () => number;
  maxEvents?: number;
}

export class AlertsStore {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly maxEvents: number;

  constructor(deps: AlertsStoreDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.maxEvents = deps.maxEvents ?? 10_000;
  }

  /** Open (firing or acknowledged but unresolved) alert for a rule+entity. */
  openByRuleEntity(ruleId: string, entity: string): AlertRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM alerts WHERE rule_id = ? AND entity = ? AND state IN ('firing','acknowledged') ORDER BY fired_at DESC LIMIT 1`,
      )
      .get(ruleId, entity) as Record<string, unknown> | undefined;
    return row ? rowToAlert(row) : null;
  }

  insert(rec: Omit<AlertRow, "id" | "ackedAt" | "ackedBy" | "resolvedAt" | "resolvedNote" | "mutedUntil">): AlertRow {
    const full: AlertRow = { ...rec, id: randomUUID(), ackedAt: null, ackedBy: null, resolvedAt: null, resolvedNote: null, mutedUntil: null };
    this.db
      .prepare(
        `INSERT INTO alerts (id, rule_id, rule_name, severity, entity, detail, state, fired_at)
         VALUES (@id, @ruleId, @ruleName, @severity, @entity, @detail, @state, @firedAt)`,
      )
      .run({
        id: full.id,
        ruleId: full.ruleId,
        ruleName: full.ruleName,
        severity: full.severity,
        entity: full.entity,
        detail: full.detail,
        state: full.state,
        firedAt: full.firedAt,
      });
    this.event(full.id, "fired", null, full.detail);
    return full;
  }

  acknowledge(id: string, by: string): boolean {
    const now = this.now();
    const res = this.db
      .prepare(`UPDATE alerts SET state = 'acknowledged', acked_at = ?, acked_by = ? WHERE id = ? AND state = 'firing'`)
      .run(now, by, id);
    if (res.changes === 0) return false;
    this.event(id, "acknowledged", by, null);
    return true;
  }

  resolve(id: string, note: string | null, auto = false): boolean {
    const now = this.now();
    const res = this.db
      .prepare(`UPDATE alerts SET state = 'resolved', resolved_at = ?, resolved_note = ? WHERE id = ? AND state IN ('firing','acknowledged')`)
      .run(now, note, id);
    if (res.changes === 0) return false;
    this.event(id, "resolved", auto ? "auto" : "manual", note);
    return true;
  }

  mute(id: string, untilMs: number, by: string | null): boolean {
    const res = this.db.prepare(`UPDATE alerts SET muted_until = ? WHERE id = ?`).run(untilMs, id);
    if (res.changes === 0) return false;
    this.event(id, "muted", by, `until ${new Date(untilMs).toISOString()}`);
    return true;
  }

  unmute(id: string): boolean {
    const res = this.db.prepare(`UPDATE alerts SET muted_until = NULL WHERE id = ?`).run(id);
    if (res.changes === 0) return false;
    this.event(id, "unmuted", null, null);
    return true;
  }

  /** Re-fire an acknowledged alert after a fresh breach of the same rule. */
  refire(id: string): boolean {
    const res = this.db.prepare(`UPDATE alerts SET state = 'firing' WHERE id = ? AND state = 'acknowledged'`).run(id);
    if (res.changes === 0) return false;
    this.event(id, "re-fired", null, null);
    return true;
  }

  list(filter: { state?: AlertState | "open"; ruleId?: string; entity?: string; limit?: number } = {}): AlertRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.state === "open") clauses.push(`state IN ('firing','acknowledged')`);
    else if (filter.state) {
      clauses.push("state = @state");
      params.state = filter.state;
    }
    if (filter.ruleId) {
      clauses.push("rule_id = @ruleId");
      params.ruleId = filter.ruleId;
    }
    if (filter.entity) {
      clauses.push("entity = @entity");
      params.entity = filter.entity;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM alerts ${where} ORDER BY fired_at DESC LIMIT @limit`)
      .all({ ...params, limit: Math.min(filter.limit ?? 200, 1000) });
    return (rows as Record<string, unknown>[]).map(rowToAlert);
  }

  events(filter: { alertId?: string; since?: number; limit?: number } = {}): AlertEventRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.alertId) {
      clauses.push("alert_id = @alertId");
      params.alertId = filter.alertId;
    }
    if (filter.since != null) {
      clauses.push("ts >= @since");
      params.since = filter.since;
    }
    const rows = this.db
      .prepare(`SELECT * FROM alert_events ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ts DESC, id DESC LIMIT @limit`)
      .all({ ...params, limit: Math.min(filter.limit ?? 500, 5000) });
    return (rows as Record<string, unknown>[]).map(
      (r) =>
        ({
          id: r.id as number,
          ts: r.ts as number,
          alertId: r.alert_id as string,
          ruleId: r.rule_id as string,
          kind: r.kind as AlertEventRow["kind"],
          actor: (r.actor as string | null) ?? null,
          note: (r.note as string | null) ?? null,
        }) satisfies AlertEventRow,
    );
  }

  event(alertId: string, kind: AlertEventRow["kind"], actor: string | null, note: string | null): void {
    const alert = this.get(alertId);
    this.db
      .prepare(`INSERT INTO alert_events (ts, alert_id, rule_id, kind, actor, note) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(this.now(), alertId, alert?.ruleId ?? "", kind, actor, note);
    this.db.prepare(`DELETE FROM alert_events WHERE id NOT IN (SELECT id FROM alert_events ORDER BY ts DESC, id DESC LIMIT ?)`).run(this.maxEvents);
  }

  get(id: string): AlertRow | null {
    const row = this.db.prepare(`SELECT * FROM alerts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToAlert(row) : null;
  }
}

function rowToAlert(row: Record<string, unknown>): AlertRow {
  return {
    id: row.id as string,
    ruleId: row.rule_id as string,
    ruleName: row.rule_name as string,
    severity: row.severity as AlertSeverity,
    entity: row.entity as string,
    detail: row.detail as string,
    state: row.state as AlertState,
    firedAt: row.fired_at as number,
    ackedAt: (row.acked_at as number | null) ?? null,
    ackedBy: (row.acked_by as string | null) ?? null,
    resolvedAt: (row.resolved_at as number | null) ?? null,
    resolvedNote: (row.resolved_note as string | null) ?? null,
    mutedUntil: (row.muted_until as number | null) ?? null,
  };
}
