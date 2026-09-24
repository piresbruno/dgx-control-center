import type { ChatUsage } from "./store.js";

/**
 * Accumulate an OpenAI-style chat response: SSE deltas (streaming) or a single
 * JSON body. Used by the chat proxy to persist the assistant message while the
 * same chunks stream to the browser.
 */

interface ChatChunk {
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  choices?: Array<{
    delta?: { content?: string | null };
    message?: { content?: string | null };
  }>;
  error?: { message?: string };
}

function mapUsage(u: ChatChunk["usage"]): ChatUsage | null {
  if (!u) return null;
  return {
    promptTokens: u.prompt_tokens ?? null,
    completionTokens: u.completion_tokens ?? null,
    ...(u.total_tokens !== undefined ? { totalTokens: u.total_tokens } : {}),
  };
}

export class SseAccumulator {
  private buffer = "";
  private text = "";
  private observedUsage: ChatUsage | null = null;

  /** Feed a raw response chunk (may split SSE frames mid-line). */
  push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      this.consumeLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private consumeLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload) as ChatChunk;
      const next = mapUsage(parsed.usage);
      if (next) this.observedUsage = next;
      const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
      if (delta) this.text += delta;
    } catch {
      /* keep-alive or partial frame */
    }
  }

  get content(): string {
    return this.text;
  }

  get usage(): ChatUsage | null {
    return this.observedUsage;
  }
}

/** Non-streaming fallback: parse a complete JSON body; null when unparsable. */
export function parseCompletionBody(body: string | null): { content: string; usage: ChatUsage | null } | null {
  if (body == null) return null;
  try {
    const parsed = JSON.parse(body) as ChatChunk;
    return {
      content: parsed.choices?.[0]?.message?.content ?? "",
      usage: mapUsage(parsed.usage),
    };
  } catch {
    return null;
  }
}
