"use client";

/**
 * 目录授权卡片（侧栏内联表单）
 *
 * 点击侧栏"授权目录 → + 添加"后展开，输入路径并确认。
 * 模型请求访问未授权目录时，会在聊天中提示用户路径，
 * 用户可复制到此处授权（聊天内无模型→UI 信号通道，授权入口统一在侧栏）。
 */

import { useState } from "react";

export interface DirectoryAuthCardProps {
  onAllow: (dir: string) => void;
  onCancel: () => void;
}

export function DirectoryAuthCard({ onAllow, onCancel }: DirectoryAuthCardProps) {
  const [value, setValue] = useState("");

  const submit = () => {
    const dir = value.trim();
    if (!dir) return;
    onAllow(dir);
  };

  return (
    <div className="mt-2 bg-blue-50 border border-blue-300 rounded-md px-2.5 py-2">
      <div className="text-[11px] font-semibold text-blue-800 mb-1.5">🔐 添加授权目录</div>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="输入目录绝对路径，如 C:\work"
        className="w-full text-[11px] bg-white border border-blue-300 rounded px-2 py-1 mb-1.5 outline-none focus:ring-2 focus:ring-blue-400"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!value.trim()}
          className="text-[11px] px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40"
        >
          授权
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] px-2 py-0.5 bg-white text-blue-800 border border-blue-300 rounded hover:bg-blue-100"
        >
          取消
        </button>
      </div>
    </div>
  );
}
