import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../stores/db.js";
import { ChatStore, MAX_ATTACHMENT_BYTES, deriveTitle } from "./store.js";

async function storeWithClock(start = 1_000) {
  const file = join(await mkdtemp(join(tmpdir(), "cc-chat-")), "c.db");
  const db = openDb(file, 0);
  let t = start;
  const store = new ChatStore({ db, now: () => t });
  return { store, tick: (ms = 1) => (t += ms) };
}

describe("deriveTitle", () => {
  it("collapses whitespace, caps length, and falls back for empty input", () => {
    expect(deriveTitle("  Hello\n\nworld  ")).toBe("Hello world");
    expect(deriveTitle("x".repeat(100))).toBe(`${"x".repeat(57)}…`);
    expect(deriveTitle("   ")).toBe("New chat");
  });
});

describe("ChatStore folders", () => {
  it("creates, lists (with counts), updates and deletes folders", async () => {
    const { store } = await storeWithClock();
    const folder = store.createFolder({ name: "Ops", description: "Infra ops context" });
    expect(folder.description).toBe("Infra ops context");

    store.createConversation({ folderId: folder.id, model: "glm" });
    store.createConversation({ folderId: folder.id, model: "glm" });
    const listed = store.listFolders();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.conversationCount).toBe(2);

    const updated = store.updateFolder(folder.id, { description: "New context" });
    expect(updated?.description).toBe("New context");
    expect(store.updateFolder("missing", { name: "x" })).toBeNull();

    expect(store.deleteFolder(folder.id)).toBe(true);
    expect(store.listFolders()).toHaveLength(0);
    // Conversations survive, detached from the deleted folder.
    expect(store.listConversations().every((c) => c.folderId === null)).toBe(true);
  });
});

describe("ChatStore conversations and messages", () => {
  it("orders conversations by recency and counts messages", async () => {
    const { store, tick } = await storeWithClock();
    const a = store.createConversation({ title: "A", model: "glm" });
    tick(10);
    const b = store.createConversation({ model: "glm" });
    expect(store.getConversation(b.id)?.title).toBe("New chat");
    tick(10);
    store.appendMessage({ conversationId: a.id, role: "user", content: "hi" });

    const list = store.listConversations();
    expect(list.map((c) => c.id)).toEqual([a.id, b.id]); // A bumped by the append
    expect(list[0]!.messageCount).toBe(1);

    expect(store.listConversations({ folderId: null })).toHaveLength(2);
    const folder = store.createFolder({ name: "F" });
    store.updateConversation(b.id, { folderId: folder.id });
    expect(store.listConversations({ folderId: folder.id }).map((c) => c.id)).toEqual([b.id]);
    expect(store.listConversations({ folderId: null }).map((c) => c.id)).toEqual([a.id]);
  });

  it("appends messages chronologically, keeps the last N, and round-trips usage", async () => {
    const { store, tick } = await storeWithClock();
    const conv = store.createConversation({ model: "glm" });
    expect(store.appendMessage({ conversationId: "missing", role: "user", content: "x" })).toBeNull();

    for (let i = 0; i < 5; i++) {
      store.appendMessage({ conversationId: conv.id, role: "user", content: `m${i}` });
      tick(5);
    }
    store.appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: "answer",
      model: "glm",
      ttftMs: 120,
      durationMs: 900,
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    });

    const all = store.listMessages(conv.id);
    expect(all.map((m) => m.content)).toEqual(["m0", "m1", "m2", "m3", "m4", "answer"]);
    const last = all[5]!;
    expect(last.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
    expect(last.ttftMs).toBe(120);
    expect(last.role).toBe("assistant");

    const tail = store.listMessages(conv.id, { limit: 2 });
    expect(tail.map((m) => m.content)).toEqual(["m4", "answer"]);
  });

  it("cascades messages and attachments when a conversation is deleted", async () => {
    const { store } = await storeWithClock();
    const conv = store.createConversation({ model: "glm" });
    const msg = store.appendMessage({
      conversationId: conv.id,
      role: "user",
      content: "look",
    })!;
    expect(store.addAttachment({ messageId: msg.id, name: "p.png", mime: "image/png", data: Buffer.from([1, 2, 3]) })).not.toBeNull();
    expect(store.deleteConversation(conv.id)).toBe(true);
    expect(store.listMessages(conv.id)).toHaveLength(0);
    expect(store.listAttachments(msg.id)).toHaveLength(0);
  });
});

describe("ChatStore attachments", () => {
  it("round-trips bytes and metadata, rejects oversize, ignores unknown messages", async () => {
    const { store } = await storeWithClock();
    const conv = store.createConversation({ model: "glm" });
    const msg = store.appendMessage({ conversationId: conv.id, role: "user", content: "img" })!;

    const data = Buffer.from([0, 255, 7, 42, 128]);
    const meta = store.addAttachment({ messageId: msg.id, name: "shot.png", mime: "image/png", data });
    expect(meta).toMatchObject({ name: "shot.png", mime: "image/png", bytes: 5 });
    const fetched = store.getAttachment((meta as { id: string }).id)!;
    expect(fetched.data.equals(data)).toBe(true);

    // Attachment metadata travels with the message list.
    const [listed] = store.listMessages(conv.id);
    expect(listed!.attachments).toHaveLength(1);
    expect(listed!.attachments![0]!.name).toBe("shot.png");

    const oversize = store.addAttachment({
      messageId: msg.id,
      name: "big.png",
      mime: "image/png",
      data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
    });
    expect(oversize).toEqual({ error: "too-large" });
    expect(store.listAttachments(msg.id)).toHaveLength(1);

    expect(store.addAttachment({ messageId: "missing", name: "x", mime: "image/png", data: Buffer.from([1]) })).toBeNull();
    expect(store.getAttachment("missing")).toBeNull();
  });
});
