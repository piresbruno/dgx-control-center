/** REST + streaming client for the M8 chat surface. */

export interface ChatFolder {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  conversationCount?: number;
}

export interface ChatConversation {
  id: string;
  folderId: string | null;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
}

export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens?: number | null;
}

export interface ChatAttachmentMeta {
  id: string;
  messageId: string;
  name: string;
  mime: string;
  bytes: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "system" | "user" | "assistant";
  content: string;
  model: string | null;
  error: string | null;
  ttftMs: number | null;
  durationMs: number | null;
  usage: ChatUsage | null;
  createdAt: number;
  attachments?: ChatAttachmentMeta[];
}

export interface ChatModelOption {
  alias: string;
  vision: boolean;
  onDemand: boolean;
}

export interface ChatMeta {
  userMessageId: string;
  assistantMessageId: string | null;
  status: number;
  ttftMs: number | null;
  durationMs: number | null;
  usage: ChatUsage | null;
  error: string | null;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; visionAliases?: string[] };
    const hint = body.visionAliases?.length ? ` (vision-capable: ${body.visionAliases.join(", ")})` : "";
    throw new Error((body.error ?? `${res.status} ${res.statusText}`) + hint);
  }
  return (await res.json()) as T;
}

export interface AttachmentUpload {
  name: string;
  mime: string;
  dataBase64: string;
}

export const chatApi = {
  folders: () => json<{ folders: ChatFolder[] }>("/api/chat/folders").then((d) => d.folders),
  createFolder: (input: { name: string; description?: string }) =>
    json<ChatFolder>("/api/chat/folders", { method: "POST", body: JSON.stringify(input) }),
  updateFolder: (id: string, patch: { name?: string; description?: string }) =>
    json<ChatFolder>(`/api/chat/folders/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteFolder: (id: string) => json<{ removed: boolean }>(`/api/chat/folders/${id}`, { method: "DELETE" }),

  models: () => json<{ models: ChatModelOption[] }>("/api/chat/models").then((d) => d.models),

  conversations: () => json<{ conversations: ChatConversation[] }>("/api/chat/conversations").then((d) => d.conversations),
  createConversation: (input: { model: string; folderId?: string | null; title?: string }) =>
    json<ChatConversation>("/api/chat/conversations", { method: "POST", body: JSON.stringify(input) }),
  updateConversation: (id: string, patch: { title?: string; model?: string; folderId?: string | null }) =>
    json<ChatConversation>(`/api/chat/conversations/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteConversation: (id: string) =>
    json<{ removed: boolean }>(`/api/chat/conversations/${id}`, { method: "DELETE" }),
  detail: (id: string) =>
    json<{ conversation: ChatConversation; folder: ChatFolder | null; messages: ChatMessage[] }>(
      `/api/chat/conversations/${id}`,
    ),
};

/**
 * Send a turn and stream the assistant reply. Returns the terminal meta frame
 * (message ids, usage, timing) once the stream closes.
 */
export async function streamTurn(
  conversationId: string,
  input: { content: string; attachments?: AttachmentUpload[] },
  handlers: { onDelta: (text: string) => void },
): Promise<ChatMeta | null> {
  const res = await fetch(`/api/chat/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: input.content, attachments: input.attachments ?? [], stream: true }),
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; visionAliases?: string[] };
    const hint = body.visionAliases?.length ? ` (vision-capable: ${body.visionAliases.join(", ")})` : "";
    throw new Error((body.error ?? `${res.status} ${res.statusText}`) + hint);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let meta: ChatMeta | null = null;
  let event = "message";

  const handleFrame = (frame: string) => {
    for (const line of frame.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("event:")) {
        event = trimmed.slice(6).trim();
        continue;
      }
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (event === "cc-meta") {
        try {
          meta = JSON.parse(payload) as ChatMeta;
        } catch {
          /* ignore */
        }
        continue;
      }
      if (payload === "[DONE]" || payload.length === 0) continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string | null } }>;
        };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) handlers.onDelta(delta);
      } catch {
        /* keep-alive or partial frame */
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      handleFrame(frame);
      index = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim().length > 0) handleFrame(buffer);
  return meta;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
