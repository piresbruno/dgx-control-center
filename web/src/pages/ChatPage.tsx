import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatApi,
  streamTurn,
  humanBytes,
  type AttachmentUpload,
  type ChatConversation,
  type ChatFolder,
  type ChatMessage,
  type ChatMeta,
  type ChatModelOption,
} from "../api/chat.js";
import { Markdown } from "../lib/markdown.js";

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

interface PendingAttachment extends AttachmentUpload {
  bytes: number;
  /** data: URL for the optimistic bubble (the server id only exists after the turn). */
  previewUrl: string;
}

/** M8: chat with any served model — folders carry project context. */
export function ChatPage() {
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    conversation: ChatConversation;
    folder: ChatFolder | null;
    messages: ChatMessage[];
  } | null>(null);
  const [streaming, setStreaming] = useState<{ content: string; meta: ChatMeta | null } | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [folderDraft, setFolderDraft] = useState<{ name: string; description: string } | null>(null);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [editingFolderDraft, setEditingFolderDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refreshLists = useCallback(async () => {
    try {
      const [folderList, conversationList, modelList] = await Promise.all([
        chatApi.folders(),
        chatApi.conversations(),
        chatApi.models(),
      ]);
      setFolders(folderList);
      setConversations(conversationList);
      setModels(modelList);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const openConversation = useCallback(async (id: string) => {
    setActiveId(id);
    setStreaming(null);
    try {
      setDetail(await chatApi.detail(id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refreshLists();
  }, [refreshLists]);

  useEffect(() => {
    if (activeId !== null) return;
    const first = conversations[0];
    if (first) void openConversation(first.id);
  }, [conversations, activeId, openConversation]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [detail, streaming]);

  const conversation = detail?.conversation ?? null;
  const visionAlias = models.find((m) => m.alias === conversation?.model)?.vision === true;

  const newChat = async () => {
    const model = conversation?.model ?? models[0]?.alias;
    if (!model) {
      setError("no served models yet — expose one on the Router page first");
      return;
    }
    try {
      const created = await chatApi.createConversation({ model, folderId: detail?.conversation.folderId ?? null });
      await refreshLists();
      await openConversation(created.id);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files) return;
    const next: PendingAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) {
        setError(`${file.name}: only images can be attached`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`${file.name}: larger than ${humanBytes(MAX_ATTACHMENT_BYTES)}`);
        continue;
      }
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      next.push({ name: file.name, mime: file.type, dataBase64: base64, bytes: file.size, previewUrl: `data:${file.type};base64,${base64}` });
    }
    setPending((current) => [...current, ...next]);
  };

  const send = async () => {
    if (!conversation) return;
    const content = draft.trim();
    if (content.length === 0 && pending.length === 0) return;
    if (pending.length > 0 && !visionAlias) {
      setError(`model '${conversation.model}' is not vision-capable — switch to a vision alias or remove the image`);
      return;
    }
    const attachments = pending;
    setDraft("");
    setPending([]);
    setError(null);
    // Optimistic user turn while the assistant streams in.
    setDetail((current) =>
      current
        ? {
            ...current,
            messages: [
              ...current.messages,
              {
                id: `pending-${Date.now()}`,
                conversationId: current.conversation.id,
                role: "user",
                content,
                model: null,
                error: null,
                ttftMs: null,
                durationMs: null,
                usage: null,
                createdAt: Date.now(),
                attachments: attachments.map((a, index) => ({
                  id: `pending-att-${index}`,
                  messageId: `pending-${Date.now()}`,
                  name: a.name,
                  mime: a.mime,
                  bytes: a.bytes,
                  previewUrl: a.previewUrl,
                })),
              },
            ],
          }
        : current,
    );
    setStreaming({ content: "", meta: null });
    try {
      const meta = await streamTurn(conversation.id, { content, attachments }, {
        onDelta: (text) => setStreaming((s) => (s ? { content: s.content + text, meta: s.meta } : s)),
      });
      setStreaming((s) => (s ? { ...s, meta } : s));
      await openConversation(conversation.id); // persisted turn with telemetry
      await refreshLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStreaming(null);
      await openConversation(conversation.id);
    }
  };

  const switchModel = async (alias: string) => {
    if (!conversation) return;
    try {
      await chatApi.updateConversation(conversation.id, { model: alias });
      setDetail((current) => (current ? { ...current, conversation: { ...current.conversation, model: alias } } : current));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const assignFolder = async (folderId: string) => {
    if (!conversation) return;
    try {
      await chatApi.updateConversation(conversation.id, { folderId: folderId === "" ? null : folderId });
      await openConversation(conversation.id);
      await refreshLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const createFolder = async () => {
    if (!folderDraft?.name.trim()) return;
    try {
      await chatApi.createFolder({ name: folderDraft.name.trim(), description: folderDraft.description });
      setFolderDraft(null);
      await refreshLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const saveFolderDescription = async (folder: ChatFolder) => {
    try {
      await chatApi.updateFolder(folder.id, { description: editingFolderDraft });
      setEditingFolder(null);
      await refreshLists();
      if (detail?.folder?.id === folder.id) await openConversation(folder.id === detail.folder.id ? detail.conversation.id : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeConversation = async (id: string) => {
    if (!confirm("Delete this conversation and its messages?")) return;
    try {
      await chatApi.deleteConversation(id);
      setActiveId(null);
      setDetail(null);
      await refreshLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const grouped = (folderId: string | null) => conversations.filter((c) => c.folderId === folderId);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px minmax(0, 1fr)", gap: 12, alignItems: "start" }}>
      {/* ── left rail: folders + conversations ── */}
      <aside className="panel" style={{ display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 150px)" }}>
        <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Chats</span>
          <span style={{ display: "flex", gap: 6 }}>
            <button className="btn" data-testid="chat-new-folder" onClick={() => setFolderDraft({ name: "", description: "" })}>
              + Folder
            </button>
            <button className="btn primary" data-testid="chat-new" onClick={() => void newChat()}>
              New chat
            </button>
          </span>
        </div>
        <div className="panel-body" style={{ overflowY: "auto" }}>
          {folderDraft && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
              <input
                className="input"
                placeholder="Folder name (e.g. Home infranet)"
                value={folderDraft.name}
                onChange={(e) => setFolderDraft({ ...folderDraft, name: e.target.value })}
              />
              <textarea
                className="input"
                rows={3}
                placeholder="Project context injected into every conversation in this folder"
                value={folderDraft.description}
                onChange={(e) => setFolderDraft({ ...folderDraft, description: e.target.value })}
              />
              <span style={{ display: "flex", gap: 6 }}>
                <button className="btn primary" onClick={() => void createFolder()}>
                  Create
                </button>
                <button className="btn" onClick={() => setFolderDraft(null)}>
                  Cancel
                </button>
              </span>
            </div>
          )}

          {folders.map((folder) => (
            <div key={folder.id} style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <strong style={{ flex: 1 }}>
                  {folder.name} <span className="hint">({folder.conversationCount ?? 0})</span>
                </strong>
                <button
                  className="btn"
                  title="Edit project context"
                  onClick={() => {
                    setEditingFolder(folder.id);
                    setEditingFolderDraft(folder.description);
                  }}
                >
                  ✎
                </button>
                <button
                  className="btn"
                  title="Delete folder (conversations are kept)"
                  onClick={async () => {
                    if (!confirm(`Delete folder "${folder.name}"? Its conversations are kept.`)) return;
                    await chatApi.deleteFolder(folder.id);
                    await refreshLists();
                  }}
                >
                  ✕
                </button>
              </div>
              {editingFolder === folder.id && (
                <span style={{ display: "flex", flexDirection: "column", gap: 6, margin: "6px 0" }}>
                  <textarea
                    className="input"
                    rows={3}
                    value={editingFolderDraft}
                    data-testid={`folder-context-${folder.id}`}
                    onChange={(e) => setEditingFolderDraft(e.target.value)}
                  />
                  <span style={{ display: "flex", gap: 6 }}>
                    <button className="btn primary" onClick={() => void saveFolderDescription(folder)}>
                      Save context
                    </button>
                    <button className="btn" onClick={() => setEditingFolder(null)}>
                      Cancel
                    </button>
                  </span>
                </span>
              )}
              <div style={{ marginLeft: 8 }}>
                {grouped(folder.id).map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    active={c.id === activeId}
                    onOpen={() => void openConversation(c.id)}
                    onDelete={() => void removeConversation(c.id)}
                  />
                ))}
                {grouped(folder.id).length === 0 && <div className="hint">No chats in this folder yet.</div>}
              </div>
            </div>
          ))}

          <div style={{ marginTop: 10 }}>
            <strong>Ungrouped</strong>
            {grouped(null).map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                active={c.id === activeId}
                onOpen={() => void openConversation(c.id)}
                onDelete={() => void removeConversation(c.id)}
              />
            ))}
            {grouped(null).length === 0 && <div className="hint">No chats yet.</div>}
          </div>
        </div>
      </aside>

      {/* ── main pane ── */}
      <section className="panel" style={{ display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 150px)" }}>
        {error && (
          <div className="panel-body" style={{ paddingTop: 0 }}>
            <span className="pill crit" data-testid="chat-error">
              {error}
            </span>
          </div>
        )}
        {detail === null ? (
          <div className="panel-body">
            <div className="empty">Pick a chat or start a new one.</div>
          </div>
        ) : (
          <>
            <div className="panel-head" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <strong style={{ flex: 1, minWidth: 120 }}>{detail.conversation.title}</strong>
              <label className="hint">
                model{" "}
                <select
                  className="input"
                  data-testid="chat-model"
                  value={detail.conversation.model}
                  onChange={(e) => void switchModel(e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m.alias} value={m.alias}>
                      {m.alias}
                      {m.vision ? " · vision" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="hint">
                folder{" "}
                <select
                  className="input"
                  value={detail.conversation.folderId ?? ""}
                  onChange={(e) => void assignFolder(e.target.value)}
                >
                  <option value="">— none —</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn" onClick={() => void removeConversation(detail.conversation.id)}>
                Delete
              </button>
            </div>
            {detail.folder && detail.folder.description.trim().length > 0 && (
              <div className="hint" style={{ padding: "0 14px" }} data-testid="folder-context-banner">
                Project context: {detail.folder.description}
              </div>
            )}

            <div ref={scroller} className="panel-body" style={{ overflowY: "auto", flex: 1 }} data-testid="chat-scroll">
              {detail.messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
              {streaming && (
                <div className="chat-msg assistant" data-testid="chat-streaming">
                  <div className="md-body">
                    <Markdown text={streaming.content} />
                    {streaming.content.length === 0 && <span className="hint">thinking…</span>}
                  </div>
                </div>
              )}
            </div>

            <div style={{ borderTop: "1px solid var(--line)", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              {pending.length > 0 && (
                <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {pending.map((attachment, index) => (
                    <span key={`${attachment.name}-${index}`} className="chip">
                      {attachment.name} · {humanBytes(attachment.bytes)}
                      <button
                        className="btn"
                        style={{ marginLeft: 6 }}
                        onClick={() => setPending((current) => current.filter((_, i) => i !== index))}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  {!visionAlias && (
                    <span className="pill warn" data-testid="vision-hint">
                      {detail.conversation.model} is not vision-capable — switch the model to send images
                    </span>
                  )}
                </span>
              )}
              <span style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <textarea
                  className="input"
                  rows={2}
                  style={{ flex: 1, resize: "vertical" }}
                  placeholder="Message… (Enter to send, Shift+Enter for a newline)"
                  value={draft}
                  data-testid="chat-input"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  data-testid="chat-file"
                  onChange={(e) => void pickFiles(e.target.files)}
                />
                <button className="btn" onClick={() => fileInput.current?.click()}>
                  Attach
                </button>
                <button
                  className="btn primary"
                  data-testid="chat-send"
                  disabled={streaming !== null || (pending.length > 0 && !visionAlias)}
                  onClick={() => void send()}
                >
                  {streaming ? "…" : "Send"}
                </button>
              </span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
  onOpen,
  onDelete,
}: {
  conversation: ChatConversation;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <button
        className={active ? "nav-item active" : "nav-item"}
        style={{ flex: 1, textAlign: "left" }}
        data-testid={`chat-conv-${conversation.id}`}
        onClick={onOpen}
      >
        {conversation.title}
        <span className="hint"> {conversation.messageCount ?? 0}</span>
      </button>
      <button className="btn" title="Delete chat" onClick={onDelete}>
        ✕
      </button>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`chat-msg ${isUser ? "user" : "assistant"}`} data-testid={`chat-msg-${message.role}`}>
      {isUser ? (
        <div style={{ whiteSpace: "pre-wrap" }}>{message.content}</div>
      ) : (
        <div className="md-body">
          {message.content.length > 0 ? <Markdown text={message.content} /> : <span className="hint">no content</span>}
        </div>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          {message.attachments.map((attachment) => (
            <a
              key={attachment.id}
              href={(attachment as { previewUrl?: string }).previewUrl ?? `/api/chat/attachments/${attachment.id}`}
              target="_blank"
              rel="noreferrer"
            >
              <img
                src={(attachment as { previewUrl?: string }).previewUrl ?? `/api/chat/attachments/${attachment.id}`}
                alt={attachment.name}
                title={`${attachment.name} · ${humanBytes(attachment.bytes)}`}
                style={{ height: 72, borderRadius: 6, border: "1px solid var(--line)" }}
              />
            </a>
          ))}
        </div>
      )}
      {message.error && <div className="pill crit" style={{ marginTop: 6 }}>{message.error}</div>}
      {!isUser && message.usage && (
        <div className="hint" style={{ marginTop: 4 }}>
          {message.ttftMs != null ? `ttft ${message.ttftMs} ms · ` : ""}
          {message.durationMs != null ? `${message.durationMs} ms · ` : ""}
          {message.usage.promptTokens ?? "?"} in / {message.usage.completionTokens ?? "?"} out tokens
        </div>
      )}
    </div>
  );
}
