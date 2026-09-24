import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { NodeDirectory } from "../nodeDirectory.js";
import { ServedModelsStore } from "../gateway/servedModels.js";
import { TracesStore } from "../stores/tracesStore.js";
import { TraceQueries } from "../stores/traceQueries.js";
import { openDb } from "../stores/db.js";
import { ChatStore } from "./store.js";

const closers: Array<() => void> = [];
afterAll(() => closers.forEach((close) => close()));

async function chatApp(engineMode: "sse" | "json" = "sse") {
  const seen: Array<Record<string, unknown>> = [];
  const engine: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push(JSON.parse(raw || "{}") as Record<string, unknown>);
      if (engineMode === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"lo there"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n');
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "buffered answer" } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
    });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  const port = (engine.address() as AddressInfo).port;

  const tmp = await mkdtemp(join(tmpdir(), "cc-chat-routes-"));
  const db = openDb(join(tmp, "c.db"), 0);
  const dir = new NodeDirectory({ file: join(tmp, "nodes.json") });
  await dir.upsert({ id: "dgx1", name: "dgx-1", kind: "spark", role: "head", lanIp: "127.0.0.1", sshUser: "u" });
  const served = new ServedModelsStore({ filePath: join(tmp, "sm.json") });
  served.upsert({ alias: "glm", targets: [{ nodeId: "dgx1", port }] });
  const chatStore = new ChatStore({ db });
  const traces = new TracesStore({ db });
  const app = buildApp({
    nodeDirectory: dir,
    servedModelsStore: served,
    chatStore,
    tracesStore: traces,
    traceQueries: new TraceQueries(db),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  closers.push(() => {
    void app.close();
    engine.close();
  });
  return { base, chatStore, seen };
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("chat REST surface", () => {
  it("manages folders and conversations", async () => {
    const { base } = await chatApp();
    const folder = (await json(
      await fetch(`${base}/api/chat/folders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ops", description: "Ops runbook lives in /srv/ops." }),
      }),
    )) as { id: string; description: string };
    expect(folder.description).toBe("Ops runbook lives in /srv/ops.");

    expect(
      (await fetch(`${base}/api/chat/folders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "  " }),
      })).status,
    ).toBe(400);

    const conv = (await json(
      await fetch(`${base}/api/chat/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm", folderId: folder.id }),
      }),
    )) as { id: string; folderId: string };
    expect(conv.folderId).toBe(folder.id);
    expect(
      (await fetch(`${base}/api/chat/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm", folderId: "nope" }),
      })).status,
    ).toBe(404);
    expect(
      (await fetch(`${base}/api/chat/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })).status,
    ).toBe(400);

    const listed = (await json(await fetch(`${base}/api/chat/conversations?folderId=${folder.id}`))) as {
      conversations: Array<{ id: string }>;
    };
    expect(listed.conversations.map((c) => c.id)).toEqual([conv.id]);

    const patched = (await json(
      await fetch(`${base}/api/chat/conversations/${conv.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed" }),
      }),
    )) as { title: string };
    expect(patched.title).toBe("Renamed");

    expect((await fetch(`${base}/api/chat/conversations/missing`)).status).toBe(404);
    expect((await fetch(`${base}/api/chat/conversations/${conv.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}/api/chat/folders/${folder.id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("streams a completion, persists the turn, titles the chat, and records a trace", async () => {
    const { base } = await chatApp();
    const conv = (await json(
      await fetch(`${base}/api/chat/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm" }),
      }),
    )) as { id: string };

    const res = await fetch(`${base}/api/chat/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Hello engine, tell me a story about disks" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('data: {"choices":[{"delta":{"content":"Hel"}}]}');
    expect(text).toContain("data: [DONE]");
    const metaMatch = text.match(/event: cc-meta\ndata: (.+)\n\n/);
    expect(metaMatch).not.toBeNull();
    const meta = JSON.parse(metaMatch![1]!) as {
      assistantMessageId: string;
      status: number;
      usage: { promptTokens: number; completionTokens: number };
    };
    expect(meta.status).toBe(200);
    expect(meta.usage).toEqual({ promptTokens: 7, completionTokens: 2, totalTokens: 9 });

    // Persisted turn + auto title.
    const detail = (await json(await fetch(`${base}/api/chat/conversations/${conv.id}`))) as {
      conversation: { title: string };
      messages: Array<{ role: string; content: string; usage: unknown; ttftMs: number | null }>;
    };
    expect(detail.conversation.title).toBe("Hello engine, tell me a story about disks");
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.messages[1]!.content).toBe("Hello there");
    expect(detail.messages[1]!.usage).toEqual({ promptTokens: 7, completionTokens: 2, totalTokens: 9 });
    expect(detail.messages[1]!.ttftMs).not.toBeNull();
    expect(detail.messages[1]!.content.length).toBeGreaterThan(0);

    // Gateway telemetry applies: the chat shows up as a client in traces.
    const traces = (await json(await fetch(`${base}/api/analysis/traces?limit=5`))) as {
      traces: Array<{ client: string | null; alias: string; status: number }>;
    };
    expect(traces.traces[0]).toMatchObject({ client: "dashboard-chat", alias: "glm", status: 200 });
  });

  it("injects folder context and image parts upstream, and serves attachment bytes back", async () => {
    const { base, seen } = await chatApp();
    const folder = (await json(
      await fetch(`${base}/api/chat/folders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Vision", description: "Describe screenshots precisely." }),
      }),
    )) as { id: string };
    const conv = (await json(
      await fetch(`${base}/api/chat/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm", folderId: folder.id }),
      }),
    )) as { id: string };

    const png = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]);
    const res = await fetch(`${base}/api/chat/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "what is this?",
        attachments: [{ name: "shot.png", mime: "image/png", dataBase64: png.toString("base64") }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    // Upstream payload: system context + the user turn as vision parts.
    const upstream = seen.at(-1)! as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(upstream.model).toBe("glm");
    expect(upstream.stream).toBe(true);
    expect(upstream.messages[0]).toEqual({
      role: "system",
      content: "Project context for this conversation:\nDescribe screenshots precisely.",
    });
    expect(upstream.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
      ],
    });

    // The stored attachment is retrievable for rendering.
    const detail = (await json(await fetch(`${base}/api/chat/conversations/${conv.id}`))) as {
      messages: Array<{ role: string; attachments?: Array<{ id: string; mime: string; bytes: number }> }>;
    };
    const attachment = detail.messages[0]!.attachments![0]!;
    expect(attachment).toMatchObject({ mime: "image/png", bytes: png.length });
    const bytes = await fetch(`${base}/api/chat/attachments/${attachment.id}`);
    expect(bytes.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await bytes.arrayBuffer()).equals(png)).toBe(true);

    // Second turn carries the vision history (images replayed from storage).
    await (await fetch(`${base}/api/chat/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "and now?" }),
    })).text();
    const replay = seen.at(-1)! as { messages: Array<{ role: string; content: unknown }> };
    expect(replay.messages[1]).toMatchObject({ role: "user" });
    expect(Array.isArray((replay.messages[1] as { content: unknown[] }).content)).toBe(true);
  });

  it("rejects non-image and oversized attachments and unknown conversations", async () => {
    const { base } = await chatApp();
    const conv = (await json(
      await fetch(`${base}/api/chat/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm" }),
      }),
    )) as { id: string };

    expect(
      (await fetch(`${base}/api/chat/conversations/${conv.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "x", attachments: [{ name: "a.txt", mime: "text/plain", dataBase64: "aGk=" }] }),
      })).status,
    ).toBe(400);

    expect(
      (await fetch(`${base}/api/chat/conversations/${conv.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "big",
          attachments: [{ name: "big.png", mime: "image/png", dataBase64: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") }],
        }),
      })).status,
    ).toBe(413);

    expect(
      (await fetch(`${base}/api/chat/conversations/${conv.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })).status,
    ).toBe(400);

    expect(
      (await fetch(`${base}/api/chat/conversations/missing/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hi" }),
      })).status,
    ).toBe(404);
  });

  it("returns a buffered JSON turn when streaming is disabled", async () => {
    const { base, seen } = await chatApp("json");
    const conv = (await json(
      await fetch(`${base}/api/chat/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm" }),
      }),
    )) as { id: string };
    const res = await fetch(`${base}/api/chat/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "no stream please", stream: false }),
    });
    expect(res.status).toBe(200);
    const payload = (await json(res)) as { assistantMessage: { content: string; usage: unknown } };
    expect(payload.assistantMessage.content).toBe("buffered answer");
    expect(payload.assistantMessage.usage).toEqual({ promptTokens: 4, completionTokens: 2 });
    expect((seen.at(-1) as { stream: boolean }).stream).toBe(false);
  });
});
