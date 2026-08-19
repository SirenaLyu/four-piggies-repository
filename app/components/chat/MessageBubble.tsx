"use client";

/**
 * 单条消息气泡
 *
 * 头像 + 气泡（文件预览 + Markdown 正文）+ AI 回复下的导出文件卡片/加载提示。
 * 从 page.tsx 抽出，ref 通过 forwardRef 透传供时间轴滚动定位。
 */

import { forwardRef } from "react";
import type { UIMessage } from "ai";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { FilePreview } from "./FilePreview";
import { ExportFileCard } from "./ExportFileCard";
import { getMessageFiles, getMessageText } from "./message-utils";
import type { ExportFileDescriptor } from "../../lib/export";

export interface MessageBubbleProps {
  message: UIMessage;
  exportsForThis: ExportFileDescriptor[];
  isExportBusy: boolean;
}

export const MessageBubble = forwardRef<HTMLDivElement, MessageBubbleProps>(
  function MessageBubble({ message: m, exportsForThis, isExportBusy }, ref) {
    const text = getMessageText(m);
    const files = getMessageFiles(m);

    return (
      <div
        ref={ref}
        className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}
      >
        <div
          className={`flex ${m.role === "user" ? "justify-end" : "justify-start"} w-full`}
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
  },
);
