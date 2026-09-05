"use client";

import type { UIMessage } from "ai";
import { useMemo } from "react";
import {
  loadConversationMessages,
  type ConversationSummary,
} from "../../lib/conversation-storage";
import { DirectoryAuthCard } from "./DirectoryAuthCard";

type QuestionNode = { id: string; text: string };

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("");
}

function questionNodes(messages: UIMessage[]): QuestionNode[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => ({ id: message.id, text: messageText(message).trim() }))
    .filter((node) => node.text.length > 0);
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const pad = (value: number) => String(value).padStart(2, "0");
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type ConversationSidebarProps = {
  open: boolean;
  hydrated: boolean;
  conversations: ConversationSummary[];
  activeId: string;
  activeMessages: UIMessage[];
  expandedConversations: Set<string>;
  agentEnabled: boolean;
  authorizedDirectories: string[];
  storageScope: string;
  showAddDirectory: boolean;
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  onRemoveConversation: (id: string) => void;
  onToggleConversation: (id: string) => void;
  onScrollToMessage: (messageId: string) => void;
  onOpen: () => void;
  onClose: () => void;
  onToggleAddDirectory: () => void;
  onAllowDirectory: (directory: string) => void | Promise<void>;
  onRemoveDirectory: (directory: string) => void | Promise<void>;
  onCancelAddDirectory: () => void;
};

export function ConversationSidebar({
  open,
  hydrated,
  conversations,
  activeId,
  activeMessages,
  expandedConversations,
  agentEnabled,
  authorizedDirectories,
  storageScope,
  showAddDirectory,
  onNewConversation,
  onSelectConversation,
  onRemoveConversation,
  onToggleConversation,
  onScrollToMessage,
  onOpen,
  onClose,
  onToggleAddDirectory,
  onAllowDirectory,
  onRemoveDirectory,
  onCancelAddDirectory,
}: ConversationSidebarProps) {
  // 历史会话索引仅在列表变化时读取一次；流式 token 更新不再触发 N 次 localStorage 读取。
  const storedQuestionNodes = useMemo(() => {
    const index = new Map<string, QuestionNode[]>();
    if (!hydrated) return index;
    for (const conversation of conversations) {
      if (conversation.id !== activeId) {
        index.set(
          conversation.id,
          questionNodes(loadConversationMessages(conversation.id, storageScope)),
        );
      }
    }
    return index;
  }, [activeId, conversations, hydrated, storageScope]);
  const activeQuestionNodes = questionNodes(activeMessages);

  return (
    <>
      <aside
        className={`${
          open ? "w-72" : "w-0"
        } shrink-0 transition-all duration-200 overflow-hidden bg-surface neu-raised flex flex-col`}
      >
        <div className="w-72 h-full flex flex-col">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground/80">历史会话</h2>
            <button
              type="button"
              onClick={onNewConversation}
              className="text-xs px-3 py-1.5 rounded-lg neu-card text-primary-600 hover:text-primary-500 transition-all"
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
            {conversations.map((conversation) => {
              const isActive = conversation.id === activeId;
              const isExpanded = expandedConversations.has(conversation.id);
              const nodes = isActive
                ? activeQuestionNodes
                : storedQuestionNodes.get(conversation.id) ?? [];
              return (
                <div
                  key={conversation.id}
                  className={`group border-b border-border transition-colors ${
                    isActive ? "bg-primary-50" : "hover:bg-muted"
                  }`}
                >
                  <div
                    onClick={() => onSelectConversation(conversation.id)}
                    className={`px-3 py-3 cursor-pointer flex items-start gap-2 ${
                      isActive ? "text-primary-600" : "text-foreground/80"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleConversation(conversation.id);
                      }}
                      className={`mt-0.5 w-4 h-4 flex items-center justify-center text-xs text-foreground/60 hover:text-foreground transition-transform ${
                        isExpanded ? "rotate-90" : ""
                      }`}
                      aria-label={isExpanded ? "收起" : "展开"}
                    >
                      ▶
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {conversation.title}
                      </div>
                      <div className="text-[11px] text-foreground/40 mt-0.5">
                        {formatTime(conversation.updatedAt)} · {nodes.length} 个问题
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemoveConversation(conversation.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-foreground/40 hover:text-danger text-xs px-1"
                      aria-label="删除会话"
                    >
                      ×
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="pb-2 pl-9 pr-3">
                      {nodes.length === 0 ? (
                        <div className="text-[11px] text-foreground/40 py-1">
                          暂无问题
                        </div>
                      ) : (
                        <div className="relative ml-2 pl-4 border-l-2 border-primary-100 space-y-1">
                          {nodes.map((node, index) => (
                            <button
                              key={node.id}
                              type="button"
                              onClick={() => {
                                if (!isActive) onSelectConversation(conversation.id);
                                setTimeout(() => onScrollToMessage(node.id), 50);
                              }}
                              className="group/node block w-full text-left text-xs text-foreground/80 hover:text-primary-600 hover:bg-primary-50 px-2 py-1.5 rounded transition-colors relative"
                              title={node.text}
                            >
                              <span className="absolute -left-[21px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-primary-400 ring-2 ring-white group-hover/node:bg-primary-600 transition-colors" />
                              <span className="truncate font-medium">
                                {index + 1}. {node.text.slice(0, 24)}
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
          {agentEnabled && (
            <div className="border-t border-border px-4 py-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-foreground/70">
                  🔐 授权目录
                </span>
                <button
                  type="button"
                  onClick={onToggleAddDirectory}
                  className="text-xs text-primary-600 hover:text-primary-500"
                >
                  {showAddDirectory ? "取消" : "+ 添加"}
                </button>
              </div>
              {authorizedDirectories.length === 0 ? (
                <p className="text-[11px] text-foreground/40">
                  未授权目录，AI 暂无法读取本地文件
                </p>
              ) : (
                <div className="max-h-28 space-y-1 overflow-y-auto">
                  {authorizedDirectories.map((directory) => (
                    <div
                      key={directory}
                      className="flex items-center gap-1 text-[11px] text-foreground/70"
                    >
                      <span className="flex-1 truncate" title={directory}>
                        {directory}
                      </span>
                      <button
                        type="button"
                        onClick={() => void onRemoveDirectory(directory)}
                        className="px-0.5 text-foreground/40 hover:text-danger"
                        aria-label={`移除授权目录 ${directory}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {showAddDirectory && (
                <DirectoryAuthCard
                  onAllow={onAllowDirectory}
                  onCancel={onCancelAddDirectory}
                />
              )}
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs text-foreground/60 border-t border-border hover:bg-muted"
          >
            收起侧栏
          </button>
        </div>
      </aside>

      {!open && (
        <button
          type="button"
          onClick={onOpen}
          className="absolute top-3 left-3 z-10 bg-surface border border-border rounded-md px-2 py-1 text-xs text-foreground/70 shadow-sm hover:bg-muted"
        >
          ☰ 展开
        </button>
      )}
    </>
  );
}
