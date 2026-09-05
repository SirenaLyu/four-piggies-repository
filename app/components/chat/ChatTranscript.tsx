"use client";
import { SourceCards } from "./SourceCards";

import type { UIMessage } from "ai";
import type { RefObject } from "react";
import type { ExportFileDescriptor } from "../../lib/export";
import { Logo } from "../Logo";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { ExportFileCard } from "./ExportFileCard";
import { FilePreview } from "./FilePreview";
import { ToolApprovalCard } from "./ToolApprovalCard";
import {
  getPendingApprovals,
  summarizeApproval,
} from "./approval-parts";

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("");
}

type ChatTranscriptProps = {
  messages: UIMessage[];
  suggestions: Array<{ text: string; color: string }>;
  profileLabel: string | null;
  memories: Array<{ id: string; content: string }>;
  exportsByMessage: Record<string, ExportFileDescriptor[]>;
  exportBusy: Set<string>;
  exportErrorsByMessage: Record<string, string>;
  loading: boolean;
  messageRefs: RefObject<Map<string, HTMLDivElement>>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  onSuggestion: (text: string) => void;
  onOpenSettings: () => void;
  onApprovalResponse: (approvalId: string, approved: boolean) => void;
};

export function ChatTranscript({
  messages,
  suggestions,
  profileLabel,
  memories,
  exportsByMessage,
  exportBusy,
  exportErrorsByMessage,
  loading,
  messageRefs,
  messagesEndRef,
  onSuggestion,
  onOpenSettings,
  onApprovalResponse,
}: ChatTranscriptProps) {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
      {messages.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full select-none">
          <Logo size={64} className="mb-4" />
          <h2 className="text-xl font-semibold text-foreground">
            你好！我是科大精灵
          </h2>
          <p className="text-sm text-foreground/60 mt-2">
            有什么关于学校的问题都可以问我
          </p>
          {profileLabel && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="mt-3 rounded-full border border-primary-200 bg-primary-50 px-3 py-1 text-xs text-primary-700 transition-colors hover:bg-primary-100"
            >
              已按 {profileLabel} 定制
            </button>
          )}
          <div className="columns-2 gap-3 mt-8 w-[430px] max-w-full">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.text}
                type="button"
                onClick={() => onSuggestion(suggestion.text)}
                className="neu-card w-full mb-3 px-5 py-4 text-sm font-medium text-foreground/85 text-left break-words rounded-2xl"
              >
                {suggestion.text}
              </button>
            ))}
          </div>
        </div>
      )}

      {messages.map((message) => {
        const text = messageText(message);
        const files = message.parts.filter((part) => part.type === "file");
        const messageExports = exportsByMessage[message.id] ?? [];
        const isExportBusy = exportBusy.has(message.id);
        const exportError = exportErrorsByMessage[message.id];
        const pendingApprovals = getPendingApprovals(message);
        const fromUser = message.role === "user";
        return (
          <div
            key={message.id}
            data-chat-message={message.id}
            ref={(element) => {
              if (element) messageRefs.current.set(message.id, element);
              else messageRefs.current.delete(message.id);
            }}
            className={`flex flex-col message-in ${
              fromUser ? "items-end" : "items-start"
            }`}
          >
            <div
              className={`flex ${
                fromUser ? "justify-end" : "justify-start"
              } w-full`}
            >
              {!fromUser && (
                <div className="w-8 h-8 bg-primary-500 rounded-full flex items-center justify-center text-white text-sm mr-2 shrink-0">
                  <Logo size={20} color="#FFFFFF" accent="#8FC0FF" />
                </div>
              )}

              <div
                className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed break-words ${
                  fromUser
                    ? "bg-primary-600 text-white rounded-br-md"
                    : "neu-raised bg-surface text-foreground rounded-bl-md"
                }`}
              >
                {files.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {files.map((file, index) => (
                      <FilePreview
                        key={`${file.filename ?? "file"}-${index}`}
                        file={file}
                        fromUser={fromUser}
                      />
                    ))}
                  </div>
                )}
                {text && (
                  <MarkdownRenderer
                    content={text}
                    variant={fromUser ? "user" : "assistant"}
                  />
                )}
              </div>

              {fromUser && (
                <div className="w-8 h-8 bg-ink-400 rounded-full flex items-center justify-center text-white text-sm ml-2 shrink-0">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </div>
              )}
            </div>

            {!fromUser && <SourceCards parts={message.parts} />}
            {!fromUser && pendingApprovals.length > 0 && (
              <div className="ml-10 mt-2 flex flex-col gap-2">
                {pendingApprovals.map((approval) => (
                  <ToolApprovalCard
                    key={approval.approvalId || approval.toolCallId}
                    toolName={approval.toolName}
                    summary={summarizeApproval(approval, memories)}
                    onRespond={(approved) =>
                      onApprovalResponse(approval.approvalId, approved)
                    }
                  />
                ))}
              </div>
            )}

            {!fromUser && messageExports.length > 0 && (
              <div className="ml-10 mt-2 flex flex-wrap gap-2">
                {messageExports.map((file, index) => (
                  <ExportFileCard
                    key={`${file.filename}-${index}`}
                    file={file}
                  />
                ))}
              </div>
            )}

            {!fromUser && isExportBusy && messageExports.length === 0 && (
              <div className="ml-10 mt-2 text-[11px] text-foreground/40 flex items-center gap-1.5">
                <span className="w-2 h-2 bg-primary-400 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-2 h-2 bg-primary-400 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-2 h-2 bg-primary-400 rounded-full animate-bounce [animation-delay:300ms]" />
                <span className="ml-1">正在生成可导出文件…</span>
              </div>
            )}

            {!fromUser && exportError && (
              <div
                role="alert"
                className="ml-10 mt-2 max-w-md rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger"
              >
                导出失败：{exportError}
              </div>
            )}
          </div>
        );
      })}

      {loading && messages.at(-1)?.role === "user" && (
        <div className="flex justify-start message-in">
          <div className="w-8 h-8 bg-primary-500 rounded-full flex items-center justify-center text-white text-sm mr-2 shrink-0">
            <Logo size={20} color="#FFFFFF" accent="#8FC0FF" />
          </div>
          <div className="bg-surface px-4 py-3 rounded-2xl rounded-bl-md shadow-sm flex items-center gap-2">
            <div className="flex gap-1 mr-1">
              <span className="w-1.5 h-1.5 bg-primary-400 rounded-full thinking-dot [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 bg-primary-400 rounded-full thinking-dot [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 bg-primary-400 rounded-full thinking-dot [animation-delay:300ms]" />
            </div>
            <span className="text-xs text-foreground/60">AI 正在处理…</span>
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}
