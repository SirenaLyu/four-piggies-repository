"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type FileUIPart,
  type UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExportFileDescriptor } from "./lib/export";
import { Logo } from "./components/Logo";
import { LandingPage } from "./components/LandingPage";
import { ChatComposer } from "./components/chat/ChatComposer";
import { ChatTranscript } from "./components/chat/ChatTranscript";
import { ConversationSidebar } from "./components/chat/ConversationSidebar";
import {
  SettingsDrawer,
  type UserProfileDraft,
} from "./components/SettingsDrawer";
import { UserProfilePrompt } from "./components/UserProfilePrompt";
import { AuthGate, type SignedInUser } from "./components/AuthGate";
import {
  hasPendingApprovals,
  stripPendingApprovals,
} from "./components/chat/approval-parts";
import {
  addAuthorizedDirectory,
  loadAuthorizedDirs,
  removeAuthorizedDirectory,
} from "./components/chat/authorized-directories";
import {
  DEFAULT_CAPABILITIES,
  normalizeCapabilities,
  type AssistantCapabilities,
} from "./lib/capabilities";
import {
  deleteConversationStorage,
  loadConversationMessages,
  loadConversations,
  saveConversationMessages,
  saveConversations,
  type ConversationSummary,
} from "./lib/conversation-storage";
import {
  estimateDataUrlBytes as estimateAttachmentDataUrlBytes,
  inferAttachmentMediaType,
  validateAttachment,
} from "./lib/attachment-policy";
import {
  extractOfficeAttachmentText,
  isOfficeAttachmentMediaType,
} from "./lib/office-attachment";
import {
  buildPersonalizedSuggestions,
  EMPTY_USER_PROFILE,
  isCompleteUserProfile,
  normalizeUserProfile,
  type UserProfile,
} from "./lib/user-profile";

const CAPABILITIES_KEY = "campus-ai-capabilities";
const USER_PROFILE_KEY = "campus-ai-user-profile";

function savePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    console.warn(`[preferences] 无法保存 ${key}：`, error);
  }
}

function loadPreference(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch (error) {
    console.warn(`[preferences] 无法读取 ${key}：`, error);
    return fallback;
  }
}

function userScopedKey(key: string, userId: string): string {
  return `${key}:${userId}`;
}

function loadCapabilities(userId: string): AssistantCapabilities {
  if (typeof window === "undefined") return { ...DEFAULT_CAPABILITIES };
  try {
    return normalizeCapabilities(
      JSON.parse(
        window.localStorage.getItem(userScopedKey(CAPABILITIES_KEY, userId)) ?? "null",
      ),
    );
  } catch {
    return { ...DEFAULT_CAPABILITIES };
  }
}

function loadUserProfile(userId: string): UserProfile {
  if (typeof window === "undefined") return { ...EMPTY_USER_PROFILE };
  try {
    return normalizeUserProfile(
      JSON.parse(loadPreference(userScopedKey(USER_PROFILE_KEY, userId), "null")),
    );
  } catch {
    return { ...EMPTY_USER_PROFILE };
  }
}

function saveUserProfile(profile: UserProfile, userId: string): void {
  savePreference(userScopedKey(USER_PROFILE_KEY, userId), JSON.stringify(profile));
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

// 将受支持的 File 转为带 data URL 的 FileUIPart。
async function fileToDataUrl(file: File): Promise<FileUIPart> {
  const mediaType = inferAttachmentMediaType(file);
  if (!mediaType) throw new Error(`不支持的附件格式：${file.name}`);
  if (isOfficeAttachmentMediaType(mediaType)) {
    const text = await extractOfficeAttachmentText(file);
    return {
      type: "file",
      mediaType: "text/markdown",
      filename: `${file.name}.txt`,
      url: `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`,
    };
  }
  if (mediaType.startsWith("text/")) {
    const text = await file.text();
    return {
      type: "file",
      mediaType,
      filename: file.name,
      url: `data:${mediaType};charset=utf-8,${encodeURIComponent(text)}`,
    };
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      resolve({
        type: "file",
        mediaType,
        filename: file.name,
        url: String(reader.result).replace(/^data:[^;,]*/, `data:${mediaType}`),
      });
    };
    reader.readAsDataURL(file);
  });
}

// ===== 主组件 =====

export default function Home() {
  return <AuthGate>{(user) => <CampusAssistant user={user} />}</AuthGate>;
}

function CampusAssistant({ user }: { user: SignedInUser }) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [showLanding, setShowLanding] = useState(true);
  const handleEnter = useCallback(() => setShowLanding(false), []);

  // 支持 URL 参数 ?chat=1 直接进入聊天页（便于快速测试）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("chat") === "1" || params.get("enter") === "1") {
      // URL 查询参数是浏览器外部状态，只在首次挂载时同步一次。
      setShowLanding(false);
    }
  }, []);

  const [activeId, setActiveId] = useState<string>(() => generateChatId());
  const [hydrated, setHydrated] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<FileUIPart[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [expandedConvos, setExpandedConvos] = useState<Set<string>>(new Set());
  const [exportsByMessage, setExportsByMessage] = useState<
    Record<string, ExportFileDescriptor[]>
  >({});
  const [exportBusy, setExportBusy] = useState<Set<string>>(new Set());
  const [exportErrorsByMessage, setExportErrorsByMessage] = useState<
    Record<string, string>
  >({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [darkMode, setDarkMode] = useState<"auto" | "light" | "dark">("auto");
  const [themeColor, setThemeColor] = useState("blue");
  const [capabilities, setCapabilities] = useState<AssistantCapabilities>({
    ...DEFAULT_CAPABILITIES,
  });
  const [userProfile, setUserProfile] = useState<UserProfile>({
    ...EMPTY_USER_PROFILE,
  });
  const [profileDraft, setProfileDraft] = useState<UserProfileDraft>({
    age: "",
    major: "",
  });
  const [profilePromptOpen, setProfilePromptOpen] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [authorizedDirs, setAuthorizedDirs] = useState<string[]>([]);
  const [showAddDirectory, setShowAddDirectory] = useState(false);
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
    setConversations(loadConversations(user.id));
    setHydrated(true);
  }, [user.id]);

  // 读取设置偏好
  useEffect(() => {
    // localStorage 是外部状态源，仅在首次挂载时同步一次。
    const d = loadPreference("campus-dark-mode", "auto") as
      | "auto"
      | "light"
      | "dark";
    setDarkMode(d);
    const c = loadPreference("campus-theme-color", "blue");
    setThemeColor(c);
    setCapabilities(loadCapabilities(user.id));
    let cancelled = false;
    void loadAuthorizedDirs()
      .then((directories) => {
        if (!cancelled) setAuthorizedDirs(directories);
      })
      .catch((error) => {
        console.warn("[agent-directories] 无法读取服务端授权：", error);
        if (!cancelled) setAuthorizedDirs([]);
      });
    const storedProfile = loadUserProfile(user.id);
    setUserProfile(storedProfile);
    setProfileDraft({
      age: storedProfile.age?.toString() ?? "",
      major: storedProfile.major,
    });
    setProfilePromptOpen(!isCompleteUserProfile(storedProfile));
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  // 持久化设置
  useEffect(() => {
    savePreference("campus-dark-mode", darkMode);
    document.documentElement.setAttribute("data-theme", darkMode === "auto" ? "" : darkMode);
    if (darkMode === "auto") document.documentElement.removeAttribute("data-theme");
  }, [darkMode]);
  useEffect(() => {
    savePreference("campus-theme-color", themeColor);
    document.documentElement.setAttribute("data-theme-color", themeColor);
  }, [themeColor]);
  useEffect(() => {
    savePreference(userScopedKey(CAPABILITIES_KEY, user.id), JSON.stringify(capabilities));
  }, [capabilities, user.id]);

  // 同步 ref，避免 onFinish 闭包陈旧
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const initialMessages = useMemo<UIMessage[]>(
    () => (hydrated ? loadConversationMessages(activeId, user.id) : []),
    [activeId, hydrated, user.id],
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
        saveConversations(next, user.id);
        return next;
      });
    } catch {
      // 静默失败，保留占位符标题
    }
  }, [user.id]);

  // ===== 导出文件生成 =====
  const generateExportsForMessage = useCallback(
    async (assistantMessageId: string, msgs: UIMessage[]) => {
      if (exportInFlightRef.current.has(assistantMessageId)) return;
      exportInFlightRef.current.add(assistantMessageId);
      setExportBusy((prev) => new Set(prev).add(assistantMessageId));
      setExportErrorsByMessage((prev) => {
        if (!prev[assistantMessageId]) return prev;
        const next = { ...prev };
        delete next[assistantMessageId];
        return next;
      });
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
        const data = (await res.json().catch(() => ({}))) as {
          files?: ExportFileDescriptor[];
          error?: string;
        };
        if (!res.ok) {
          throw new Error(data.error || `导出服务返回 HTTP ${res.status}`);
        }
        if (!data.files || data.files.length === 0) {
          throw new Error("导出服务没有生成可下载文件");
        }
        setExportsByMessage((prev) => ({ ...prev, [assistantMessageId]: data.files! }));
      } catch (error) {
        setExportErrorsByMessage((prev) => ({
          ...prev,
          [assistantMessageId]:
            error instanceof Error ? error.message : "导出失败，请稍后重试",
        }));
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

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages: nextMessages, body }) => ({
          body: {
            ...body,
            messages: stripPendingApprovals(nextMessages),
            capabilities,
            userProfile,
          },
        }),
      }),
    [capabilities, userProfile],
  );

  const { messages, sendMessage, status, addToolApprovalResponse } = useChat<UIMessage>({
    id: activeId,
    messages: initialMessages,
    transport,
    sendAutomaticallyWhen: ({ messages: nextMessages }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: nextMessages }),
    onFinish: ({ messages: finalMessages, isAbort, isError }) => {
      // 必须在此处落盘：流式过程中 messages.length 与末条消息 id 均不变，
      // 下方持久化 effect 的指纹不会变化，导致最终回复内容无法写入 localStorage
      const convoId = sentConvoIdRef.current ?? activeIdRef.current;
      if (finalMessages.length > 0) {
        saveConversationMessages(convoId, finalMessages, user.id);
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
      // 导出文件改为用户主动点击后生成，避免每轮额外调用一次模型。
    },
  });

  const isLoading = status === "submitted" || status === "streaming";
  const hasPendingApproval = messages.some(hasPendingApprovals);
  const capabilityControlsDisabled = isLoading || hasPendingApproval;

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
    saveConversationMessages(activeId, messages, user.id);

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
    saveConversations(merged, user.id);
    setConversations(merged);
    // 故意不依赖 conversations；用 ref 读取最新值，指纹变化才重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesFingerprint, activeId, hydrated, user.id]);

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
    deleteConversationStorage(id, user.id);
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
    const errors: string[] = [];
    let acceptedCount = pendingFiles.length;
    let acceptedBytes = pendingFiles.reduce(
      (total, file) => total + estimateAttachmentDataUrlBytes(file.url),
      0,
    );
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const validationError = validateAttachment(f, acceptedCount, acceptedBytes);
      if (validationError) {
        errors.push(validationError);
        continue;
      }
      try {
        picked.push(await fileToDataUrl(f));
        acceptedCount += 1;
        acceptedBytes += f.size;
      } catch (error) {
        errors.push(
          `${f.name}：读取失败（${error instanceof Error ? error.message : String(error)}）。`,
        );
      }
    }
    if (picked.length > 0) setPendingFiles((prev) => [...prev, ...picked]);
    setAttachmentError(errors.length > 0 ? errors.join(" ") : null);
    // 清空 input，便于重复选择同一文件
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
    setAttachmentError(null);
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
    setAttachmentError(null);
  };

  const handleSuggestion = (text: string) => {
    if (isLoading) return;
    sendMessage({ text });
    sentConvoIdRef.current = activeId;
  };

  const [input, setInput] = useState("");
  const suggestions = useMemo(
    () => buildPersonalizedSuggestions(userProfile),
    [userProfile],
  );

  const openSettings = () => {
    setProfileDraft({
      age: userProfile.age?.toString() ?? "",
      major: userProfile.major,
    });
    setProfileError("");
    setSettingsOpen(true);
  };

  const commitUserProfile = () => {
    const normalized = normalizeUserProfile(profileDraft);
    if (!isCompleteUserProfile(normalized)) {
      setProfileError("请填写 10–100 岁之间的整数年龄和专业名称。");
      return false;
    }
    setUserProfile(normalized);
    setProfileDraft({ age: String(normalized.age), major: normalized.major });
    saveUserProfile(normalized, user.id);
    setProfileError("");
    setProfilePromptOpen(false);
    return true;
  };

  // ===== 渲染 =====

  if (showLanding) {
    return <LandingPage onEnter={handleEnter} />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <ConversationSidebar
        open={sidebarOpen}
        hydrated={hydrated}
        conversations={conversations}
        activeId={activeId}
        activeMessages={messages}
        expandedConversations={expandedConvos}
        agentEnabled={capabilities.agent}
        authorizedDirectories={authorizedDirs}
        storageScope={user.id}
        showAddDirectory={showAddDirectory}
        onNewConversation={startNewConversation}
        onSelectConversation={selectConversation}
        onRemoveConversation={removeConversation}
        onToggleConversation={toggleConvoExpanded}
        onScrollToMessage={scrollToMessage}
        onOpen={() => setSidebarOpen(true)}
        onClose={() => setSidebarOpen(false)}
        onToggleAddDirectory={() =>
          setShowAddDirectory((visible) => !visible)
        }
        onAllowDirectory={async (directory) => {
          setAuthorizedDirs(await addAuthorizedDirectory(directory));
          setShowAddDirectory(false);
        }}
        onRemoveDirectory={async (directory) => {
          setAuthorizedDirs(await removeAuthorizedDirectory(directory));
        }}
        onCancelAddDirectory={() => setShowAddDirectory(false)}
      />

      {/* 主聊天区 */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* 顶部导航栏 */}
        <header className="neu-raised bg-surface mx-3 mt-3 px-4 py-3 flex items-center gap-3 shrink-0 rounded-2xl">
          <div className="w-9 h-9 bg-primary-600 rounded-full flex items-center justify-center">
            <Logo size={32} color="#FFFFFF" accent="#8FC0FF" />
          </div>
          <div>
            <h1 className="font-semibold text-sm text-foreground">科大精灵</h1>
            <p className="text-xs text-foreground/60">在线 · 随时为你解答</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={handleManualExport}
              disabled={messages.length === 0 || isLoading}
              className="text-xs px-3 py-1.5 bg-white/20 hover:bg-white/30 rounded-md disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
              title="导出当前对话"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              导出
            </button>
            <button
              type="button"
              onClick={openSettings}
              className="w-8 h-8 bg-white/20 hover:bg-white/30 rounded-full flex items-center justify-center transition-colors"
              title="设置"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </header>

        <ChatTranscript
          messages={messages}
          suggestions={suggestions}
          profileLabel={
            isCompleteUserProfile(userProfile)
              ? `${userProfile.age} 岁 · ${userProfile.major}`
              : null
          }
          exportsByMessage={exportsByMessage}
          exportBusy={exportBusy}
          exportErrorsByMessage={exportErrorsByMessage}
          loading={isLoading}
          messageRefs={messageRefs}
          messagesEndRef={messagesEndRef}
          onSuggestion={handleSuggestion}
          onOpenSettings={openSettings}
          onApprovalResponse={(approvalId, approved) =>
            addToolApprovalResponse({
              id: approvalId,
              approved,
              reason: approved ? "用户在界面确认" : "用户拒绝",
            })
          }
        />

        <ChatComposer
          input={input}
          pendingFiles={pendingFiles}
          attachmentError={attachmentError}
          loading={isLoading}
          fileInputRef={fileInputRef}
          onInputChange={setInput}
          onFilePick={handleFilePick}
          onRemovePendingFile={removePendingFile}
          onSubmit={handleSubmit}
        />
      </main>

      <SettingsDrawer
        open={settingsOpen}
        user={user}
        controlsDisabled={capabilityControlsDisabled}
        capabilities={capabilities}
        profileDraft={profileDraft}
        profileError={profileError}
        darkMode={darkMode}
        themeColor={themeColor}
        onClose={() => setSettingsOpen(false)}
        onCapabilitiesChange={setCapabilities}
        onProfileDraftChange={setProfileDraft}
        onSaveProfile={commitUserProfile}
        onDarkModeChange={setDarkMode}
        onThemeColorChange={setThemeColor}
      />
      <UserProfilePrompt
        open={profilePromptOpen}
        draft={profileDraft}
        error={profileError}
        onDraftChange={setProfileDraft}
        onSave={commitUserProfile}
        onDismiss={() => {
          setProfileError("");
          setProfilePromptOpen(false);
        }}
      />
    </div>
  );
}
