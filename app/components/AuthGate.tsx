"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Logo } from "./Logo";

export type SignedInUser = {
  id: string;
  username: string;
  createdAt: number;
};

type SessionPayload = {
  authenticated: boolean;
  user?: SignedInUser;
  registrationAllowed?: boolean;
};

export function AuthGate({
  children,
}: {
  children: (user: SignedInUser) => ReactNode;
}) {
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [registrationAllowed, setRegistrationAllowed] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/session", { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as SessionPayload;
        if (!active) return;
        setRegistrationAllowed(Boolean(data.registrationAllowed));
        if (response.ok && data.user) setUser(data.user);
        else if (data.registrationAllowed) setMode("register");
      })
      .catch(() => {
        if (active) setError("无法连接登录服务，请稍后重试");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        user?: SignedInUser;
        error?: string;
      };
      if (!response.ok || !data.user) {
        throw new Error(data.error || (mode === "login" ? "登录失败" : "注册失败"));
      }
      setUser(data.user);
      setPassword("");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <div className="text-sm text-foreground/50">正在检查登录状态…</div>
      </main>
    );
  }
  if (user) return <>{children(user)}</>;

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-5 py-10 text-foreground">
      <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-primary-200/40 blur-3xl" />
      <div className="absolute -bottom-24 -right-24 h-80 w-80 rounded-full bg-primary-100/50 blur-3xl" />
      <section className="neu-raised relative z-10 w-full max-w-md rounded-3xl bg-surface p-7 sm:p-9">
        <div className="mb-7 flex flex-col items-center text-center">
          <Logo size={58} />
          <h1 className="mt-4 text-2xl font-bold">欢迎使用科大精灵</h1>
          <p className="mt-2 text-sm leading-6 text-foreground/55">
            登录后，会话与个人模型配置将按账号隔离。
          </p>
        </div>

        {registrationAllowed && (
          <div className="mb-5 grid grid-cols-2 rounded-xl bg-muted p-1">
            {(["login", "register"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => {
                  setMode(item);
                  setError("");
                }}
                className={`rounded-lg py-2 text-sm transition-colors ${
                  mode === item
                    ? "bg-surface font-medium text-primary-600 shadow-sm"
                    : "text-foreground/50"
                }`}
              >
                {item === "login" ? "登录" : "创建账号"}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground/65">用户名</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              maxLength={32}
              required
              className="w-full rounded-xl border border-border bg-muted px-4 py-3 text-sm outline-none transition focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
              placeholder="3–32 个字符"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground/65">密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={8}
              maxLength={128}
              required
              className="w-full rounded-xl border border-border bg-muted px-4 py-3 text-sm outline-none transition focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
              placeholder={mode === "register" ? "至少 8 位，包含字母和数字" : "请输入密码"}
            />
          </label>
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-danger">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-primary-600 py-3 text-sm font-medium text-white transition hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "处理中…" : mode === "login" ? "登录" : "创建并登录"}
          </button>
        </form>

        <p className="mt-5 text-center text-[11px] leading-5 text-foreground/40">
          首位用户可直接创建账号；后续注册由服务器配置控制。
        </p>
      </section>
    </main>
  );
}
