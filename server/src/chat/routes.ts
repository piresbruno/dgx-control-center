import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { ServedModelConfig, ServedModelTarget } from "../gateway/servedModels.js";
import type { GatewayTargetState } from "../gateway/gateway.js";
import { handleGatewayRequest } from "../gateway/gateway.js";
import { RequestRecorder } from "../gateway/recorder.js";
import type { TracesStore } from "../stores/tracesStore.js";
import { ChatStore, MAX_ATTACHMENT_BYTES, deriveTitle, type ChatMessage } from "./store.js";
import { SseAccumulator, parseCompletionBody } from "./sse.js";
import { PROXY_BODY_LIMIT_BYTES } from "../proxyBodyLimit.js";

/**
 * Chat surface (M8): folder/conversation CRUD plus the completions proxy.
 * The proxy reuses the gateway router (served-models, failover, on-demand
 * spin-up) with a synthetic client identity ("dashboard-chat") so every chat
 * request lands in traces like any other gateway traffic. Responses stream to
 * the browser as the engine emits them; the assistant message is persisted
 * with telemetry when the stream ends.
 */

export interface ChatImagePart {
  mime: string;
  base64: string;
}

export interface ComposedMessage {
  role: string;
  content: string;
  images?: ChatImagePart[];
}

/** Folder description → leading system message (project context). */
export function toUpstreamMessages(
  folderDescription: string | null,
  messages: ComposedMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const description = folderDescription?.trim() ?? "";
  if (description.length > 0) {
    out.push({
      role: "system",
      content: `Project context for this conversation:\n${description}`,
    });
  }
  for (const message of messages) {
    if (message.role === "assistant" && message.content.trim().length === 0) continue; // failed/empty turn
    const images = message.images ?? [];
    if (images.length === 0) {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    out.push({
      role: message.role,
      content: [
        { type: "text", text: message.content },
        ...images.map((image) => ({
          type: "image_url",
          image_url: { url: `data:${image.mime};base64,${image.base64}` },
        })),
      ],
    });
  }
  return out;
}

export interface ChatRouteDeps {
  store: ChatStore;
  servedModels: { list(): ServedModelConfig[] };
  targetState: (t: ServedModelTarget) => GatewayTargetState | null;
  rrCounters: Map<string, number>;
  upstreamAuth?: string | null;
  ensureOnDemand?: (alias: string) => Promise<boolean> | boolean;
  traces?: TracesStore | null;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

const CLIENT_NAME = "dashboard-chat";

export function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): void {
  const { store } = deps;
  const now = deps.now ?? Date.now;

  // ── folders ────────────────────────────────────────────────────────────
  app.get("/api/chat/folders", async () => ({ folders: store.listFolders() }));

  app.post("/api/chat/folders", async (request, reply) => {
    const body = request.body as { name?: string; description?: string } | null;
    const name = body?.name?.trim() ?? "";
    if (name.length === 0) return reply.code(400).send({ error: "name is required" });
    return reply.code(201).send(store.createFolder({ name, description: body?.description ?? "" }));
  });

  app.patch("/api/chat/folders/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; description?: string } | null;
    const folder = store.updateFolder(id, {
      ...(body?.name !== undefined ? { name: body.name } : {}),
      ...(body?.description !== undefined ? { description: body.description } : {}),
    });
    if (!folder) return reply.code(404).send({ error: "unknown folder" });
    return folder;
  });

  app.delete("/api/chat/folders/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.deleteFolder(id)) return reply.code(404).send({ error: "unknown folder" });
    return { removed: true };
  });

  // ── conversations ──────────────────────────────────────────────────────
  app.get("/api/chat/conversations", async (request) => {
    const query = request.query as { folderId?: string } | null;
    const folderId = query?.folderId === undefined ? undefined : query.folderId === "none" ? null : query.folderId;
    return { conversations: store.listConversations(folderId === undefined ? {} : { folderId }) };
  });

  app.post("/api/chat/conversations", async (request, reply) => {
    const body = request.body as { model?: string; title?: string; folderId?: string } | null;
    const model = body?.model?.trim() ?? "";
    if (model.length === 0) return reply.code(400).send({ error: "model (served alias) is required" });
    if (body?.folderId !== undefined) {
      if (!store.getFolder(body.folderId)) return reply.code(404).send({ error: "unknown folder" });
    }
    return reply.code(201).send(
      store.createConversation({
        model,
        ...(body?.title !== undefined ? { title: body.title } : {}),
        ...(body?.folderId !== undefined ? { folderId: body.folderId } : {}),
      }),
    );
  });

  app.get("/api/chat/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = store.getConversation(id);
    if (!conversation) return reply.code(404).send({ error: "unknown conversation" });
    const folder = conversation.folderId ? store.getFolder(conversation.folderId) : null;
    return { conversation, folder, messages: store.listMessages(conversation.id) };
  });

  app.patch("/api/chat/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { title?: string; folderId?: string | null; model?: string } | null;
    if (body?.folderId != null && !store.getFolder(body.folderId)) {
      return reply.code(404).send({ error: "unknown folder" });
    }
    const conversation = store.updateConversation(id, {
      ...(body?.title !== undefined ? { title: body.title } : {}),
      ...(body?.folderId !== undefined ? { folderId: body.folderId } : {}),
      ...(body?.model !== undefined ? { model: body.model } : {}),
    });
    if (!conversation) return reply.code(404).send({ error: "unknown conversation" });
    return conversation;
  });

  app.delete("/api/chat/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.deleteConversation(id)) return reply.code(404).send({ error: "unknown conversation" });
    return { removed: true };
  });

  // ── models (picker data for the chat UI) ───────────────────────────────
  app.get("/api/chat/models", async () => ({
    models: deps.servedModels.list().map((m) => ({
      alias: m.alias,
      vision: m.vision === true,
      targets: m.targets,
      onDemand: Boolean(m.onDemand),
    })),
  }));

  // ── attachments ────────────────────────────────────────────────────────
  app.get("/api/chat/attachments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const found = store.getAttachment(id);
    if (!found) return reply.code(404).send({ error: "unknown attachment" });
    return reply
      .code(200)
      .headers({
        "content-type": found.meta.mime,
        "content-length": String(found.meta.bytes),
        "cache-control": "private, max-age=3600",
      })
      .send(found.data);
  });

  // ── messages + completions proxy ───────────────────────────────────────
  // PROXY_BODY_LIMIT_BYTES keeps base64-encoded 8 MiB images (~10.7 MB JSON
  // each) under Fastify's route limit so the handler enforces the
  // per-attachment cap itself instead of the socket dying mid-upload.
  app.post(
    "/api/chat/conversations/:id/messages",
    { bodyLimit: PROXY_BODY_LIMIT_BYTES },
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      content?: string;
      attachments?: Array<{ name?: string; mime?: string; dataBase64?: string }>;
      stream?: boolean;
      maxTokens?: number;
    } | null;

    const conversation = store.getConversation(id);
    if (!conversation) return reply.code(404).send({ error: "unknown conversation" });

    const content = body?.content ?? "";
    const incoming = body?.attachments ?? [];
    if (content.trim().length === 0 && incoming.length === 0) {
      return reply.code(400).send({ error: "content or attachments required" });
    }
    for (const attachment of incoming) {
      if (!(attachment.mime ?? "").startsWith("image/")) {
        return reply.code(400).send({ error: "only image attachments are supported" });
      }
    }
    // Vision routing: images only go to aliases explicitly marked vision-capable.
    if (incoming.length > 0) {
      const aliases = deps.servedModels.list();
      const target = aliases.find((m) => m.alias === conversation.model);
      if (target?.vision !== true) {
        return reply.code(400).send({
          error: `model '${conversation.model}' is not marked vision-capable`,
          visionAliases: aliases.filter((m) => m.vision === true).map((m) => m.alias),
        });
      }
    }

    const userMessage = store.appendMessage({ conversationId: conversation.id, role: "user", content });
    if (!userMessage) return reply.code(404).send({ error: "unknown conversation" });
    const stored: Array<{ name: string; mime: string; data: Buffer }> = [];
    for (const attachment of incoming) {
      const data = Buffer.from(attachment.dataBase64 ?? "", "base64");
      const added = store.addAttachment({
        messageId: userMessage.id,
        name: attachment.name ?? "image",
        mime: attachment.mime ?? "application/octet-stream",
        data,
      });
      if (added && "error" in added) {
        return reply.code(413).send({ error: `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
      }
      if (added) stored.push({ name: added.name, mime: added.mime, data });
    }
    // Auto-title the conversation from its first user turn.
    if (conversation.title === "New chat" && content.trim().length > 0) {
      store.updateConversation(conversation.id, { title: deriveTitle(content) });
    }

    // Compose: folder project context + full history (attachments as data URLs).
    const folder = conversation.folderId ? store.getFolder(conversation.folderId) : null;
    const history = store.listMessages(conversation.id);
    const composed: ComposedMessage[] = history.map((message: ChatMessage) => ({
      role: message.role,
      content: message.content,
      ...(message.attachments && message.attachments.length > 0
        ? {
            images: message.attachments
              .map((meta) => {
                const found = store.getAttachment(meta.id);
                return found ? { mime: found.meta.mime, base64: found.data.toString("base64") } : null;
              })
              .filter((image): image is ChatImagePart => image !== null),
          }
        : {}),
    }));
    const upstreamMessages = toUpstreamMessages(folder?.description ?? null, composed);
    const stream = body?.stream !== false;

    const recorder = new RequestRecorder({ now });
    const accumulator = new SseAccumulator();
    let streaming = false;
    let forwarded = false;

    const res = await handleGatewayRequest(
      {
        servedModels: deps.servedModels.list(),
        clients: null, // dashboard-session call: identity is recorded as the chat client
        targetState: deps.targetState,
        rrCounters: deps.rrCounters,
        upstreamAuth: deps.upstreamAuth ?? null,
        now,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.ensureOnDemand ? { ensureOnDemand: deps.ensureOnDemand } : {}),
        warmupTimeoutMs: 120_000,
        onResponseChunk: (chunk, atMs, status) => {
          recorder.chunk(chunk, atMs);
          accumulator.push(chunk);
          if (stream && status < 500) {
            if (!streaming) {
              streaming = true;
              forwarded = true;
              reply.hijack();
              reply.raw.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
                "x-accel-buffering": "no",
              });
            }
            reply.raw.write(chunk);
          }
        },
      },
      {
        method: "POST",
        path: "/v1/chat/completions",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: conversation.model,
          messages: upstreamMessages,
          stream,
          // Token accounting for the persisted turn (vLLM only reports usage on
          // streams when asked) and a bounded default turn length.
          ...(stream ? { stream_options: { include_usage: true } } : {}),
          max_tokens: body?.maxTokens ?? 1024,
        }),
      },
    );

    const trace = recorder.finish({
      ts: now(),
      client: CLIENT_NAME,
      alias: conversation.model,
      model: null,
      nodeId: res.servedBy?.nodeId ?? null,
      port: res.servedBy?.port ?? null,
      status: res.status,
      contentType: res.headers["content-type"] ?? null,
      attempts: res.attempts,
      error: res.status >= 400 ? (res.body ?? "").slice(0, 200) : null,
    });
    deps.traces?.insert(trace);
    if (deps.traces) void deps.traces.prune();

    const fallback = stream ? null : parseCompletionBody(res.body);
    const assistantContent = accumulator.content || fallback?.content || "";
    const usage = accumulator.usage ?? fallback?.usage ?? null;
    const failed = res.status >= 400 || (assistantContent.length === 0 && stream);
    const assistantMessage = store.appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: assistantContent,
      model: conversation.model,
      error: failed
        ? (res.status >= 400 ? errorText(res.body, res.status) : "empty response from engine")
        : null,
      ttftMs: trace.ttftMs,
      durationMs: trace.durationMs,
      usage,
    });

    if (forwarded) {
      reply.raw.write(
        `event: cc-meta\ndata: ${JSON.stringify({
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage?.id ?? null,
          status: res.status,
          ttftMs: trace.ttftMs,
          durationMs: trace.durationMs,
          usage,
          attachments: stored.map((s) => ({ name: s.name, mime: s.mime, bytes: s.data.length })),
          error: failed ? assistantMessage?.error ?? null : null,
        })}\n\n`,
      );
      reply.raw.end();
      return reply;
    }
    if (res.status >= 400) {
      return reply.code(res.status).send({ error: assistantMessage?.error ?? "upstream error", attempts: res.attempts });
    }
    return { userMessage, assistantMessage, trace: { ttftMs: trace.ttftMs, durationMs: trace.durationMs, usage } };
  });
}

function errorText(body: string | null, status: number): string {
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } | string };
      if (typeof parsed.error === "string") return parsed.error;
      if (parsed.error?.message) return parsed.error.message;
    } catch {
      return body.slice(0, 200);
    }
  }
  return `upstream error ${status}`;
}
