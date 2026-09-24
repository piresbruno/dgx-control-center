/**
 * Alert rules (M6/F5a): user-editable condition rules over the live pipeline.
 * Seeded examples are read-only; user rules capped at 50. JSON store.
 */
import fs from "node:fs";
import { z } from "zod";

export const conditionSource = z.enum(["node-metric", "gateway-5xx", "node-unreachable"]);
export type ConditionSource = z.infer<typeof conditionSource>;

export const alertConditionSchema = z.object({
  source: conditionSource,
  /** Leaf path into the node's flattened metric leaves (node-metric only). */
  path: z.string().min(1).max(80).optional(),
  op: z.enum([">", "<", ">=", "<=", "="]),
  value: z.number(),
  /** Breach must hold continuously for this long before firing. */
  forMs: z.number().int().min(0).max(24 * 3600_000).default(0),
});
export type AlertCondition = z.infer<typeof alertConditionSchema>;

export const alertRuleSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  severity: z.enum(["info", "warning", "critical"]).default("warning"),
  enabled: z.boolean().default(true),
  /** Seeded examples are read-only. */
  seed: z.boolean().default(false),
  condition: alertConditionSchema,
});
export type AlertRule = z.infer<typeof alertRuleSchema>;

export const alertRulesFileSchema = z.object({
  version: z.literal(1).default(1),
  rules: z.array(alertRuleSchema).default([]),
});

export const MAX_RULES = 50;

/** Read-only seed rules (documented examples; deletable only by file edit). */
export const SEED_RULES: AlertRule[] = [
  {
    id: "seed-gpu-temp",
    name: "GPU temperature high",
    severity: "warning",
    enabled: true,
    seed: true,
    condition: { source: "node-metric", path: "gpu.tempC", op: ">=", value: 78, forMs: 15 * 60_000 },
  },
  {
    id: "seed-node-down",
    name: "Node unreachable",
    severity: "critical",
    enabled: true,
    seed: true,
    condition: { source: "node-unreachable", op: ">=", value: 1, forMs: 2 * 60_000 },
  },
  {
    id: "seed-gateway-5xx",
    name: "Gateway 5xx rate",
    severity: "critical",
    enabled: false,
    seed: true,
    condition: { source: "gateway-5xx", op: ">=", value: 2, forMs: 10 * 60_000 },
  },
];

export interface RuleStoreDeps {
  filePath: string;
  /** Seed the example rules on first run. */
  seed?: boolean;
}

export class AlertRulesStore {
  private data: z.infer<typeof alertRulesFileSchema> = alertRulesFileSchema.parse({});
  private readonly file: string;

  constructor(deps: RuleStoreDeps) {
    this.file = deps.filePath;
    this.load(deps);
  }

  private load(deps: RuleStoreDeps): void {
    try {
      if (!fs.existsSync(this.file)) {
        if (deps.seed) {
          this.data = { version: 1, rules: SEED_RULES };
          this.persist();
        }
        return;
      }
      this.data = alertRulesFileSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch (err) {
      console.error("[alert-rules] failed to load:", err instanceof Error ? err.message : err);
      this.data = alertRulesFileSchema.parse({});
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[alert-rules] failed to persist:", err instanceof Error ? err.message : err);
    }
  }

  list(): AlertRule[] {
    return [...this.data.rules];
  }

  get(id: string): AlertRule | null {
    return this.data.rules.find((r) => r.id === id) ?? null;
  }

  upsert(rule: AlertRule): AlertRule | { error: string } {
    if (rule.seed) return { error: "seed rules are read-only" };
    const existing = this.data.rules.find((r) => r.id === rule.id);
    if (!existing && this.data.rules.length >= MAX_RULES) return { error: `rule cap (${MAX_RULES}) reached` };
    const parsed = alertRuleSchema.parse({ ...rule, seed: false });
    this.data.rules = existing ? this.data.rules.map((r) => (r.id === rule.id ? parsed : r)) : [...this.data.rules, parsed];
    this.persist();
    return parsed;
  }

  remove(id: string): boolean | { error: string } {
    const existing = this.data.rules.find((r) => r.id === id);
    if (!existing) return false;
    if (existing.seed) return { error: "seed rules are read-only" };
    this.data.rules = this.data.rules.filter((r) => r.id !== id);
    this.persist();
    return true;
  }
}
