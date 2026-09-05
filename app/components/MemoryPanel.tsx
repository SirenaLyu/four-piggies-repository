"use client";

import { useState } from "react";
import type { MemoryChange, UserMemory } from "../lib/memory";

export function MemoryPanel({ memory, busy, onChange }: {
  memory: UserMemory;
  busy: boolean;
  onChange: (change: MemoryChange) => Promise<boolean>;
}) {
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const submit = async () => {
    if (!content.trim() || busy) return;
    if (await onChange(editing ? { action: "update", id: editing, content } : { action: "add", content })) {
      setContent("");
      setEditing(null);
    }
  };
  return <section className="space-y-3">
    <h4 className="text-sm font-medium">我的记忆 · {memory.entries.length}/50</h4>
    <p className="text-xs leading-5 text-foreground/50">按账号保存，作为上下文发送给你配置的模型，用于后续对话。也可以对 AI 说“记住我喜欢简洁的回答”或“忘记这条偏好”，确认后生效。</p>
    {memory.entries.length === 0 && <p className="text-xs text-foreground/50">还没有添加其他记忆。</p>}
    <ul className="space-y-2">
      {memory.entries.map((entry) => <li key={entry.id} className="rounded-xl border border-border p-3">
        <p className="whitespace-pre-wrap break-words text-sm">{entry.content}</p>
        <div className="mt-2 flex gap-3 text-xs">
          <button type="button" disabled={busy} onClick={() => { setEditing(entry.id); setContent(entry.content); }} className="text-primary-600 disabled:opacity-50">编辑</button>
          <button type="button" disabled={busy} onClick={async () => { if (await onChange({ action: "delete", id: entry.id })) { if (editing === entry.id) { setEditing(null); setContent(""); } } }} className="text-danger disabled:opacity-50">删除</button>
        </div>
      </li>)}
    </ul>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="space-y-2">
      <label className="block text-xs" htmlFor="memory-content">{editing ? "编辑记忆" : "添加记忆"}</label>
      <input id="memory-content" value={content} onChange={(event) => setContent(event.target.value)} maxLength={500} disabled={busy} placeholder="例如：我正在学习 Python，喜欢结合例子讲解" className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm" />
      <div className="flex gap-3">
        <button disabled={busy || !content.trim()} className="rounded-lg bg-primary-600 px-3 py-2 text-xs text-white disabled:opacity-50">{busy ? "保存中…" : editing ? "保存修改" : "添加记忆"}</button>
        {editing && <button type="button" disabled={busy} onClick={() => { setEditing(null); setContent(""); }} className="text-xs">取消编辑</button>}
      </div>
    </form>
  </section>;
}
