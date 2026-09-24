import { describe, expect, it } from "vitest";
import { AlertDelivery, WebhookStore } from "./delivery.js";
import type { AlertRow } from "../stores/alertsStore.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const alert = (over: Partial<AlertRow> = {}): AlertRow => ({
  id: "a1",
  ruleId: "r",
  ruleName: "Node unreachable",
  severity: "critical",
  entity: "dgx1",
  detail: "node unreachable",
  state: "firing",
  firedAt: 1_700_000_000_000,
  ackedAt: null,
  ackedBy: null,
  resolvedAt: null,
  resolvedNote: null,
  mutedUntil: null,
  ...over,
});

describe("AlertDelivery", () => {
  it("broadcasts a toast frame per alert", async () => {
    const frames: unknown[] = [];
    const webhooks = new WebhookStore({ filePath: join(await mkdtemp(join(tmpdir(), "cc-wh-")), "w.json") });
    const delivery = new AlertDelivery({ broadcast: (m) => frames.push(m), webhooks });
    delivery.deliver([alert()]);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "alert", alert: { id: "a1", severity: "critical", entity: "dgx1" } });
  });

  it("POSTs to webhooks matching the severity and skips others", async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", body });
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const file = join(await mkdtemp(join(tmpdir(), "cc-wh-")), "w.json");
    const webhooks = new WebhookStore({ filePath: file });
    expect(webhooks.add("ftp://bad", ["critical"])).toEqual({ error: "only http(s) webhooks" });
    const hook = webhooks.add(`http://127.0.0.1:${port}/hook`, ["critical"]);
    if ("error" in hook) throw new Error(hook.error);
    expect(webhooks.add(`http://127.0.0.1:${port}/info-hook`, ["info"])).not.toHaveProperty("error");

    const delivery = new AlertDelivery({ broadcast: () => {}, webhooks });
    delivery.deliver([alert({ severity: "critical" }), alert({ id: "a2", severity: "info" })]);
    await new Promise((r) => setTimeout(r, 150));
    // Each alert hit only its matching severity hook.
    expect(seen.map((s) => s.url).sort()).toEqual(["/hook", "/info-hook"]);
    const parsed = JSON.parse(seen.find((s) => s.url === "/hook")!.body);
    expect(parsed).toMatchObject({ kind: "controlcenter.alert", id: "a1", severity: "critical" });

    // Removal works.
    expect(webhooks.remove(hook.id)).toBe(true);
    server.close();
  });

  it("does not throw on webhook failure (logged, no retry)", async () => {
    const webhooks = new WebhookStore({ filePath: join(await mkdtemp(join(tmpdir(), "cc-wh-")), "w.json") });
    webhooks.add("http://127.0.0.1:9/hook", ["critical"]); // port 9 — refused
    const delivery = new AlertDelivery({ broadcast: () => {}, webhooks });
    expect(() => delivery.deliver([alert()])).not.toThrow();
  });
});
