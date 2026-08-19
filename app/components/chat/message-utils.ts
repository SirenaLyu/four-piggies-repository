/**
 * 消息相关的纯函数工具 —— 文本/文件提取、格式化
 *
 * 被 page.tsx、ConversationSidebar、FilePreview 等组件共用。
 */

import type { FileUIPart, UIMessage } from "ai";

/** 提取消息的纯文本内容（合并全部 text parts） */
export function getMessageText(m: UIMessage): string {
  return m.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text?: string }).text ?? "")
    .join("");
}

/** 提取消息附带的文件 */
export function getMessageFiles(m: UIMessage): FileUIPart[] {
  return m.parts.filter((p) => p.type === "file") as FileUIPart[];
}

export function isImage(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 将 File 转为带 data URL 的 FileUIPart */
export function fileToDataUrl(file: File): Promise<FileUIPart> {
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

/** 时间戳 → "14:05"（当天）或 "8/19 14:05"（更早） */
export function formatTime(ts: number): string {
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

/** 估算 data URL 的原始字节数（base64 长度换算） */
export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const base64 = dataUrl.slice(comma + 1);
  return Math.floor((base64.length * 3) / 4);
}
