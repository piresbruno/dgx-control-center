/**
 * Alert delivery (M6/F5a): pushes new/re-fired alerts to connected browsers
 * (in-app toast) and to optional per-severity webhooks (generic JSON POST —
 * no third-party integrations in v1). Webhook failures log; no retries.
 */
import fs from "node:fs";
import { z } from "zod";
import type { AlertRow, AlertSeverity } from "../stores/alertsStore.js";

const webhooksFileSchema = z.object({
  version: z.literal(1).default(1),
  webhooks: z
    .array(
      z.object({
        id: z.string().min(1),
        url: z.string().url(),
        severities: z.array(z.enum(["info", "warning", "critical"])).min(1),
      }),
    )
    .default([]),
});
export type AlertWebhook = z.infer<typeof webhooksFileSchema>["webhooks"][number];

export class WebhookStore {
  private data: z.infer<typeof webhooksFileSchema> = webhooksFileSchema.parse({});
  private readonly file: string;

  constructor(deps: { filePath: string }) {
    this.file = deps.filePath;
    try {
      if (fs.existsSync(this.file)) this.data = webhooksFileSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch (err) {
      console.error("[alert-webhooks] failed to load:", err instanceof Error ? err.message : err);
    }
  }

  list(): AlertWebhook[] {
    return [...this.data.webhooks];
  }

  add(url: string, severities: AlertSeverity[]): AlertWebhook | { error: string } {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: "invalid url" };
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return { error: "only http(s) webhooks" };
    const rec: AlertWebhook = { id: `wh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, url, severities };
    this.data.webhooks.push(rec);
    this.persist();
    return rec;
  }

  remove(id: string): boolean {
    const before = this.data.webhooks.length;
    this.data.webhooks = this.data.webhooks.filter((w) => w.id !== id);
    if (this.data.webhooks.length === before) return false;
    this.persist();
    return true;
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[alert-webhooks] failed to persist:", err instanceof Error ? err.message : err);
    }
  }
}

export interface AlertDeliveryDeps {
  /** Push a frame to every connected browser (WS toast). */
  broadcast: (msg: unknown) => void;
  webhooks: WebhookStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class AlertDelivery {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: AlertDeliveryDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** Fan out newly fired / re-fired alerts: WS toast + matching webhooks. */
  deliver(alerts: AlertRow[]): void {
    for (const alert of alerts) {
      this.deps.broadcast({
        type: "alert",
        alert: {
          id: alert.id,
          ruleName: alert.ruleName,
          severity: alert.severity,
          entity: alert.entity,
          detail: alert.detail,
          firedAt: alert.firedAt,
        },
      });
      for (const hook of this.deps.webhooks.list()) {
        if (!hook.severities.includes(alert.severity)) continue;
        this.post(hook.url, alert).catch((err) => console.error(`[alert-webhook] ${hook.id} failed:`, err instanceof Error ? err.message : err));
      }
    }
  }

  private async post(url: string, alert: AlertRow): Promise<void> {
    await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "controlcenter.alert",
        id: alert.id,
        ruleName: alert.ruleName,
        severity: alert.severity,
        entity: alert.entity,
        detail: alert.detail,
        firedAt: new Date(alert.firedAt).toISOString(),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  }
}
