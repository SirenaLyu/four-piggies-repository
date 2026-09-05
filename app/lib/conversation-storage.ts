import type { UIMessage } from "ai";

export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export const STORAGE_KEY = "campus-ai-conversations";

function scopedStorageKey(scope: string): string {
  const safeScope = scope.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return `${STORAGE_KEY}:${safeScope || "legacy"}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): StorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function safeWrite(storage: StorageLike, key: string, value: unknown): boolean {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn(`[conversation-storage] 无法写入 ${key}：`, error);
    return false;
  }
}

function attachmentMarker(filename: unknown, mediaType: unknown): string {
  const safeName =
    typeof filename === "string" && filename.trim() ? filename.trim() : "未命名文件";
  const safeType =
    typeof mediaType === "string" && mediaType.trim() ? `，${mediaType.trim()}` : "";
  return `[附件：${safeName}${safeType}；为保护隐私并避免浏览器存储溢出，文件内容未保存在本地历史中]`;
}

/**
 * 对话历史只保存附件元信息，不保存 data URL。本轮请求仍会携带原始附件；
 * 页面刷新后仅显示附件标记，避免 Base64 数据耗尽 localStorage。
 */
export function stripAttachmentPayloads(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "file") return part;
      changed = true;
      return {
        type: "text" as const,
        text: attachmentMarker(part.filename, part.mediaType),
      };
    });
    return changed ? { ...message, parts } : message;
  });
}

export function loadConversations(
  scope = "legacy",
  storage: StorageLike | null = browserStorage(),
): ConversationSummary[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(scopedStorageKey(scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ConversationSummary[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveConversations(
  list: ConversationSummary[],
  scope = "legacy",
  storage: StorageLike | null = browserStorage(),
): boolean {
  return storage ? safeWrite(storage, scopedStorageKey(scope), list) : false;
}

export function loadConversationMessages(
  id: string,
  scope = "legacy",
  storage: StorageLike | null = browserStorage(),
): UIMessage[] {
  if (!storage) return [];
  try {
    const key = `${scopedStorageKey(scope)}:${id}`;
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const messages = stripAttachmentPayloads(parsed as UIMessage[]);
    // 顺手迁移旧历史，清除其中可能遗留的大型 data URL。
    safeWrite(storage, key, messages);
    return messages;
  } catch {
    return [];
  }
}

export function saveConversationMessages(
  id: string,
  messages: UIMessage[],
  scope = "legacy",
  storage: StorageLike | null = browserStorage(),
): boolean {
  return storage
    ? safeWrite(storage, `${scopedStorageKey(scope)}:${id}`, stripAttachmentPayloads(messages))
    : false;
}

export function deleteConversationStorage(
  id: string,
  scope = "legacy",
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(`${scopedStorageKey(scope)}:${id}`);
    return saveConversations(
      loadConversations(scope, storage).filter((conversation) => conversation.id !== id),
      scope,
      storage,
    );
  } catch (error) {
    console.warn(`[conversation-storage] 无法删除会话 ${id}：`, error);
    return false;
  }
}
