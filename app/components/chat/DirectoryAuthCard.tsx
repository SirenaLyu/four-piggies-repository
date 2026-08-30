"use client";

import { useState } from "react";

export function DirectoryAuthCard({
  onAllow,
  onCancel,
}: {
  onAllow: (dir: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const dir = value.trim();
    if (dir) onAllow(dir);
  };

  return (
    <div className="mt-2 rounded-md border border-blue-300 bg-blue-50 px-2.5 py-2">
      <div className="mb-1.5 text-[11px] font-semibold text-blue-800">🔐 添加授权目录</div>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          if (event.key === "Escape") onCancel();
        }}
        placeholder="输入目录绝对路径，如 C:\work"
        className="mb-1.5 w-full rounded border border-blue-300 bg-white px-2 py-1 text-[11px] outline-none focus:ring-2 focus:ring-blue-400"
      />
      <div className="flex gap-2">
        <button type="button" onClick={submit} disabled={!value.trim()} className="rounded bg-blue-600 px-2 py-0.5 text-[11px] text-white disabled:opacity-40">授权</button>
        <button type="button" onClick={onCancel} className="rounded border border-blue-300 bg-white px-2 py-0.5 text-[11px] text-blue-800">取消</button>
      </div>
    </div>
  );
}
