/**
 * Benchmarks-as-jobs (M6/F5a): decode / prefill sweeps against a LOCAL engine
 * port on a node, dispatched through the agent job channel. The harness is a
 * python3 stdlib script (no external deps) emitting one JSON record per
 * iteration: {"i":1,"durationMs":456,"completionTokens":16,"promptTokens":9}
 * — tok/s (decode) and throughput (prefill) derive from usage in the UI.
 */
import { z } from "zod";

export const benchParamsSchema = z.object({
  port: z.number().int().min(1).max(65535),
  model: z.string().min(1).max(200),
  prompt: z.string().max(2000).optional(),
  maxTokens: z.number().int().min(1).max(4096).default(128),
  iterations: z.number().int().min(1).max(20).default(5),
});
export type BenchParams = z.infer<typeof benchParamsSchema>;

export function buildBenchScript(kind: "decode" | "prefill", p: BenchParams): string {
  const cfg = JSON.stringify({
    url: `http://127.0.0.1:${p.port}/v1/chat/completions`,
    body: { model: p.model, messages: [{ role: "user", content: p.prompt ?? (kind === "prefill" ? "Summarize the Iliad in detail." : "Write a story about a cat.") }], max_tokens: p.maxTokens },
    iterations: p.iterations,
  });
  return `python3 - <<'PY'\nimport json, time, urllib.request\ncfg = json.loads(${JSON.stringify(cfg)})\nfor i in range(cfg["iterations"]):\n    body = json.dumps(cfg["body"]).encode()\n    t0 = time.time()\n    try:\n        r = urllib.request.urlopen(urllib.request.Request(cfg["url"], data=body, headers={"content-type": "application/json"}), timeout=180)\n        d = json.load(r)\n        dt = int((time.time() - t0) * 1000)\n        u = d.get("usage") or {}\n        print(json.dumps({"i": i + 1, "durationMs": dt, "completionTokens": u.get("completion_tokens"), "promptTokens": u.get("prompt_tokens")}))\n    except Exception as e:\n        print(json.dumps({"i": i + 1, "error": str(e)[:120]}))\nPY`;
}
