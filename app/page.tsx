"use client";

import { useChat } from "@ai-sdk/react";
import { TextStreamChatTransport, type UIMessage, type FileUIPart } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  downloadExportFile,
  type ExportFileDescriptor,
} from "./lib/export";
import { MarkdownRenderer } from "./components/MarkdownRenderer";
import { Logo } from "./components/Logo";
import { IntroAnimation } from "./components/IntroAnimation";

// ===== 本地会话持久化 =====

type ConversationSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = "campus-ai-conversations";

function loadConversations(): ConversationSummary[] {
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

function saveConversations(list: ConversationSummary[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function loadConversationMessages(id: string): UIMessage[] {
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

function saveConversationMessages(id: string, messages: UIMessage[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(`${STORAGE_KEY}:${id}`, JSON.stringify(messages));
}

function deleteConversationStorage(id: string) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(`${STORAGE_KEY}:${id}`);
  const list = loadConversations().filter((c) => c.id !== id);
  saveConversations(list);
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateChatId() {
  return `chat-${makeId()}`;
}

// ===== UI 帮助函数 =====

function getMessageText(m: UIMessage) {
  return m.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text?: string }).text ?? "")
    .join("");
}

function getMessageFiles(m: UIMessage): FileUIPart[] {
  return m.parts.filter((p) => p.type === "file") as FileUIPart[];
}

function isImage(mediaType: string) {
  return mediaType.startsWith("image/");
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 将 File 转为带 data URL 的 FileUIPart
function fileToDataUrl(file: File): Promise<FileUIPart> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      resolve({
        type: "file",
        mediaType: file.type || "application/octet-stream",
        filename: file.name,
        url: String(reader.result),
      });
    };
    reader.readAsDataURL(file);
  });
}

function formatTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ===== 主组件 =====

export default function Home() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [showIntro, setShowIntro] = useState(true);
  const handleIntroFinish = useCallback(() => setShowIntro(false), []);
  const [activeId, setActiveId] = useState<string>(() => generateChatId());
  const [hydrated, setHydrated] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<FileUIPart[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [expandedConvos, setExpandedConvos] = useState<Set<string>>(new Set());
  const [exportsByMessage, setExportsByMessage] = useState<
    Record<string, ExportFileDescriptor[]>
  >({});
  const [exportBusy, setExportBusy] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const exportInFlightRef = useRef<Set<string>>(new Set());
  const conversationsRef = useRef<ConversationSummary[]>([]);
  const activeIdRef = useRef<string>(activeId);
  // 记录本次发送所属的会话 ID：防止流式期间用户切换会话后，
  // onFinish 把回复保存/归档到错误的会话下
  const sentConvoIdRef = useRef<string | null>(null);

  // 初始化时从 localStorage 读取会话列表
  useEffect(() => {
    // 从外部存储（localStorage）同步会话列表到 React 状态
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConversations(loadConversations());
    setHydrated(true);
  }, []);

  // 同步 ref，避免 onFinish 闭包陈旧
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const initialMessages = useMemo<UIMessage[]>(
    () => (hydrated ? loadConversationMessages(activeId) : []),
    [activeId, hydrated],
  );

  // ===== AI 标题总结 =====
  const summarizeConversation = useCallback(async (convoId: string, msgs: UIMessage[]) => {
    const payload = {
      messages: msgs
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(0, 2)
        .map((m) => ({ role: m.role, text: getMessageText(m).slice(0, 4000) })),
    };
    if (payload.messages.length < 2) return;
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { title?: string };
      if (!data.title) return;
      const newTitle = data.title;
      setConversations((prev) => {
        const next = prev.map((c) =>
          c.id === convoId ? { ...c, title: newTitle, updatedAt: Date.now() } : c,
        );
        saveConversations(next);
        return next;
      });
    } catch {
      // 静默失败，保留占位符标题
    }
  }, []);

  // ===== 导出文件生成 =====
  const generateExportsForMessage = useCallback(
    async (assistantMessageId: string, msgs: UIMessage[]) => {
      if (exportInFlightRef.current.has(assistantMessageId)) return;
      exportInFlightRef.current.add(assistantMessageId);
      setExportBusy((prev) => new Set(prev).add(assistantMessageId));
      const payload = {
        messages: msgs
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, text: getMessageText(m).slice(0, 20000) })),
      };
      try {
        const res = await fetch("/api/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { files?: ExportFileDescriptor[] };
        if (!data.files || data.files.length === 0) return;
        setExportsByMessage((prev) => ({ ...prev, [assistantMessageId]: data.files! }));
      } catch {
        // 静默失败
      } finally {
        exportInFlightRef.current.delete(assistantMessageId);
        setExportBusy((prev) => {
          const next = new Set(prev);
          next.delete(assistantMessageId);
          return next;
        });
      }
    },
    [],
  );

  const { messages, sendMessage, status } = useChat<UIMessage>({
    id: activeId,
    messages: initialMessages,
    transport: new TextStreamChatTransport({ api: "/api/chat" }),
    onFinish: ({ messages: finalMessages, isAbort, isError }) => {
      // 必须在此处落盘：流式过程中 messages.length 与末条消息 id 均不变，
      // 下方持久化 effect 的指纹不会变化，导致最终回复内容无法写入 localStorage
      const convoId = sentConvoIdRef.current ?? activeIdRef.current;
      if (finalMessages.length > 0) {
        saveConversationMessages(convoId, finalMessages);
      }
      if (isAbort || isError) return;
      // 标题总结：仅当当前标题仍是占位符时触发
      const existing = conversationsRef.current.find((c) => c.id === convoId);
      const isPlaceholder =
        !existing?.title ||
        existing.title === "新对话" ||
        existing.title.startsWith("新对话");
      if (isPlaceholder && finalMessages.length >= 2) {
        void summarizeConversation(convoId, finalMessages);
      }
      // 导出生成：每次 assistant 回复完成后自动触发
      const lastAssistant = [...finalMessages]
        .reverse()
        .find((m) => m.role === "assistant");
      if (lastAssistant) {
        void generateExportsForMessage(lastAssistant.id, finalMessages);
      }
    },
  });

  const isLoading = status === "submitted" || status === "streaming";

  // 消息变化时滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 持久化当前会话的消息
  // 用 messages 长度 + 末条消息 id 作为内容指纹，仅依赖 messages/activeId/hydrated，
  // 不依赖 conversations，避免 updatedAt 每次刷新导致死循环。
  // 注意：流式 delta 不改变指纹，最终回复内容由上方 onFinish 回调负责落盘
  const messagesFingerprint = `${messages.length}:${messages.at(-1)?.id ?? ""}`;
  useEffect(() => {
    if (!hydrated) return;
    if (messages.length === 0) return;
    saveConversationMessages(activeId, messages);

    const prev = conversationsRef.current;
    const existing = prev.find((c) => c.id === activeId);
    const firstUserText = messages
      .filter((m) => m.role === "user")
      .map(getMessageText)
      .find((t) => t.trim().length > 0);
    // 真实标题（AI 总结）一旦设置就不再被占位符覆盖
    const isRealTitle =
      existing?.title &&
      existing.title !== "新对话" &&
      !existing.title.startsWith("新对话");
    const title = isRealTitle
      ? existing!.title
      : firstUserText?.slice(0, 20) || "新对话";

    // 已存在且标题未变 → 不更新（避免死循环）
    if (existing && existing.title === title) return;

    let merged: ConversationSummary[];
    if (existing) {
      merged = prev.map((c) =>
        c.id === activeId ? { ...c, title, updatedAt: Date.now() } : c,
      );
    } else {
      merged = [
        {
          id: activeId,
          title,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        ...prev,
      ];
    }
    saveConversations(merged);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConversations(merged);
    // 故意不依赖 conversations；用 ref 读取最新值，指纹变化才重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesFingerprint, activeId, hydrated]);

  // ===== 事件处理 =====

  const startNewConversation = () => {
    const newId = generateChatId();
    setActiveId(newId);
    setPendingFiles([]);
  };

  const selectConversation = (id: string) => {
    if (id === activeId) return;
    setActiveId(id);
    setPendingFiles([]);
  };

  const removeConversation = (id: string) => {
    deleteConversationStorage(id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === activeId) {
      startNewConversation();
    }
  };

  const toggleConvoExpanded = (id: string) => {
    setExpandedConvos((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const scrollToMessage = (messageId: string) => {
    messageRefs.current.get(messageId)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const handleManualExport = () => {
    if (messages.length === 0 || isLoading) return;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (lastAssistant) {
      void generateExportsForMessage(lastAssistant.id, messages);
    }
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const picked: FileUIPart[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      // 大小限制 10MB
      if (f.size > 10 * 1024 * 1024) continue;
      try {
        picked.push(await fileToDataUrl(f));
      } catch {
        // 读取失败则跳过
      }
    }
    setPendingFiles((prev) => [...prev, ...picked]);
    // 清空 input，便于重复选择同一文件
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    const hasText = input.trim().length > 0;
    const hasFiles = pendingFiles.length > 0;
    if (!hasText && !hasFiles) return;

    sendMessage({
      text: input,
      files: pendingFiles.length > 0 ? pendingFiles : undefined,
    });
    // 记录发送时所属会话，供 onFinish 归档使用
    sentConvoIdRef.current = activeId;
    setInput("");
    setPendingFiles([]);
  };

  const [input, setInput] = useState("");

  // ===== 渲染 =====

  if (showIntro) {
    return <IntroAnimation onFinish={handleIntroFinish} />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* 左侧历史会话栏 */}
      <aside
        className={`${
          sidebarOpen ? "w-72" : "w-0"
        } shrink-0 transition-all duration-200 overflow-hidden bg-surface border-r border-border flex flex-col`}
      >
        <div className="w-72 h-full flex flex-col">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground/80">历史会话</h2>
            <button
              type="button"
              onClick={startNewConversation}
              className="text-xs px-2 py-1 rounded-md bg-primary-50 text-primary-600 hover:bg-primary-100 transition-colors"
            >
              + 新对话
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {conversations.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-foreground/40">
                还没有会话记录
              </div>
            )}
            {conversations.map((c) => {
              const isActive = c.id === activeId;
              const isExpanded = expandedConvos.has(c.id);
              // 从 localStorage 读取该会话的用户问题节点
              const convoMessages = hydrated ? loadConversationMessages(c.id) : [];
              const userNodes = convoMessages
                .filter((m) => m.role === "user")
                .map((m) => ({
                  id: m.id,
                  text: getMessageText(m).trim(),
                }))
                .filter((n) => n.text.length > 0);
              return (
                <div
                  key={c.id}
                  className={`group border-b border-border transition-colors ${
                    isActive ? "bg-primary-50" : "hover:bg-muted"
                  }`}
                >
                  <div
                    onClick={() => selectConversation(c.id)}
                    className={`px-3 py-3 cursor-pointer flex items-start gap-2 ${
                      isActive ? "text-primary-600" : "text-foreground/80"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleConvoExpanded(c.id);
                      }}
                      className={`mt-0.5 w-4 h-4 flex items-center justify-center text-xs text-foreground/60 hover:text-foreground transition-transform ${
                        isExpanded ? "rotate-90" : ""
                      }`}
                      aria-label={isExpanded ? "收起" : "展开"}
                    >
                      ▶
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{c.title}</div>
                      <div className="text-[11px] text-foreground/40 mt-0.5">
                        {formatTime(c.updatedAt)} · {userNodes.length} 个问题
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeConversation(c.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-foreground/40 hover:text-danger text-xs px-1"
                      aria-label="删除会话"
                    >
                      ×
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="pb-2 pl-9 pr-3">
                      {userNodes.length === 0 ? (
                        <div className="text-[11px] text-foreground/40 py-1">
                          暂无问题
                        </div>
                      ) : (
                        <div className="relative ml-2 pl-4 border-l-2 border-primary-100 space-y-1">
                          {userNodes.map((n, i) => (
                            <button
                              key={n.id}
                              type="button"
                              onClick={() => {
                                if (c.id !== activeId) selectConversation(c.id);
                                // 切换会话后立即滚动可能未挂载，延迟一帧再尝试
                                setTimeout(() => scrollToMessage(n.id), 50);
                              }}
                              className="group/node block w-full text-left text-xs text-foreground/80 hover:text-primary-600 hover:bg-primary-50 px-2 py-1.5 rounded transition-colors relative"
                              title={n.text}
                            >
                              <span className="absolute -left-[21px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-primary-400 ring-2 ring-white group-hover/node:bg-primary-600 transition-colors" />
                              <span className="truncate font-medium">
                                {i + 1}. {n.text.slice(0, 24)}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="px-4 py-2 text-xs text-foreground/60 border-t border-border hover:bg-muted"
          >
            收起侧栏
          </button>
        </div>
      </aside>

      {/* 收起状态下展开按钮 */}
      {!sidebarOpen && (
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className="absolute top-3 left-3 z-10 bg-surface border border-border rounded-md px-2 py-1 text-xs text-foreground/70 shadow-sm hover:bg-muted"
        >
          ☰ 展开
        </button>
      )}

      {/* 主聊天区 */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* 顶部导航栏 */}
        <header className="bg-primary-600 text-white px-4 py-3 shadow-md flex items-center gap-3 shrink-0">
          <div className="w-9 h-9 bg-white/20 rounded-full flex items-center justify-center">
            <Logo size={32} color="#FFFFFF" accent="#8FC0FF" />
          </div>
          <div>
            <h1 className="font-semibold text-sm">校园AI助手</h1>
            <p className="text-xs text-primary-100">在线 · 随时为你解答</p>
          </div>
          <button
            type="button"
            onClick={handleManualExport}
            disabled={messages.length === 0 || isLoading}
            className="ml-auto text-xs px-3 py-1.5 bg-white/20 hover:bg-white/30 rounded-md disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
            title="导出当前对话"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            导出对话
          </button>
        </header>

        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-foreground/40 select-none">
              <Logo size={64} className="mb-3" />
              <p className="text-sm font-medium">你好！我是校园AI助手</p>
              <p className="text-xs mt-1">有什么关于学校的问题都可以问我~</p>
            </div>
          )}

          {messages.map((m) => {
            const text = getMessageText(m);
            const files = getMessageFiles(m);
            const exportsForThis = exportsByMessage[m.id] ?? [];
            const isExportBusy = exportBusy.has(m.id);
            return (
              <div
                key={m.id}
                ref={(el) => {
                  if (el) messageRefs.current.set(m.id, el);
                  else messageRefs.current.delete(m.id);
                }}
                className={`flex flex-col ${
                  m.role === "user" ? "items-end" : "items-start"
                }`}
              >
                <div
                  className={`flex ${
                    m.role === "user" ? "justify-end" : "justify-start"
                  } w-full`}
                >
                  {m.role !== "user" && (
                    <div className="w-8 h-8 bg-primary-500 rounded-full flex items-center justify-center text-white text-sm mr-2 shrink-0">
                      🎓
                    </div>
                  )}

                  <div
                    className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed break-words ${
                      m.role === "user"
                        ? "bg-primary-600 text-white rounded-br-md"
                        : "bg-surface text-foreground rounded-bl-md shadow-sm"
                    }`}
                  >
                    {files.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-2">
                        {files.map((f, i) => (
                          <FilePreview key={i} file={f} fromUser={m.role === "user"} />
                        ))}
                      </div>
                    )}
                    {text && (
                      <MarkdownRenderer
                        content={text}
                        variant={m.role === "user" ? "user" : "assistant"}
                      />
                    )}
                  </div>

                  {m.role === "user" && (
                    <div className="w-8 h-8 bg-ink-400 rounded-full flex items-center justify-center text-white text-sm ml-2 shrink-0">
                      👤
                    </div>
                  )}
                </div>

                {/* AI 回复：AI 生成的导出文件卡片（代码块下载按钮已内置在 MarkdownRenderer 里） */}
                {m.role === "assistant" && exportsForThis.length > 0 && (
                  <div className="ml-10 mt-2 flex flex-wrap gap-2">
                    {exportsForThis.map((f, i) => (
                      <ExportFileCard key={i} file={f} />
                    ))}
                  </div>
                )}

                {/* AI 回复：导出加载中提示 */}
                {m.role === "assistant" && isExportBusy && exportsForThis.length === 0 && (
                  <div className="ml-10 mt-2 text-[11px] text-foreground/40 flex items-center gap-1.5">
                    <span className="w-2 h-2 bg-primary-400 rounded-full animate-bounce [animation-delay:0ms]" />
                    <span className="w-2 h-2 bg-primary-400 rounded-full animate-bounce [animation-delay:150ms]" />
                    <span className="w-2 h-2 bg-primary-400 rounded-full animate-bounce [animation-delay:300ms]" />
                    <span className="ml-1">正在生成可导出文件…</span>
                  </div>
                )}
              </div>
            );
          })}

          {/* AI 正在输入动画 */}
          {isLoading && messages.at(-1)?.role === "user" && (
            <div className="flex justify-start">
              <div className="w-8 h-8 bg-primary-500 rounded-full flex items-center justify-center text-white text-sm mr-2 shrink-0">
                🎓
              </div>
              <div className="bg-surface px-4 py-3 rounded-2xl rounded-bl-md shadow-sm">
                <div className="flex gap-1.5">
                  <span className="w-2 h-2 bg-primary-400 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-2 h-2 bg-primary-400 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-2 h-2 bg-primary-400 rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* 待上传文件预览条 */}
        {pendingFiles.length > 0 && (
          <div className="bg-surface border-t border-border px-4 py-2 flex flex-wrap gap-2 shrink-0">
            {pendingFiles.map((f, i) => (
              <div
                key={i}
                className="relative flex items-center gap-2 bg-muted rounded-md px-2 py-1 pr-6 text-xs text-foreground/80"
              >
                {isImage(f.mediaType) && f.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={f.url}
                    alt={f.filename ?? ""}
                    className="w-8 h-8 object-cover rounded"
                  />
                ) : (
                  <span className="text-base">📄</span>
                )}
                <span className="max-w-[120px] truncate">{f.filename}</span>
                <button
                  type="button"
                  onClick={() => removePendingFile(i)}
                  className="absolute top-0 right-0 text-foreground/40 hover:text-danger px-1"
                  aria-label="移除"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 底部输入区 */}
        <form
          onSubmit={handleSubmit}
          className="bg-surface border-t border-border px-4 py-3 flex items-center gap-2 shrink-0"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.pdf,.doc,.docx,.txt,.md,.csv,.xlsx,.pptx"
            onChange={handleFilePick}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            className="w-10 h-10 bg-muted rounded-full flex items-center justify-center text-foreground/70 shrink-0 hover:bg-border disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="上传文件"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入你的问题..."
            className="flex-1 bg-muted text-foreground placeholder:text-foreground/60 rounded-full px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary-400 focus:bg-surface transition-all"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || (!input.trim() && pendingFiles.length === 0)}
            className="w-10 h-10 bg-primary-600 rounded-full flex items-center justify-center text-white shrink-0 hover:bg-primary-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </form>
      </main>
    </div>
  );
}

// ===== 文件预览组件 =====

function FilePreview({
  file,
  fromUser,
}: {
  file: FileUIPart;
  fromUser: boolean;
}) {
  if (isImage(file.mediaType) && file.url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={file.url}
        alt={file.filename ?? "图片"}
        className="max-w-[200px] max-h-[200px] rounded-lg object-cover"
      />
    );
  }
  return (
    <a
      href={file.url || "#"}
      download={file.filename}
      className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-xs ${
        fromUser
          ? "bg-white/20 text-white"
          : "bg-muted text-foreground/80 hover:bg-border"
      }`}
    >
      <span className="text-base">📄</span>
      <span className="max-w-[160px] truncate">{file.filename}</span>
      {file.url && (
        <span className="opacity-70 text-[10px]">
          {formatBytes(estimateDataUrlBytes(file.url))}
        </span>
      )}
    </a>
  );
}

function estimateDataUrlBytes(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const base64 = dataUrl.slice(comma + 1);
  return Math.floor((base64.length * 3) / 4);
}

// ===== 导出文件卡片组件 =====

const FORMAT_ICON: Record<ExportFileDescriptor["format"], string> = {
  code: "💻",
  markdown: "📝",
  docx: "📘",
  pdf: "📕",
  text: "📄",
};

const FORMAT_LABEL: Record<ExportFileDescriptor["format"], string> = {
  code: "代码",
  markdown: "Markdown",
  docx: "Word",
  pdf: "PDF",
  text: "文本",
};

function ExportFileCard({ file }: { file: ExportFileDescriptor }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      await downloadExportFile(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "下载失败");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex items-center gap-2 bg-surface border border-border rounded-lg px-3 py-2 shadow-sm max-w-[280px]">
      <span className="text-xl">{FORMAT_ICON[file.format]}</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-foreground truncate" title={file.filename}>
          {file.filename}
        </div>
        <div className="text-[10px] text-foreground/60">
          {FORMAT_LABEL[file.format]}
          {file.language ? ` · ${file.language}` : ""}
        </div>
        {error && <div className="text-[10px] text-danger mt-0.5">{error}</div>}
      </div>
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading}
        className="text-[11px] px-2 py-1 bg-primary-50 text-primary-600 hover:bg-primary-100 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
      >
        {downloading ? "下载中…" : "下载"}
      </button>
    </div>
  );
}
