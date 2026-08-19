/**
 * 会话 localStorage 持久化 —— 会话列表与消息的读写纯函数
 *
 * 存储布局：
 *   "campus-ai-conversations"        → ConversationSummary[]（会话元信息列表）
 *   "campus-ai-conversations:<id>"   → UIMessage[]（每个会话的消息）
 *
 * 全部函数对 window 做防御（SSR 时返回空值），JSON 解析失败静默降级。
 * 被 app/page.tsx 与 ConversationSidebar 组件调用。
 */

import type { UIMessage } from "ai";

export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = "campus-ai-conversations";

// ===== 会话列表 =====

export function loadConversations(): ConversationSummary[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ConversationSummary[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveConversations(list: ConversationSummary[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

// ===== 会话消息 =====

export function loadConversationMessages(id: string): UIMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY}:${id}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as UIMessage[]) : [];
  } catch {
    return [];
  }
}

export function saveConversationMessages(id: string, messages: UIMessage[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(`${STORAGE_KEY}:${id}`, JSON.stringify(messages));
}

/** 删除单个会话的消息与列表项 */
export function deleteConversationStorage(id: string) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(`${STORAGE_KEY}:${id}`);
  const list = loadConversations().filter((c) => c.id !== id);
  saveConversations(list);
}

// ===== ID 生成 =====

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateChatId() {
  return `chat-${makeId()}`;
}
