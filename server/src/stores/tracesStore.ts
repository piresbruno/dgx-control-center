import type Database from "better-sqlite3";

/**
 * Gateway traces store (M4): request metadata + latency metrics in SQLite.
 * Bodies are NEVER stored (privacy default); the redact-list governs optional
 * metadata keys before insert. Caps: row limit + age-based retention.
 */
import { randomUUID } from "node:crypto";

export interface TraceRecord {
  id: string;
  ts: number;
  client: string | null;
  alias: string;
  model: string | null;
  nodeId: string | null;
  port: number | null;
  status: number | null;
  ttftMs: number | null;
  durationMs: number;
  stream: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Inter-token latencies (ms), capped sample. */
  itl: number[];
  attempts: Array<{ nodeId: string; port: number; status: number | null; error?: string }>;
  error: string | null;
}

export interface TraceListFilter {
  alias?: string;
  client?: string;
  since?: number;
  limit?: number;
}

export interface TracesStoreDeps {
  db: Database.Database;
  now?: () => number;
  /** Header/metadata keys never persisted (M7 capture settings refine this). */
  redactList?: string[];
  maxRows?: number;
  maxAgeMs?: number;
}

const DEFAULT_MAX_ROWS = 20_000;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600_000;

export class TracesStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly redactList: Set<string>;
  private readonly maxRows: number;
  private readonly maxAgeMs: number;

  constructor(deps: TracesStoreDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.redactList = new Set(deps.redactList ?? ["authorization", "api-key", "x-api-key", "cookie"]);
    this.maxRows = deps.maxRows ?? DEFAULT_MAX_ROWS;
    this.maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  insert(rec: Omit<TraceRecord, "id">): TraceRecord {
    // Redact any metadata keys that slipped in (defense in depth).
    const full: TraceRecord = {
      ...rec,
      id: randomUUID(),
      client: rec.client && this.redactList.has(rec.client.toLowerCase()) ? "[redacted]" : rec.client,
    };
    this.db
      .prepare(
        `INSERT INTO gateway_traces
         (id, ts, client, alias, model, node_id, port, status, ttft_ms, duration_ms, stream, prompt_tokens, completion_tokens, itl, attempts, error)
         VALUES (@id, @ts, @client, @alias, @model, @nodeId, @port, @status, @ttftMs, @durationMs, @stream, @promptTokens, @completionTokens, @itl, @attempts, @error)`,
      )
      .run({
        id: full.id,
        ts: full.ts,
        client: full.client,
        alias: full.alias,
        model: full.model,
        nodeId: full.nodeId,
        port: full.port,
        status: full.status,
        ttftMs: full.ttftMs,
        durationMs: full.durationMs,
        stream: full.stream ? 1 : 0,
        promptTokens: full.promptTokens,
        completionTokens: full.completionTokens,
        itl: JSON.stringify(full.itl.slice(0, 256)),
        attempts: JSON.stringify(full.attempts),
        error: full.error,
      });
    return full;
  }

  list(filter: TraceListFilter = {}): TraceRecord[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.alias) {
      clauses.push("alias = @alias");
      params.alias = filter.alias;
    }
    if (filter.client) {
      clauses.push("client = @client");
      params.client = filter.client;
    }
    if (filter.since != null) {
      clauses.push("ts >= @since");
      params.since = filter.since;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(filter.limit ?? 200, 1000);
    const rows = this.db
      .prepare(`SELECT * FROM gateway_traces ${where} ORDER BY ts DESC LIMIT @limit`)
      .all({ ...params, limit });
    return (rows as Record<string, unknown>[]).map(rowToRecord);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM gateway_traces").get() as { n: number }).n;
  }

  /** Enforce caps: delete oldest beyond maxRows and older than maxAgeMs. */
  prune(): { removed: number } {
    const cutoff = this.now() - this.maxAgeMs;
    const ageDel = this.db.prepare("DELETE FROM gateway_traces WHERE ts < ?").run(cutoff);
    const rowDel = this.db
      .prepare(
        `DELETE FROM gateway_traces WHERE id IN (
           SELECT id FROM gateway_traces ORDER BY ts DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(this.maxRows);
    return { removed: ageDel.changes + rowDel.changes };
  }
}

function rowToRecord(row: Record<string, unknown>): TraceRecord {
  return {
    id: row.id as string,
    ts: row.ts as number,
    client: (row.client as string | null) ?? null,
    alias: row.alias as string,
    model: (row.model as string | null) ?? null,
    nodeId: (row.node_id as string | null) ?? null,
    port: (row.port as number | null) ?? null,
    status: (row.status as number | null) ?? null,
    ttftMs: (row.ttft_ms as number | null) ?? null,
    durationMs: row.duration_ms as number,
    stream: row.stream === 1,
    promptTokens: (row.prompt_tokens as number | null) ?? null,
    completionTokens: (row.completion_tokens as number | null) ?? null,
    itl: safeJson(row.itl as string | null, []),
    attempts: safeJson(row.attempts as string | null, []),
    error: (row.error as string | null) ?? null,
  };
}

function safeJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
