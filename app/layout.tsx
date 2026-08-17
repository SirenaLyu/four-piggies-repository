import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "校园AI助手",
    template: "%s · 校园AI助手",
  },
  description: "中科大校园智能助手，随时解答课程、地点、校园生活等各类问题",
  keywords: ["校园助手", "AI 问答", "中科大", "USTC", "课程查询"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <body className="h-full overflow-hidden" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
