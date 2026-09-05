"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { SignedInUser } from "./AuthGate";

type ModelConfigState = {
  baseUrl: string;
  model: string;
  fallbackModel: string;
  apiKeyConfigured: boolean;
  source: "user" | "server";
};

export function ModelConfigPanel({ user }: { user: SignedInUser }) {
  const [config, setConfig] = useState<ModelConfigState | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [fallbackModel, setFallbackModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const applyConfig = (next: ModelConfigState) => {
    setConfig(next);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setFallbackModel(next.fallbackModel);
    setApiKey("");
  };

  useEffect(() => {
    let active = true;
    void fetch("/api/model-config", { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as ModelConfigState & { error?: string };
        if (!response.ok) throw new Error(data.error || "无法读取模型配置");
        if (active) applyConfig(data);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "读取失败");
      });
    return () => {
      active = false;
    };
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/model-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, model, fallbackModel, apiKey }),
      });
      const data = (await response.json().catch(() => ({}))) as ModelConfigState & {
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "保存失败");
      applyConfig(data);
      setMessage("个人模型配置已加密保存");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const restoreServerDefault = async () => {
    if (!window.confirm("确定删除个人 API 配置并恢复服务器默认配置吗？")) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/model-config", { method: "DELETE" });
      const data = (await response.json().catch(() => ({}))) as ModelConfigState & {
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "恢复失败");
      applyConfig(data);
      setMessage("已恢复服务器默认配置");
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "恢复失败");
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.reload();
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-foreground/70">账号与基座模型</div>
          <div className="mt-0.5 text-[11px] text-foreground/40">当前用户：{user.username}</div>
        </div>
        <button
          type="button"
          onClick={logout}
          className="rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground/60 hover:bg-muted"
        >
          退出登录
        </button>
      </div>

      {!config && !error ? (
        <p className="text-xs text-foreground/45">正在读取模型配置…</p>
      ) : (
        <form onSubmit={save} className="space-y-2.5">
          <label className="block">
            <span className="mb-1 block text-[11px] text-foreground/55">OpenAI 兼容 API URL</span>
            <input
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              required
              placeholder="https://api.deepseek.com"
              className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-xs outline-none focus:border-primary-400"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-foreground/55">模型名称</span>
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                required
                placeholder="deepseek-chat"
                className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-xs outline-none focus:border-primary-400"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-foreground/55">备用模型（可选）</span>
              <input
                value={fallbackModel}
                onChange={(event) => setFallbackModel(event.target.value)}
                placeholder="留空则同主模型"
                className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-xs outline-none focus:border-primary-400"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-[11px] text-foreground/55">API Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="new-password"
              placeholder={config?.apiKeyConfigured ? "已配置；留空表示不更换" : "请输入 API Key"}
              className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-xs outline-none focus:border-primary-400"
            />
          </label>
          <p className="text-[11px] leading-4 text-foreground/40">
            Key 只发送到本站服务端并加密落盘，不会写入浏览器存储或再次回传。
            当前使用{config?.source === "user" ? "个人配置" : "服务器默认配置"}。
          </p>
          {error && <p className="text-[11px] text-danger">{error}</p>}
          {message && <p className="text-[11px] text-green-600">{message}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="flex-1 rounded-md bg-primary-600 px-3 py-2 text-xs text-white hover:bg-primary-500 disabled:opacity-60"
            >
              {busy ? "处理中…" : "保存个人配置"}
            </button>
            {config?.source === "user" && (
              <button
                type="button"
                disabled={busy}
                onClick={restoreServerDefault}
                className="rounded-md border border-border px-3 py-2 text-xs text-foreground/60 hover:bg-muted disabled:opacity-60"
              >
                恢复默认
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
