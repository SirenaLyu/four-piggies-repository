import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "科大精灵",
    template: "%s · 科大精灵",
  },
  description: "科大精灵，随时解答课程、地点、校园生活等各类问题",
  keywords: ["科大精灵", "AI 问答", "中科大", "USTC", "课程查询"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){var t=localStorage.getItem('campus-dark-mode');if(t==='dark')document.documentElement.setAttribute('data-theme','dark');else if(t==='light')document.documentElement.setAttribute('data-theme','light');var c=localStorage.getItem('campus-theme-color');if(c)document.documentElement.setAttribute('data-theme-color',c)})()` }} />
      </head>
      <body className="h-full overflow-hidden" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
