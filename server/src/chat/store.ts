import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Chat store (M8): conversations, folders (project context), messages and
 * image attachments in SQLite (migration 4). Folders carry a description that
 * the completions proxy injects as a system message; attachments live in the
 * DB as BLOBs under a hard size cap so chat history is self-contained.
 */

export const CHAT_ROLES = ["system", "user", "assistant"] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

/** Per-attachment hard cap (images travel base64-encoded to the upstream). */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export interface ChatFolder {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  /** Present in list results. */
  conversationCount?: number;
}

export interface ChatConversation {
  id: string;
  folderId: string | null;
  title: string;
  /** Gateway alias the conversation talks to. */
  model: string;
  createdAt: number;
  updatedAt: number;
  /** Present in list results. */
  messageCount?: number;
}

export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens?: number | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  model: string | null;
  error: string | null;
  ttftMs: number | null;
  durationMs: number | null;
  usage: ChatUsage | null;
  createdAt: number;
  /** Present in list results (metadata only; bytes fetched separately). */
  attachments?: ChatAttachmentMeta[];
}

export interface ChatAttachmentMeta {
  id: string;
  messageId: string;
  name: string;
  mime: string;
  bytes: number;
}

export type AttachmentResult = ChatAttachmentMeta | { error: "too-large" } | null;

export interface ChatStoreDeps {
  db: Database.Database;
  now?: () => number;
}

/** First line of the first user message, trimmed to a sensible title. */
export function deriveTitle(content: string): string {
  const line = content.replace(/\s+/g, " ").trim();
  if (line.length === 0) return "New chat";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

export class ChatStore {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(deps: ChatStoreDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
  }

  // ── folders ────────────────────────────────────────────────────────────

  createFolder(input: { name: string; description?: string }): ChatFolder {
    const ts = this.now();
    const row: ChatFolder = {
      id: `fld-${randomUUID()}`,
      name: input.name,
      description: input.description ?? "",
      createdAt: ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        "INSERT INTO chat_folders (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(row.id, row.name, row.description, row.createdAt, row.updatedAt);
    return row;
  }

  listFolders(): ChatFolder[] {
    const rows = this.db
      .prepare(
        `SELECT f.*, (
           SELECT COUNT(*) FROM chat_conversations c WHERE c.folder_id = f.id
         ) AS conversation_count
         FROM chat_folders f ORDER BY f.name COLLATE NOCASE ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      description: r.description as string,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      conversationCount: r.conversation_count as number,
    }));
  }

  getFolder(id: string): ChatFolder | null {
    const r = this.db.prepare("SELECT * FROM chat_folders WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      name: r.name as string,
      description: r.description as string,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    };
  }

  updateFolder(
    id: string,
    patch: { name?: string; description?: string },
  ): ChatFolder | null {
    if (!this.getFolder(id)) return null;
    const next: Partial<Record<string, string>> = {};
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.description !== undefined) next.description = patch.description;
    const keys = Object.keys(next);
    if (keys.length > 0) {
      this.db
        .prepare(
          `UPDATE chat_folders SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        )
        .run(...keys.map((k) => next[k] as string), this.now(), id);
    }
    return this.getFolder(id);
  }

  /** Removes the folder; its conversations are kept and detached (folder_id → NULL). */
  deleteFolder(id: string): boolean {
    return this.db.prepare("DELETE FROM chat_folders WHERE id = ?").run(id).changes > 0;
  }

  // ── conversations ──────────────────────────────────────────────────────

  createConversation(input: {
    title?: string;
    folderId?: string | null;
    model: string;
  }): ChatConversation {
    const ts = this.now();
    const row: ChatConversation = {
      id: `conv-${randomUUID()}`,
      folderId: input.folderId ?? null,
      title: input.title ?? "New chat",
      model: input.model,
      createdAt: ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        "INSERT INTO chat_conversations (id, folder_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.folderId, row.title, row.model, row.createdAt, row.updatedAt);
    return row;
  }

  listConversations(filter: { folderId?: string | null } = {}): ChatConversation[] {
    const rows =
      filter.folderId === undefined
        ? (this.db
            .prepare(
              `SELECT c.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
               FROM chat_conversations c ORDER BY c.updated_at DESC`,
            )
            .all() as Array<Record<string, unknown>>)
        : filter.folderId === null
          ? (this.db
              .prepare(
                `SELECT c.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
                 FROM chat_conversations c WHERE c.folder_id IS NULL ORDER BY c.updated_at DESC`,
              )
              .all() as Array<Record<string, unknown>>)
          : (this.db
              .prepare(
                `SELECT c.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
                 FROM chat_conversations c WHERE c.folder_id = ? ORDER BY c.updated_at DESC`,
              )
              .all(filter.folderId) as Array<Record<string, unknown>>);
    return rows.map(rowToConversation);
  }

  getConversation(id: string): ChatConversation | null {
    const r = this.db.prepare("SELECT * FROM chat_conversations WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToConversation(r) : null;
  }

  updateConversation(
    id: string,
    patch: { title?: string; folderId?: string | null; model?: string },
  ): ChatConversation | null {
    if (!this.getConversation(id)) return null;
    const sets: string[] = [];
    const args: Array<string | null | number> = [];
    if (patch.title !== undefined) {
      sets.push("title = ?");
      args.push(patch.title);
    }
    if (patch.folderId !== undefined) {
      sets.push("folder_id = ?");
      args.push(patch.folderId);
    }
    if (patch.model !== undefined) {
      sets.push("model = ?");
      args.push(patch.model);
    }
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      args.push(this.now());
      args.push(id);
      this.db.prepare(`UPDATE chat_conversations SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    }
    return this.getConversation(id);
  }

  /** Deletes the conversation; messages and attachments cascade. */
  deleteConversation(id: string): boolean {
    return this.db.prepare("DELETE FROM chat_conversations WHERE id = ?").run(id).changes > 0;
  }

  // ── messages ───────────────────────────────────────────────────────────

  /** Appends a message and bumps the conversation's updated_at. Null for unknown conversation. */
  appendMessage(input: {
    conversationId: string;
    role: ChatRole;
    content: string;
    model?: string | null;
    error?: string | null;
    ttftMs?: number | null;
    durationMs?: number | null;
    usage?: ChatUsage | null;
  }): ChatMessage | null {
    if (!this.getConversation(input.conversationId)) return null;
    const ts = this.now();
    const row: ChatMessage = {
      id: `msg-${randomUUID()}`,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      model: input.model ?? null,
      error: input.error ?? null,
      ttftMs: input.ttftMs ?? null,
      durationMs: input.durationMs ?? null,
      usage: input.usage ?? null,
      createdAt: ts,
    };
    this.db
      .prepare(
        `INSERT INTO chat_messages
           (id, conversation_id, role, content, model, error, ttft_ms, duration_ms, usage, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.conversationId,
        row.role,
        row.content,
        row.model,
        row.error,
        row.ttftMs,
        row.durationMs,
        row.usage ? JSON.stringify(row.usage) : null,
        row.createdAt,
      );
    this.db
      .prepare("UPDATE chat_conversations SET updated_at = ? WHERE id = ?")
      .run(ts, input.conversationId);
    return { ...row, attachments: [] };
  }

  /** Messages in chronological order; `limit` keeps the last N. */
  listMessages(conversationId: string, opts: { limit?: number } = {}): ChatMessage[] {
    const limit = opts.limit ?? 500;
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(conversationId, limit) as Array<Record<string, unknown>>;
    const messages = rows.map(rowToMessage);
    if (messages.length === 0) return messages;
    const metaStmt = this.db.prepare(
      "SELECT id, message_id, name, mime, bytes FROM chat_attachments WHERE message_id = ? ORDER BY id ASC",
    );
    for (const message of messages) {
      message.attachments = (metaStmt.all(message.id) as Array<Record<string, unknown>>).map(
        rowToAttachmentMeta,
      );
    }
    return messages;
  }

  // ── attachments ────────────────────────────────────────────────────────

  /** Stores image bytes under the size cap. Null for unknown message; {error} when oversized. */
  addAttachment(input: {
    messageId: string;
    name: string;
    mime: string;
    data: Buffer;
  }): AttachmentResult {
    const message = this.db.prepare("SELECT id FROM chat_messages WHERE id = ?").get(input.messageId);
    if (!message) return null;
    if (input.data.length > MAX_ATTACHMENT_BYTES) return { error: "too-large" };
    const meta: ChatAttachmentMeta = {
      id: `att-${randomUUID()}`,
      messageId: input.messageId,
      name: input.name,
      mime: input.mime,
      bytes: input.data.length,
    };
    this.db
      .prepare(
        "INSERT INTO chat_attachments (id, message_id, name, mime, bytes, data) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(meta.id, meta.messageId, meta.name, meta.mime, meta.bytes, input.data);
    return meta;
  }

  listAttachments(messageId: string): ChatAttachmentMeta[] {
    return (
      this.db
        .prepare(
          "SELECT id, message_id, name, mime, bytes FROM chat_attachments WHERE message_id = ? ORDER BY id ASC",
        )
        .all(messageId) as Array<Record<string, unknown>>
    ).map(rowToAttachmentMeta);
  }

  getAttachment(id: string): { meta: ChatAttachmentMeta; data: Buffer } | null {
    const r = this.db.prepare("SELECT * FROM chat_attachments WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return { meta: rowToAttachmentMeta(r), data: r.data as Buffer };
  }
}

function rowToConversation(r: Record<string, unknown>): ChatConversation {
  return {
    id: r.id as string,
    folderId: (r.folder_id as string | null) ?? null,
    title: r.title as string,
    model: r.model as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    ...(r.message_count !== undefined ? { messageCount: r.message_count as number } : {}),
  };
}

function rowToMessage(r: Record<string, unknown>): ChatMessage {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    role: r.role as ChatRole,
    content: r.content as string,
    model: (r.model as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    ttftMs: (r.ttft_ms as number | null) ?? null,
    durationMs: (r.duration_ms as number | null) ?? null,
    usage: r.usage ? (JSON.parse(r.usage as string) as ChatUsage) : null,
    createdAt: r.created_at as number,
  };
}

function rowToAttachmentMeta(r: Record<string, unknown>): ChatAttachmentMeta {
  return {
    id: r.id as string,
    messageId: r.message_id as string,
    name: r.name as string,
    mime: r.mime as string,
    bytes: r.bytes as number,
  };
}
