import { describe, expect, it } from "vitest";
import { RequestRecorder } from "./recorder.js";
import { TracesStore } from "../stores/tracesStore.js";
import { openDb } from "../stores/db.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("RequestRecorder", () => {
  const base = {
    ts: 1_000,
    client: "showcase",
    alias: "glm",
    model: "GLM-5.3-Flash-EXL3",
    nodeId: "dgx1",
    port: 8081,
    status: 200,
    attempts: [],
  };

  it("derives TTFT and ITL from SSE chunk cadence", () => {
    const clock = { t: 10_000 };
    const rec = new RequestRecorder({ now: () => clock.t });
    rec.chunk('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', 10_050);
    rec.chunk('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n', 10_080);
    rec.chunk('data: {"choices":[{"delta":{"content":" world"}}]}\n\n', 10_140);
    const trace = rec.finish({ ...base, contentType: "text/event-stream" });
    expect(trace.stream).toBe(true);
    expect(trace.ttftMs).toBe(50);
    expect(trace.itl).toEqual([30, 60]);
    // No usage field → delta-count estimate: 3 content deltas.
    expect(trace.completionTokens).toBe(3);
  });

  it("prefers engine-reported usage on the final SSE chunk", () => {
    const rec = new RequestRecorder({ now: () => 0 });
    rec.chunk('data: {"choices":[{"delta":{"content":"a"}}]}\n\n', 5);
    rec.chunk('data: {"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\n', 10);
    const trace = rec.finish({ ...base, contentType: "text/event-stream" });
    expect(trace.promptTokens).toBe(12);
    expect(trace.completionTokens).toBe(34);
  });

  it("reads usage from non-stream JSON bodies", () => {
    const rec = new RequestRecorder({ now: () => 0 });
    rec.chunk(JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 9 } }), 5);
    const trace = rec.finish({ ...base, contentType: "application/json" });
    expect(trace.stream).toBe(false);
    expect(trace.ttftMs).toBe(5);
    expect(trace.promptTokens).toBe(7);
    expect(trace.completionTokens).toBe(9);
  });
});

describe("TracesStore", () => {
  async function store() {
    const file = join(await mkdtemp(join(tmpdir(), "cc-traces-")), "test.db");
    return new TracesStore({ db: openDb(file, 1_000), now: () => 1_000 });
  }

  const rec = (over: Partial<Parameters<TracesStore["insert"]>[0]> = {}) => ({
    ts: 1_000,
    client: "showcase",
    alias: "glm",
    model: "GLM",
    nodeId: "dgx1",
    port: 8081,
    status: 200,
    ttftMs: 40,
    durationMs: 400,
    stream: true,
    promptTokens: 10,
    completionTokens: 20,
    itl: [30, 35],
    attempts: [{ nodeId: "dgx1", port: 8081, status: 200 }],
    error: null,
    ...over,
  });

  it("inserts, lists with filters, newest first", async () => {
    const s = await store();
    s.insert(rec({ ts: 1_000, alias: "glm" }));
    s.insert(rec({ ts: 2_000, alias: "qwen", client: "bench" }));
    expect(s.count()).toBe(2);
    expect(s.list()[0]!.alias).toBe("qwen");
    expect(s.list({ alias: "glm" })).toHaveLength(1);
    expect(s.list({ client: "bench" })[0]!.alias).toBe("qwen");
    expect(s.list({ since: 1_500 })).toHaveLength(1);
    const one = s.list()[0]!;
    expect(one.itl).toEqual([30, 35]);
    expect(one.attempts[0]).toEqual({ nodeId: "dgx1", port: 8081, status: 200 });
  });

  it("redacts listed metadata keys", async () => {
    const s = await store();
    s.insert(rec({ client: "authorization" }));
    expect(s.list()[0]!.client).toBe("[redacted]");
  });

  it("prunes by row cap and age", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "cc-traces-")), "test.db");
    let t = 1_000;
    const s = new TracesStore({
      db: openDb(file, t),
      now: () => t,
      maxRows: 3,
      maxAgeMs: 1_000,
    });
    for (let i = 0; i < 5; i++) {
      t += 400;
      s.insert(rec({ ts: t }));
    }
    const { removed } = s.prune();
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(s.count()).toBe(3);
    expect(s.list().every((r) => r.ts > 1_000 + 1_000)).toBe(true); // age cutoff honored
  });
});
