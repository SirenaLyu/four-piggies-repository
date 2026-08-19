"use client";

/**
 * 左侧历史会话侧栏
 *
 * 列表 + 展开时间轴 + 新建/删除，会话数据来自 localStorage。
 * 从 page.tsx 抽出的纯展示组件，状态与回调均由父组件传入。
 */

import type { ConversationSummary } from "./conversation-storage";
import { loadConversationMessages } from "./conversation-storage";
import { formatTime, getMessageText } from "./message-utils";

export interface ConversationSidebarProps {
  conversations: ConversationSummary[];
  activeId: string;
  hydrated: boolean;
  expandedConvos: Set<string>;
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  onRemoveConversation: (id: string) => void;
  onToggleExpanded: (id: string) => void;
  onScrollToMessage: (messageId: string) => void;
  onCollapse: () => void;
}

export function ConversationSidebar({
  conversations,
  activeId,
  hydrated,
  expandedConvos,
  onNewConversation,
  onSelectConversation,
  onRemoveConversation,
  onToggleExpanded,
  onScrollToMessage,
  onCollapse,
}: ConversationSidebarProps) {
  return (
    <div className="w-72 h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground/80">历史会话</h2>
        <button
          type="button"
          onClick={onNewConversation}
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
        {conversations.map((c) => (
          <ConversationItem
            key={c.id}
            convo={c}
            isActive={c.id === activeId}
            isExpanded={expandedConvos.has(c.id)}
            hydrated={hydrated}
            onSelect={() => onSelectConversation(c.id)}
            onRemove={() => onRemoveConversation(c.id)}
            onToggleExpanded={() => onToggleExpanded(c.id)}
            onScrollToMessage={onScrollToMessage}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={onCollapse}
        className="px-4 py-2 text-xs text-foreground/60 border-t border-border hover:bg-muted"
      >
        收起侧栏
      </button>
    </div>
  );
}

// ===== 单个会话条目（标题行 + 可展开的问题时间轴） =====

interface ConversationItemProps {
  convo: ConversationSummary;
  isActive: boolean;
  isExpanded: boolean;
  hydrated: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onToggleExpanded: () => void;
  onScrollToMessage: (messageId: string) => void;
}

function ConversationItem({
  convo,
  isActive,
  isExpanded,
  hydrated,
  onSelect,
  onRemove,
  onToggleExpanded,
  onScrollToMessage,
}: ConversationItemProps) {
  // 从 localStorage 读取该会话的用户问题节点（展开时展示时间轴）
  const userNodes = hydrated ? loadUserNodes(convo.id) : [];

  return (
    <div
      className={`group border-b border-border transition-colors ${
        isActive ? "bg-primary-50" : "hover:bg-muted"
      }`}
    >
      <div
        onClick={onSelect}
        className={`px-3 py-3 cursor-pointer flex items-start gap-2 ${
          isActive ? "text-primary-600" : "text-foreground/80"
        }`}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpanded();
          }}
          className={`mt-0.5 w-4 h-4 flex items-center justify-center text-xs text-foreground/60 hover:text-foreground transition-transform ${
            isExpanded ? "rotate-90" : ""
          }`}
          aria-label={isExpanded ? "收起" : "展开"}
        >
          ▶
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{convo.title}</div>
          <div className="text-[11px] text-foreground/40 mt-0.5">
            {formatTime(convo.updatedAt)} · {userNodes.length} 个问题
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
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
            <div className="text-[11px] text-foreground/40 py-1">暂无问题</div>
          ) : (
            <div className="relative ml-2 pl-4 border-l-2 border-primary-100 space-y-1">
              {userNodes.map((n, i) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    if (!isActive) onSelect();
                    // 切换会话后立即滚动可能未挂载，延迟一帧再尝试
                    setTimeout(() => onScrollToMessage(n.id), 50);
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
}

/** 读取某会话的全部用户问题节点（时间轴用） */
function loadUserNodes(convoId: string): Array<{ id: string; text: string }> {
  return loadConversationMessages(convoId)
    .filter((m) => m.role === "user")
    .map((m) => ({ id: m.id, text: getMessageText(m).trim() }))
    .filter((n) => n.text.length > 0);
}
