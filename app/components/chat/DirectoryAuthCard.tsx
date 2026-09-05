"use client";

import { useState } from "react";

export function DirectoryAuthCard({
  onAllow,
  onCancel,
}: {
  onAllow: (dir: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    const dir = value.trim();
    if (!dir || busy) return;
    setBusy(true);
    setError("");
    try {
      await onAllow(dir);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "目录授权失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-md border border-blue-300 bg-blue-50 px-2.5 py-2">
      <div className="mb-1.5 text-[11px] font-semibold text-blue-800">🔐 添加授权目录</div>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
          if (event.key === "Escape") onCancel();
        }}
        placeholder="输入目录绝对路径，如 C:\work"
        className="mb-1.5 w-full rounded border border-blue-300 bg-white px-2 py-1 text-[11px] outline-none focus:ring-2 focus:ring-blue-400"
      />
      <p className="mb-1.5 text-[10px] leading-relaxed text-blue-800/80">
        授权后，目录中的文件内容可能发送到你当前配置的模型 API。服务端仍会按账号权限和敏感文件规则复核。
      </p>
      {error && <p role="alert" className="mb-1.5 text-[10px] text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => void submit()} disabled={!value.trim() || busy} className="rounded bg-blue-600 px-2 py-0.5 text-[11px] text-white disabled:opacity-40">{busy ? "验证中…" : "授权"}</button>
        <button type="button" onClick={onCancel} className="rounded border border-blue-300 bg-white px-2 py-0.5 text-[11px] text-blue-800">取消</button>
      </div>
    </div>
  );
}
