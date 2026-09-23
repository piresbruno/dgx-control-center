import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { TracesStore } from "./tracesStore.js";
import { TraceQueries } from "./traceQueries.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOUR = 3600_000;

async function setup() {
  const file = join(await mkdtemp(join(tmpdir(), "cc-q-")), "a.db");
  const db = openDb(file, 0);
  const store = new TracesStore({ db, now: () => 0 });
  // hour 1: 2 ok glm via dgx1 for showcase, 1 error qwen via dgx2 for bench
  store.insert({ ts: 1 * HOUR + 100, client: "showcase", alias: "glm", model: "G", nodeId: "dgx1", port: 8081, status: 200, ttftMs: 40, durationMs: 400, stream: false, promptTokens: 10, completionTokens: 20, itl: [], attempts: [], error: null });
  store.insert({ ts: 1 * HOUR + 200, client: "showcase", alias: "glm", model: "G", nodeId: "dgx1", port: 8081, status: 200, ttftMs: 60, durationMs: 500, stream: false, promptTokens: 5, completionTokens: 5, itl: [], attempts: [], error: null });
  store.insert({ ts: 1 * HOUR + 300, client: "bench", alias: "qwen", model: "Q", nodeId: "dgx2", port: 8082, status: 502, ttftMs: null, durationMs: 900, stream: false, promptTokens: null, completionTokens: null, itl: [], attempts: [], error: "upstream down" });
  // hour 2: 1 ok glm
  store.insert({ ts: 2 * HOUR + 100, client: "showcase", alias: "glm", model: "G", nodeId: "dgx1", port: 8081, status: 200, ttftMs: 200, durationMs: 800, stream: false, promptTokens: 1, completionTokens: 1, itl: [], attempts: [], error: null });
  return { queries: new TraceQueries(db) };
}

describe("TraceQueries", () => {
  it("computes KPIs over the window", async () => {
    const { queries } = await setup();
    const k = queries.kpis(0);
    expect(k.requests).toBe(4);
    expect(k.errors).toBe(1);
    expect(k.errorRate).toBeCloseTo(0.25);
    // ttft samples sorted: 40, 60, 200 → p50 = 60, p95 = 200
    expect(k.ttftP50Ms).toBe(60);
    expect(k.ttftP95Ms).toBe(200);
    expect(k.promptTokens).toBe(16);
    expect(k.completionTokens).toBe(26);
  });

  it("groups by client, alias and engine hop", async () => {
    const { queries } = await setup();
    const byClient = queries.byClient(0);
    expect(byClient[0]).toMatchObject({ key: "showcase", requests: 3, errors: 0, tokens: 42 });
    const byAlias = queries.byAlias(0);
    expect(byAlias.map((r) => r.key)).toEqual(["glm", "qwen"]);
    const byDep = queries.byDeployment(0);
    expect(byDep).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "dgx1:8081", requests: 3 }),
        expect.objectContaining({ key: "dgx2:8082", requests: 1, errors: 1 }),
      ]),
    );
  });

  it("buckets by hour", async () => {
    const { queries } = await setup();
    const rows = queries.byHour(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ bucket: 1 * HOUR, requests: 3, errors: 1, tokens: 40 });
    expect(rows[1]).toEqual({ bucket: 2 * HOUR, requests: 1, errors: 0, tokens: 2 });
  });

  it("respects the since window", async () => {
    const { queries } = await setup();
    const k = queries.kpis(2 * HOUR);
    expect(k.requests).toBe(1);
    expect(k.ttftP50Ms).toBe(200);
    expect(queries.byAlias(2 * HOUR)).toEqual([expect.objectContaining({ key: "glm", requests: 1 })]);
  });
});
