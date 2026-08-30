"use client";

import { useState } from "react";

export function ToolApprovalCard({
  toolName,
  summary,
  onRespond,
}: {
  toolName: string;
  summary: string;
  onRespond: (approved: boolean) => void | PromiseLike<void>;
}) {
  const [busy, setBusy] = useState(false);
  const respond = async (approved: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await onRespond(approved);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 w-full max-w-md rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5">
      <div className="mb-1 text-xs font-semibold text-amber-800">
        {toolName === "execute_command" ? "⚠️ 执行命令确认" : "✏️ 写入文件确认"}
      </div>
      <pre className="mb-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded bg-white/60 px-2 py-1.5 text-[11px] text-amber-900">{summary}</pre>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => void respond(true)} className="rounded-md bg-amber-600 px-2.5 py-1 text-[11px] text-white disabled:opacity-50">允许执行</button>
        <button type="button" disabled={busy} onClick={() => void respond(false)} className="rounded-md border border-amber-400 bg-white px-2.5 py-1 text-[11px] text-amber-800 disabled:opacity-50">拒绝</button>
      </div>
    </div>
  );
}
