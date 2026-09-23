/**
 * Request recorder (M4/F4): observes gateway response chunks and derives
 * TTFT (time to first chunk), inter-token latencies (SSE delta cadence),
 * and token counts (exact from usage fields when the engine reports them,
 * delta-count estimate for streams without usage). Emits trace records for
 * the TracesStore — request bodies are never captured.
 */
import type { TraceRecord } from "../stores/tracesStore.js";

interface SseUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface RecorderFinishMeta {
  ts: number;
  client: string | null;
  alias: string;
  model: string | null;
  nodeId: string | null;
  port: number | null;
  status: number | null;
  contentType?: string | null;
  attempts: TraceRecord["attempts"];
  error?: string | null;
}

export interface RecorderOptions {
  now?: () => number;
  maxItlSamples?: number;
}

export class RequestRecorder {
  private readonly nowFn: () => number;
  private readonly maxItl: number;
  private readonly itl: number[] = [];
  private startedAt: number;
  private firstChunkAt: number | null = null;
  private lastChunkAt: number | null = null;
  private text = "";
  private usage: SseUsage | null = null;
  private deltaCount = 0;

  constructor(opts: RecorderOptions = {}) {
    this.nowFn = opts.now ?? Date.now;
    this.maxItl = opts.maxItlSamples ?? 256;
    this.startedAt = this.nowFn();
  }

  /** Feed one response chunk (text-decoded) with its arrival time. */
  chunk(text: string, atMs: number): void {
    if (this.firstChunkAt == null) {
      this.firstChunkAt = atMs;
    } else if (this.lastChunkAt != null && this.itl.length < this.maxItl) {
      this.itl.push(atMs - this.lastChunkAt);
    }
    this.lastChunkAt = atMs;
    this.text += text;
  }

  /** Build the trace record; token counts prefer engine-reported usage. */
  finish(meta: RecorderFinishMeta): TraceRecord {
    const contentType = meta.contentType ?? "";
    const stream = contentType.includes("text/event-stream");
    if (stream) this.observeStream();
    const usage = this.usage ?? extractUsage(this.text, stream);
    const ttftMs = this.firstChunkAt != null ? this.firstChunkAt - this.startedAt : null;
    return {
      id: "",
      ts: meta.ts,
      client: meta.client,
      alias: meta.alias,
      model: meta.model,
      nodeId: meta.nodeId,
      port: meta.port,
      status: meta.status,
      ttftMs,
      durationMs: this.nowFn() - this.startedAt,
      stream,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? (stream && this.deltaCount > 0 ? this.deltaCount : null),
      itl: [...this.itl],
      attempts: meta.attempts,
      error: meta.error ?? null,
    };
  }

  /** Count content deltas and sniff usage from SSE data lines. */
  private observeStream(): void {
    for (const line of this.text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as {
          usage?: SseUsage;
          choices?: Array<{ delta?: { content?: string | null } }>;
        };
        if (parsed.usage) this.usage = parsed.usage;
        if (parsed.choices?.[0]?.delta?.content) this.deltaCount += 1;
      } catch {
        /* keep-alive or partial line */
      }
    }
  }
}

function extractUsage(text: string, stream: boolean): SseUsage | null {
  if (!stream) {
    try {
      const parsed = JSON.parse(text) as { usage?: SseUsage };
      return parsed.usage ?? null;
    } catch {
      return null;
    }
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as { usage?: SseUsage };
      if (parsed.usage) return parsed.usage;
    } catch {
      /* keep-alive line */
    }
  }
  return null;
}
