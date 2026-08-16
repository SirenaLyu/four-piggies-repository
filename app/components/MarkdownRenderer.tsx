"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import React, { useState, type ComponentPropsWithoutRef } from "react";
import { downloadTextFile } from "../lib/export";
import { languageToExtension } from "../lib/markdown";

type MarkdownRendererProps = {
  content: string;
  /** 用户气泡里的 markdown 使用更紧凑的样式（白字蓝底） */
  variant?: "user" | "assistant";
};

export function MarkdownRenderer({ content, variant = "assistant" }: MarkdownRendererProps) {
  const isUser = variant === "user";

  return (
    <div
      className={
        isUser
          ? "text-sm leading-relaxed [&_a]:underline [&_a]:text-blue-100 [&_code]:bg-white/20 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.85em] [&_code]:font-mono [&_pre]:bg-white/10 [&_pre]:text-white [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:my-2"
          : "text-sm leading-relaxed text-gray-800 [&_p]:my-1.5 first:[&_p]:mt-0 last:[&_p]:mb-0 [&_a]:text-blue-600 [&_a]:underline [&_a:hover]:text-blue-800 [&_strong]:font-semibold [&_strong]:text-gray-900 [&_em]:italic [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_blockquote]:border-l-2 [&_blockquote]:border-gray-300 [&_blockquote]:pl-3 [&_blockquote]:text-gray-600 [&_blockquote]:my-2 [&_h1]:text-base [&_h1]:font-bold [&_h1]:mt-2 [&_h1]:mb-1.5 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-1 [&_h4]:text-sm [&_h4]:font-semibold [&_h4]:mt-1.5 [&_h4]:mb-0.5 [&_hr]:my-3 [&_hr]:border-gray-200 [&_hr]:border-t [&_code]:bg-gray-100 [&_code]:text-gray-800 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.85em] [&_code]:font-mono [&_code]:border [&_code]:border-gray-200 [&_table]:border-collapse [&_table]:my-2 [&_table]:w-auto [&_table]:max-w-full [&_th]:border [&_th]:border-gray-300 [&_th]:bg-gray-100 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_td]:border [&_td]:border-gray-300 [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:text-xs [&_tr:nth-child(even)]:bg-gray-50 [&_pre]:my-2"
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 代码块（pre > code）和内联代码区分渲染
          pre({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
            return (
              <CodeBlockWrapper {...props}>{children}</CodeBlockWrapper>
            );
          },
          code({ className, children, ...props }: ComponentPropsWithoutRef<"code">) {
            // react-markdown 给 fenced code block 的 <code> 加 className="language-xxx"
            const match = /language-(\w+)/.exec(className || "");
            const text = String(children).replace(/\n$/, "");
            // 有 className 且不含换行 → 内联代码；否则由 <pre> 包装处理
            if (!match && !text.includes("\n")) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          // 表格水平滚动容器
          table({ children, ...props }: ComponentPropsWithoutRef<"table">) {
            return (
              <div className="overflow-x-auto my-2">
                <table {...props}>{children}</table>
              </div>
            );
          },
          // 链接新窗口打开
          a({ children, ...props }: ComponentPropsWithoutRef<"a">) {
            return (
              <a target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// 代码块包装器：检测语言、加复制和下载按钮
function CodeBlockWrapper({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const [copied, setCopied] = useState(false);

  // 从子 <code> 的 className 提取语言
  let language = "text";
  let codeText = "";
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child)) {
      const childProps = child.props as { className?: string; children?: unknown };
      const match = /language-(\w+)/.exec(childProps.className || "");
      if (match) language = match[1];
      if (typeof childProps.children === "string") {
        codeText = childProps.children.replace(/\n$/, "");
      } else if (Array.isArray(childProps.children)) {
        codeText = childProps.children
          .map((c) => (typeof c === "string" ? c : ""))
          .join("")
          .replace(/\n$/, "");
      }
    }
  });

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用，静默失败
    }
  };

  const handleDownload = () => {
    downloadTextFile(codeText, `code.${languageToExtension(language)}`);
  };

  return (
    <div className="relative group/code my-2">
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-700 text-gray-200 text-[11px] rounded-t-lg">
        <span className="font-mono">{language}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="text-[11px] px-1.5 py-0.5 hover:bg-gray-600 rounded transition-colors"
            aria-label="复制代码"
          >
            {copied ? "已复制" : "复制"}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="text-[11px] px-1.5 py-0.5 hover:bg-gray-600 rounded transition-colors"
            aria-label="下载代码"
          >
            下载
          </button>
        </div>
      </div>
      <pre
        {...props}
        className="bg-gray-900 text-gray-100 p-3 rounded-b-lg overflow-x-auto text-[13px] leading-relaxed !my-0"
      >
        {children}
      </pre>
    </div>
  );
}
