"use client";

import { useEffect } from "react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ui] 页面渲染失败", error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <section className="neu-raised max-w-md rounded-2xl bg-surface p-8 text-center">
        <h1 className="text-lg font-semibold">页面暂时无法显示</h1>
        <p className="mt-3 text-sm text-foreground/60">
          本地状态或组件加载出现异常，可以尝试重新加载当前界面。
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-6 rounded-lg bg-primary-600 px-4 py-2 text-sm text-white hover:bg-primary-500"
        >
          重新加载
        </button>
      </section>
    </main>
  );
}
