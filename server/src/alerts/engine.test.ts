import { describe, expect, it } from "vitest";
import { openDb } from "../stores/db.js";
import { AlertsStore } from "../stores/alertsStore.js";
import { AlertEngine, type EngineSample } from "./engine.js";
import { AlertRulesStore, SEED_RULES, alertRuleSchema, MAX_RULES } from "./rules.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIN = 60_000;

function harness(now: { t: number }) {
  const db = openDb(":memory:", 0);
  const alerts = new AlertsStore({ db, now: () => now.t });
  const rules = [
    alertRuleSchema.parse({
      id: "r-temp",
      name: "GPU temp high",
      severity: "warning",
      enabled: true,
      condition: { source: "node-metric", path: "gpu.tempC", op: ">=", value: 78, forMs: 15 * MIN },
    }),
    alertRuleSchema.parse({
      id: "r-down",
      name: "Node unreachable",
      severity: "critical",
      condition: { source: "node-unreachable", op: ">=", value: 1, forMs: 2 * MIN },
    }),
    alertRuleSchema.parse({
      id: "r-5xx",
      name: "Gateway 5xx",
      severity: "critical",
      condition: { source: "gateway-5xx", op: ">=", value: 2, forMs: 0 },
    }),
  ];
  const engine = new AlertEngine({ alerts, now: () => now.t }, () => rules);
  const sample = (sparkId: string, tempC: number | null, reachable = true, gateway5xxPct: number | null = null): EngineSample => ({
    sparkId,
    reachable,
    leaves: { "gpu.tempC": tempC },
    gateway5xxPct,
  });
  return { alerts, engine, sample };
}

describe("AlertEngine", () => {
  it("fires only after the breach holds for forMs; auto-resolves on clear", () => {
    const now = { t: 1_000_000 };
    const { alerts, engine, sample } = harness(now);
    now.t += MIN;
    expect(engine.tick([sample("dgx1", 80)])).toHaveLength(0); // clock starts
    now.t += 10 * MIN;
    expect(engine.tick([sample("dgx1", 79)])).toHaveLength(0); // 11 min < 15 min
    now.t += 5 * MIN;
    const fired = engine.tick([sample("dgx1", 79)]); // 16 min ≥ 15 min
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ ruleId: "r-temp", entity: "dgx1", state: "firing", severity: "warning" });

    // Still breaching → no duplicate.
    now.t += MIN;
    expect(engine.tick([sample("dgx1", 80)])).toHaveLength(0);

    // Condition clears → auto-resolve.
    now.t += MIN;
    expect(engine.tick([sample("dgx1", 70)])).toHaveLength(0);
    expect(alerts.list({ state: "open" })).toHaveLength(0);
    expect(alerts.list()[0]!.state).toBe("resolved");
    expect(alerts.list()[0]!.resolvedNote).toBe("condition cleared");
  });

  it("re-fires an acknowledged alert on continued breach unless muted", () => {
    const now = { t: 1_000_000 };
    const { alerts, engine, sample } = harness(now);
    now.t += MIN;
    engine.tick([sample("dgx1", 80)]); // breach clock starts
    now.t += 16 * MIN;
    const fired = engine.tick([sample("dgx1", 80)]);
    expect(fired).toHaveLength(1);
    alerts.acknowledge(fired[0]!.id, "on-call");

    // Still breaching, acknowledged, not muted → re-fire.
    now.t += MIN;
    const refired = engine.tick([sample("dgx1", 81)]);
    expect(refired).toHaveLength(1);
    expect(refired[0]!.state).toBe("firing");

    // Mute → no re-fire while muted.
    alerts.mute(refired[0]!.id, now.t + 60 * MIN, "on-call");
    alerts.acknowledge(refired[0]!.id, "on-call");
    now.t += MIN;
    expect(engine.tick([sample("dgx1", 82)])).toHaveLength(0);
  });

  it("handles node-unreachable and gateway-5xx sources", () => {
    const now = { t: 1_000_000 };
    const { alerts, engine, sample } = harness(now);
    // Unreachable: fires after 2 min.
    now.t += MIN;
    expect(engine.tick([sample("dgx2", null, false)])).toHaveLength(0);
    now.t += 2 * MIN;
    const fired = engine.tick([sample("dgx2", null, false)]);
    expect(fired.map((a) => a.ruleId)).toEqual(["r-down"]);
    // Back online → resolved.
    now.t += MIN;
    engine.tick([sample("dgx2", null, true)]);
    expect(alerts.list({ ruleId: "r-down" })[0]!.state).toBe("resolved");

    // Gateway 5xx: forMs=0 → immediate fleet-level fire.
    now.t += MIN;
    const g = engine.tick([sample("dgx1", 60, true, 3.5)]);
    expect(g.map((a) => a.ruleId)).toEqual(["r-5xx"]);
    expect(g[0]!.entity).toBe("_fleet");
    // Clears below threshold → resolved.
    now.t += MIN;
    engine.tick([sample("dgx1", 60, true, 0)]);
    expect(alerts.list({ ruleId: "r-5xx" })[0]!.state).toBe("resolved");
  });

  it("ignores missing metric data (never breaches)", () => {
    const now = { t: 1_000_000 };
    const { engine, sample } = harness(now);
    now.t += 30 * MIN;
    expect(engine.tick([sample("dgx1", null)])).toHaveLength(0);
  });
});

describe("AlertsStore lifecycle", () => {
  it("acknowledge stamps who/when; resolve records note; events carry the trail", () => {
    let t = 1_000_000;
    const alerts = new AlertsStore({ db: openDb(":memory:", 0), now: () => t });
    const a = alerts.insert({
      ruleId: "r",
      ruleName: "R",
      severity: "critical",
      entity: "dgx1",
      detail: "d",
      state: "firing",
      firedAt: t,
    });
    t += 1_000;
    expect(alerts.acknowledge(a.id, "piresbruno")).toBe(true);
    t += 1_000;
    expect(alerts.resolve(a.id, "rebooted")).toBe(true);
    const row = alerts.get(a.id)!;
    expect(row).toMatchObject({ state: "resolved", ackedBy: "piresbruno", resolvedNote: "rebooted" });
    expect(alerts.events({ alertId: a.id }).map((e) => e.kind)).toEqual(["resolved", "acknowledged", "fired"]);
  });
});

describe("AlertRulesStore", () => {
  it("seeds read-only examples; rejects edits to seeds; enforces the cap", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "cc-rules-")), "rules.json");
    const s = new AlertRulesStore({ filePath: file, seed: true });
    expect(s.list().map((r) => r.id)).toEqual(SEED_RULES.map((r) => r.id));
    const seedEdit = s.upsert({ ...SEED_RULES[0]!, name: "edited" });
    expect(seedEdit).toEqual({ error: "seed rules are read-only" });
    expect(s.remove(SEED_RULES[0]!.id)).toEqual({ error: "seed rules are read-only" });

    // User rules work; cap enforced.
    const ok = s.upsert(alertRuleSchema.parse({ id: "u1", name: "U", condition: { source: "node-metric", path: "gpu.utilPct", op: ">", value: 99, forMs: 0 } }));
    expect(ok).not.toHaveProperty("error");
    for (let i = 0; i < MAX_RULES; i++) {
      s.upsert(alertRuleSchema.parse({ id: `bulk-${i}`, name: `B${i}`, condition: { source: "gateway-5xx", op: ">", value: 99, forMs: 0 } }));
    }
    expect(s.upsert(alertRuleSchema.parse({ id: "overflow", name: "X", condition: { source: "gateway-5xx", op: ">", value: 1, forMs: 0 } }))).toEqual({
      error: expect.stringContaining("cap"),
    });
    const reloaded = new AlertRulesStore({ filePath: file });
    expect(reloaded.list().some((r) => r.id === "u1")).toBe(true);
  });
});
