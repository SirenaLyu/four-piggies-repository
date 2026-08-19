"use client";

/**
 * AI 生成的导出文件卡片
 *
 * 展示文件图标/名称/格式，点击下载（docx/pdf 在浏览器端动态生成 Blob）。
 */

import { useState } from "react";
import { downloadExportFile, type ExportFileDescriptor } from "../../lib/export";

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

export function ExportFileCard({ file }: { file: ExportFileDescriptor }) {
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
