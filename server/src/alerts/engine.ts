/**
 * Alert engine (M6/F5a): evaluates enabled rules over per-node samples on the
 * 1-minute tick (+ event-driven callers for state conditions). Deterministic
 * and injectable-clock. A breach must hold for `forMs` continuously before an
 * alert fires; auto-resolve when the condition clears; acknowledged alerts
 * re-fire on a fresh breach unless muted; muted windows suppress re-fire.
 * Alerts observe and route — they never remediate.
 */
import type { AlertsStore, AlertRow } from "../stores/alertsStore.js";
import type { AlertRule } from "./rules.js";

export interface EngineSample {
  sparkId: string;
  reachable: boolean;
  /** Flattened numeric leaves for the node (e.g. gpu.tempC). */
  leaves: Record<string, number | null>;
  /** Fleet-level 5xx percentage over the rule window (gateway-5xx source). */
  gateway5xxPct?: number | null;
}

export interface EngineDeps {
  alerts: AlertsStore;
  now?: () => number;
}

interface Entity {
  entity: string;
  detail: string;
  /** For node-unreachable: 1 = unreachable. Null = no data (never breaches). */
  value: number | null;
}

const OPS: Record<AlertRule["condition"]["op"], (a: number, b: number) => boolean> = {
  ">": (a, b) => a > b,
  "<": (a, b) => a < b,
  ">=": (a, b) => a >= b,
  "<=": (a, b) => a <= b,
  "=": (a, b) => a === b,
};

function entitiesFor(rule: AlertRule, samples: EngineSample[]): Entity[] {
  const { source, path } = rule.condition;
  if (source === "gateway-5xx") {
    const pct = samples.find((s) => s.gateway5xxPct != null)?.gateway5xxPct ?? null;
    return [{ entity: "_fleet", detail: `gateway 5xx rate ${pct != null ? `${pct.toFixed(2)}%` : "unknown"}`, value: pct }];
  }
  return samples.map((s) => {
    if (source === "node-unreachable") {
      return { entity: s.sparkId, detail: s.reachable ? "node reachable" : "node unreachable since last snapshot", value: s.reachable ? 0 : 1 };
    }
    const value = s.leaves[path ?? ""] ?? null;
    return { entity: s.sparkId, detail: `${path ?? "metric"} = ${value ?? "no data"}`, value };
  });
}

function isBreaching(rule: AlertRule, entity: Entity): boolean {
  if (rule.condition.source === "node-unreachable") return entity.value === 1;
  if (entity.value == null) return false;
  return OPS[rule.condition.op](entity.value, rule.condition.value);
}

export class AlertEngine {
  /** breachSince key: `${ruleId}|${entity}` — cleared when the condition clears. */
  private readonly breachSince = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly deps: EngineDeps,
    private readonly rules: () => AlertRule[],
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** Evaluate all enabled rules; returns alerts fired or re-fired this tick. */
  tick(samples: EngineSample[]): AlertRow[] {
    const now = this.now();
    const touched: AlertRow[] = [];
    for (const rule of this.rules()) {
      if (!rule.enabled) continue;
      for (const entity of entitiesFor(rule, samples)) {
        const key = `${rule.id}|${entity.entity}`;
        if (isBreaching(rule, entity)) {
          this.breachSince.set(key, this.breachSince.get(key) ?? now);
          if (now - this.breachSince.get(key)! >= rule.condition.forMs) {
            const open = this.deps.alerts.openByRuleEntity(rule.id, entity.entity);
            if (!open) {
              const alert = this.deps.alerts.insert({
                ruleId: rule.id,
                ruleName: rule.name,
                severity: rule.severity,
                entity: entity.entity,
                detail: entity.detail,
                state: "firing",
                firedAt: now,
              });
              touched.push(alert);
            } else if (open.state === "acknowledged" && (open.mutedUntil ?? 0) < now) {
              if (this.deps.alerts.refire(open.id)) touched.push(this.deps.alerts.get(open.id)!);
            }
          }
        } else {
          this.breachSince.delete(key);
          const open = this.deps.alerts.openByRuleEntity(rule.id, entity.entity);
          if (open) this.deps.alerts.resolve(open.id, "condition cleared", true);
        }
      }
    }
    return touched;
  }
}
