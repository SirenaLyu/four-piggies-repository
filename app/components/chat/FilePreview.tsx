"use client";

/**
 * 消息附件预览
 *
 * 图片直接渲染缩略图；其他类型渲染为带大小标注的下载链接。
 */

import type { FileUIPart } from "ai";
import {
  estimateDataUrlBytes,
  formatBytes,
  isImage,
} from "./message-utils";

export function FilePreview({
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
