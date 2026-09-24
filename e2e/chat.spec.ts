import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

/**
 * Chat page (M8) against the fake-fleet API: a stub engine streams SSE through
 * the gateway router, the page renders streaming markdown, folder project
 * context shows up, and image attachments reach the upstream as vision parts.
 */

let engine: Server;
let enginePort = 0;
/** Unique per run: the scratch config dir persists between local runs. */
const alias = `e2e-chat-${Date.now().toString(36)}`;
const seenBodies: Array<Record<string, unknown>> = [];

test.beforeAll(async () => {
  engine = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seenBodies.push(JSON.parse(raw || "{}") as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Answer with **bold** text"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":6,"total_tokens":11}}\n\n');
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
  enginePort = (engine.address() as AddressInfo).port;
});

test.afterAll(async () => {
  engine.close();
  // Drop the run's served-model record so repeated local runs stay clean.
  const list = (await (await fetch("http://127.0.0.1:5599/api/gateway/served-models")).json()) as {
    models: Array<{ id: string; alias: string }>;
  };
  const mine = list.models.find((m) => m.alias === alias);
  if (mine) await fetch(`http://127.0.0.1:5599/api/gateway/served-models/${mine.id}`, { method: "DELETE" });
});

test("chat streams a markdown reply, shows folder context, and routes images", async ({ page, request }) => {
  const api = request; // same baseURL as the page proxy target

  // Serve the stub engine through the gateway router and set up a folder chat.
  const served = await api.post("/api/gateway/served-models", {
    data: { alias, targets: [{ nodeId: "dgx1", port: enginePort }], vision: true },
  });
  expect(served.ok(), await served.text()).toBeTruthy();
  const folder = await api.post("/api/chat/folders", {
    data: { name: "E2E folder", description: "E2E project context marker" },
  });
  expect(folder.ok()).toBeTruthy();
  const folderId = ((await folder.json()) as { id: string }).id;
  const conversation = await api.post("/api/chat/conversations", {
    data: { model: alias, folderId, title: "E2E chat" },
  });
  expect(conversation.ok()).toBeTruthy();
  const conversationId = ((await conversation.json()) as { id: string }).id;

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/");
  await page.getByTestId("nav-chat").click();
  await expect(page.getByTestId(`chat-conv-${conversationId}`)).toBeVisible();
  await page.getByTestId(`chat-conv-${conversationId}`).click();

  // Folder project context is visible and will be injected server-side.
  await expect(page.getByTestId("folder-context-banner")).toContainText("E2E project context marker");

  // Text turn: send and watch the streamed markdown land.
  await page.getByTestId("chat-input").fill("hello engine");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-msg-assistant")).toContainText("Answer with bold text", { timeout: 15_000 });
  await expect(page.getByTestId("chat-msg-assistant").locator("strong")).toHaveText("bold");
  await expect(page.getByTestId("chat-msg-assistant")).toContainText("5 in / 6 out tokens");
  await expect(page.getByTestId("chat-msg-user")).toContainText("hello engine");

  // Folder context reached the engine as a system message.
  const textTurn = seenBodies.at(-1) as { messages: Array<{ role: string; content: unknown }> };
  expect(textTurn.messages[0]).toMatchObject({
    role: "system",
    content: "Project context for this conversation:\nE2E project context marker",
  });

  // Image turn: attach a PNG, send, and verify the vision part upstream + thumbnail.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.getByTestId("chat-file").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText("dot.png")).toBeVisible();
  await page.getByTestId("chat-input").fill("what is this?");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-msg-assistant").nth(1)).toContainText("Answer with bold text", { timeout: 15_000 });

  const imageTurn = seenBodies.at(-1) as { messages: Array<{ role: string; content: unknown }> };
  const visionMessage = imageTurn.messages.find((m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((part) => part.type === "image_url"));
  expect(visionMessage).toBeTruthy();
  await expect(page.locator('img[alt="dot.png"]').first()).toBeVisible();

  expect(consoleErrors).toEqual([]);
});
