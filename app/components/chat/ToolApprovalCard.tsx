"use client";

/**
 * 危险工具确认卡片
 *
 * 渲染在 AI 消息内（对应 tool-approval-request part）。
 * 用户允许/拒绝后调用 onRespond 回传 approval response。
 */

import { useState } from "react";

export interface ToolApprovalCardProps {
  toolName: string;
  summary: string;
  onRespond: (approved: boolean) => void | Promise<void>;
}

export function ToolApprovalCard({ toolName, summary, onRespond }: ToolApprovalCardProps) {
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

  const isExec = toolName === "execute_command";
  return (
    <div className="mt-2 w-full max-w-md bg-amber-50 border border-amber-300 rounded-lg px-3 py-2.5">
      <div className="text-xs font-semibold text-amber-800 mb-1">
        {isExec ? "⚠️ 执行命令确认" : "✏️ 写入文件确认"}
      </div>
      <pre className="text-[11px] text-amber-900 whitespace-pre-wrap break-all bg-white/60 rounded px-2 py-1.5 mb-2 max-h-40 overflow-y-auto">
        {summary}
      </pre>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void respond(true)}
          className="text-[11px] px-2.5 py-1 bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-50"
        >
          允许执行
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void respond(false)}
          className="text-[11px] px-2.5 py-1 bg-white text-amber-800 border border-amber-400 rounded-md hover:bg-amber-100 disabled:opacity-50"
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
