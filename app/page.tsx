"use client";

/**
 * 校园AI助手主页面
 *
 * 职责：全局状态编排（会话列表/活动会话/聊天流/导出）+ UI 组合。
 * 展示细节在 components/chat/ 各组件中，会话持久化在 conversation-storage.ts。
 */

import { useChat } from "@ai-sdk/react";
import {
  TextStreamChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type FileUIPart,
  type UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IntroAnimation } from "./components/IntroAnimation";
import { Logo } from "./components/Logo";
import { ConversationSidebar } from "./components/chat/ConversationSidebar";
import { MessageBubble } from "./components/chat/MessageBubble";
import {
  deleteConversationStorage,
  generateChatId,
  loadAuthorizedDirs,
  loadConversationMessages,
  loadConversations,
  saveConversationMessages,
  saveConversations,
  type ConversationSummary,
} from "./components/chat/conversation-storage";
import {
  addAuthorizedDirectory,
  removeAuthorizedDirectory,
} from "./components/chat/authorized-directories";
import {
  fileToDataUrl,
  getMessageText,
  isImage,
} from "./components/chat/message-utils";
import { stripPendingApprovals } from "./lib/message-text";
import type { ExportFileDescriptor } from "./lib/export";

// ===== 类型 =====

interface SummarizeResponse {
  title?: string;
}

interface ExportResponse {
  files?: ExportFileDescriptor[];
}

export default function Home() {
  // ===== 状态 =====
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [showIntro, setShowIntro] = useState(true);
  const [activeId, setActiveId] = useState<string>(() => generateChatId());
  const [hydrated, setHydrated] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<FileUIPart[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [expandedConvos, setExpandedConvos] = useState<Set<string>>(new Set());
  const [exportsByMessage, setExportsByMessage] = useState<
    Record<string, ExportFileDescriptor[]>
  >({});
  const [exportBusy, setExportBusy] = useState<Set<string>>(new Set());
  const [input, setInput] = useState("");
  const [authorizedDirs, setAuthorizedDirs] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : loadAuthorizedDirs(),
  );
  const [showAddDirectory, setShowAddDirectory] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const exportInFlightRef = useRef<Set<string>>(new Set());
  // ref 镜像：供 onFinish 等回调读取最新值，避免闭包陈旧
  const conversationsRef = useRef<ConversationSummary[]>([]);
  const activeIdRef = useRef<string>(activeId);
  const authorizedDirsRef = useRef<string[]>(authorizedDirs);

  // ===== 初始化与 ref 同步 =====

  // 初始化时从 localStorage 读取会话列表
  useEffect(() => {
    // 从外部存储（localStorage）同步会话列表到 React 状态
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConversations(loadConversations());
    setHydrated(true);
  }, []);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    authorizedDirsRef.current = authorizedDirs;
  }, [authorizedDirs]);

  const initialMessages = useMemo<UIMessage[]>(
    () => (hydrated ? loadConversationMessages(activeId) : []),
    [activeId, hydrated],
  );

  // ===== AI 标题总结 =====

  const summarizeConversation = useCallback(
    async (convoId: string, msgs: UIMessage[]) => {
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
        const data = (await res.json()) as SummarizeResponse;
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
    },
    [],
  );

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
        const data = (await res.json()) as ExportResponse;
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

  // ===== 聊天流 =====

  // 每次发送前：清理悬空 approval + 注入最新授权目录
  const transport = useMemo(
    () =>
      new TextStreamChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages: msgs, body }) => ({
          body: {
            ...body,
            messages: stripPendingApprovals(msgs),
            authorizedDirectories: authorizedDirsRef.current,
          },
        }),
      }),
    [],
  );

  const { messages, sendMessage, status, addToolApprovalResponse } = useChat<UIMessage>({
    id: activeId,
    messages: initialMessages,
    transport,
    // 所有待确认的工具调用都被响应后，自动重发请求让服务端继续执行
    sendAutomaticallyWhen: ({ messages: msgs }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: msgs }),
    onFinish: ({ messages: finalMessages, isAbort, isError }) => {
      if (isAbort || isError) return;
      const convoId = activeIdRef.current;
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
  // 不依赖 conversations，避免 updatedAt 每次刷新导致死循环
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
    setConversations(merged);
    // 故意不依赖 conversations；用 ref 读取最新值，指纹变化才重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesFingerprint, activeId, hydrated]);

  // ===== 事件处理 =====

  const startNewConversation = () => {
    setActiveId(generateChatId());
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
    setInput("");
    setPendingFiles([]);
  };

  const handleIntroFinish = useCallback(() => setShowIntro(false), []);

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
        {sidebarOpen && (
          <ConversationSidebar
            conversations={conversations}
            activeId={activeId}
            hydrated={hydrated}
            expandedConvos={expandedConvos}
            authorizedDirs={authorizedDirs}
            showAddDirectory={showAddDirectory}
            onToggleAddDirectory={() => setShowAddDirectory((v) => !v)}
            onAddDirectory={(dir) => {
              setAuthorizedDirs(addAuthorizedDirectory(dir));
            }}
            onRemoveDirectory={(dir) => {
              setAuthorizedDirs(removeAuthorizedDirectory(dir));
            }}
            onNewConversation={startNewConversation}
            onSelectConversation={selectConversation}
            onRemoveConversation={removeConversation}
            onToggleExpanded={toggleConvoExpanded}
            onScrollToMessage={scrollToMessage}
            onCollapse={() => setSidebarOpen(false)}
          />
        )}
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

          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              ref={(el) => {
                if (el) messageRefs.current.set(m.id, el);
                else messageRefs.current.delete(m.id);
              }}
              message={m}
              exportsForThis={exportsByMessage[m.id] ?? []}
              isExportBusy={exportBusy.has(m.id)}
              onToolApproval={(approvalId, approved) => {
                void addToolApprovalResponse({
                  id: approvalId,
                  approved,
                  reason: approved ? "用户在界面确认" : "用户拒绝",
                });
              }}
            />
          ))}

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
