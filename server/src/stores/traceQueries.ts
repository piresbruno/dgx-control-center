/**
 * Analysis aggregations (M4/F5) over gateway_traces: KPIs, per-client /
 * per-model / per-node(hop) rollups and hourly series. Percentiles are
 * computed in-process from the window's TTFT samples (bounded).
 */
import type Database from "better-sqlite3";

export interface TraceKpis {
  windowMs: number;
  requests: number;
  errors: number;
  errorRate: number;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  promptTokens: number;
  completionTokens: number;
}

export interface GroupRow {
  key: string;
  requests: number;
  errors: number;
  tokens: number;
  avgDurationMs: number;
}

export interface HourRow {
  /** Hour bucket (epoch ms, UTC-aligned). */
  bucket: number;
  requests: number;
  errors: number;
  tokens: number;
}

export class TraceQueries {
  constructor(private readonly db: Database.Database) {}

  kpis(since: number): TraceKpis {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                SUM(CASE WHEN status IS NULL OR status >= 400 THEN 1 ELSE 0 END) AS errors,
                SUM(COALESCE(prompt_tokens, 0)) AS prompt,
                SUM(COALESCE(completion_tokens, 0)) AS completion
         FROM gateway_traces WHERE ts >= ?`,
      )
      .get(since) as { requests: number; errors: number | null; prompt: number | null; completion: number | null };
    const ttfts = (
      this.db
        .prepare(`SELECT ttft_ms FROM gateway_traces WHERE ts >= ? AND ttft_ms IS NOT NULL ORDER BY ttft_ms`)
        .all(since) as Array<{ ttft_ms: number }>
    ).map((r) => r.ttft_ms);
    return {
      windowMs: since,
      requests: row.requests,
      errors: row.errors ?? 0,
      errorRate: row.requests > 0 ? (row.errors ?? 0) / row.requests : 0,
      ttftP50Ms: percentile(ttfts, 50),
      ttftP95Ms: percentile(ttfts, 95),
      promptTokens: row.prompt ?? 0,
      completionTokens: row.completion ?? 0,
    };
  }

  private group(since: number, column: string): GroupRow[] {
    return this.db
      .prepare(
        `SELECT COALESCE(${column}, '—') AS key,
                COUNT(*) AS requests,
                SUM(CASE WHEN status IS NULL OR status >= 400 THEN 1 ELSE 0 END) AS errors,
                SUM(COALESCE(prompt_tokens,0) + COALESCE(completion_tokens,0)) AS tokens,
                AVG(duration_ms) AS avgDurationMs
         FROM gateway_traces WHERE ts >= ?
         GROUP BY key ORDER BY requests DESC LIMIT 50`,
      )
      .all(since) as unknown as GroupRow[];
  }

  byClient(since: number): GroupRow[] {
    return this.group(since, "client");
  }

  byAlias(since: number): GroupRow[] {
    return this.group(since, "alias");
  }

  /** Per engine hop (node:port the request was actually served by). */
  byDeployment(since: number): GroupRow[] {
    return this.group(since, "node_id || ':' || port");
  }

  byHour(since: number): HourRow[] {
    return this.db
      .prepare(
        `SELECT (ts / 3600000) * 3600000 AS bucket,
                COUNT(*) AS requests,
                SUM(CASE WHEN status IS NULL OR status >= 400 THEN 1 ELSE 0 END) AS errors,
                SUM(COALESCE(prompt_tokens,0) + COALESCE(completion_tokens,0)) AS tokens
         FROM gateway_traces WHERE ts >= ?
         GROUP BY bucket ORDER BY bucket`,
      )
      .all(since) as unknown as HourRow[];
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}
