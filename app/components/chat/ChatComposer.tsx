"use client";

import type { FileUIPart } from "ai";
import type { ChangeEvent, FormEvent, RefObject } from "react";
import { ATTACHMENT_ACCEPT } from "../../lib/attachment-policy";

type ChatComposerProps = {
  input: string;
  pendingFiles: FileUIPart[];
  attachmentError: string | null;
  loading: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onInputChange: (value: string) => void;
  onFilePick: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemovePendingFile: (index: number) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function ChatComposer({
  input,
  pendingFiles,
  attachmentError,
  loading,
  fileInputRef,
  onInputChange,
  onFilePick,
  onRemovePendingFile,
  onSubmit,
}: ChatComposerProps) {
  return (
    <>
      {attachmentError && (
        <div
          role="alert"
          aria-live="polite"
          className="bg-danger/10 border-t border-danger/30 px-4 py-2 text-xs text-danger shrink-0"
        >
          {attachmentError}
        </div>
      )}
      {pendingFiles.length > 0 && (
        <div className="bg-surface border-t border-border px-4 py-2 flex flex-wrap gap-2 shrink-0">
          {pendingFiles.map((file, index) => (
            <div
              key={`${file.filename ?? "file"}-${index}`}
              className="relative flex items-center gap-2 bg-muted rounded-md px-2 py-1 pr-6 text-xs text-foreground/80"
            >
              {file.mediaType.startsWith("image/") && file.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={file.url}
                  alt={file.filename ?? ""}
                  className="w-8 h-8 object-cover rounded"
                />
              ) : (
                <span className="text-base">📄</span>
              )}
              <span className="max-w-[120px] truncate">{file.filename}</span>
              <button
                type="button"
                onClick={() => onRemovePendingFile(index)}
                className="absolute top-0 right-0 text-foreground/40 hover:text-danger px-1"
                aria-label="移除"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        onSubmit={onSubmit}
        className="bg-surface border-t border-border px-4 py-3 flex items-center gap-2 shrink-0"
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          onChange={onFilePick}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading}
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
          onChange={(event) => onInputChange(event.target.value)}
          placeholder="输入你的问题..."
          className="flex-1 neu-pressed bg-surface text-foreground placeholder:text-foreground/60 rounded-full px-4 py-2.5 text-sm outline-none transition-all"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || (!input.trim() && pendingFiles.length === 0)}
          className="w-10 h-10 bg-primary-600 rounded-full flex items-center justify-center text-white shrink-0 hover:bg-primary-500 hover:scale-105 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
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
    </>
  );
}
