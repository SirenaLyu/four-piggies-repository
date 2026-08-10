/**
 * 生成《校园AI助手功能与使用指南》PDF
 *
 * 流程：读 docs/AI助手功能与使用指南.md → marked 转 HTML → 套页面模板
 *      → puppeteer-core 用系统 Chrome 渲染并打印为 PDF → 输出到 F:\26Spring\12V-FoT\
 *
 * 用法：npm run gen-doc
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { existsSync } from "node:fs";
import { marked } from "marked";
import puppeteer from "puppeteer-core";

// ===== 配置 =====

const PROJECT_ROOT = path.resolve(__dirname, "..");
const MD_PATH = path.join(PROJECT_ROOT, "docs", "AI助手功能与使用指南.md");
const OUTPUT_DIR = "F:\\26Spring\\12V-FoT";
const OUTPUT_FILENAME = "校园AI助手功能与使用指南.pdf";
const OUTPUT_PATH = path.join(OUTPUT_DIR, OUTPUT_FILENAME);

// Chrome / Edge 候选路径（按优先级）
const BROWSER_CANDIDATES: string[] = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  process.env.CHROME_PATH ?? "",
].filter((p) => p.length > 0 && existsSync(p));

// ===== HTML 模板 =====

const HTML_TEMPLATE = (bodyHtml: string) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>校园AI助手 功能与使用指南</title>
<style>
@page {
  size: A4;
  margin: 20mm 15mm;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
}
body {
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC",
               "Source Han Sans SC", "SimHei", sans-serif;
  font-size: 12pt;
  line-height: 1.75;
  color: #1f2937;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
h1 {
  font-size: 22pt;
  color: #1e3a8a;
  border-bottom: 3px solid #2563eb;
  padding-bottom: 10px;
  margin-top: 0;
  margin-bottom: 20px;
  page-break-after: avoid;
}
h2 {
  font-size: 16pt;
  color: #1e40af;
  margin-top: 28px;
  margin-bottom: 12px;
  border-left: 4px solid #2563eb;
  padding-left: 10px;
  page-break-after: avoid;
}
h3 {
  font-size: 13pt;
  color: #1e3a8a;
  margin-top: 20px;
  margin-bottom: 8px;
  page-break-after: avoid;
}
h4 {
  font-size: 12pt;
  color: #374151;
  margin-top: 16px;
  margin-bottom: 6px;
  page-break-after: avoid;
}
p {
  margin: 8px 0;
}
strong {
  font-weight: 700;
  color: #111827;
}
em { font-style: italic; }
a {
  color: #2563eb;
  text-decoration: none;
}
a:hover { text-decoration: underline; }
ul, ol {
  padding-left: 24px;
  margin: 8px 0;
}
li {
  margin: 4px 0;
}
code {
  background: #f3f4f6;
  color: #be185d;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: "Consolas", "Source Code Pro", "Courier New", monospace;
  font-size: 10.5pt;
  border: 1px solid #e5e7eb;
}
pre {
  background: #1f2937;
  color: #f3f4f6;
  padding: 14px 16px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 10pt;
  line-height: 1.5;
  margin: 12px 0;
  page-break-inside: avoid;
}
pre code {
  background: transparent;
  color: inherit;
  padding: 0;
  border: none;
  font-size: inherit;
}
table {
  border-collapse: collapse;
  width: 100%;
  margin: 12px 0;
  page-break-inside: avoid;
  font-size: 11pt;
}
th, td {
  border: 1px solid #d1d5db;
  padding: 8px 12px;
  text-align: left;
}
th {
  background: #e5e7eb;
  font-weight: 700;
  color: #1f2937;
}
tr:nth-child(even) td {
  background: #f9fafb;
}
blockquote {
  border-left: 4px solid #93c5fd;
  padding: 8px 16px;
  color: #4b5563;
  margin: 12px 0;
  background: #f0f9ff;
  border-radius: 0 4px 4px 0;
}
hr {
  border: none;
  border-top: 1px solid #e5e7eb;
  margin: 24px 0;
}
/* 表情/emoji 在 Chromium 默认渲染正常，无需特殊处理 */
/* 首页标题区不加分页 */
h1 + p, h1 + blockquote { page-break-before: avoid; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;

// ===== 主流程 =====

async function main() {
  console.log("[1/5] 读取 Markdown 源文件:", MD_PATH);
  const md = await fs.readFile(MD_PATH, "utf-8");
  console.log(`      共 ${md.length} 字符`);

  console.log("[2/5] 转换 Markdown → HTML");
  marked.setOptions({ gfm: true, breaks: false });
  const bodyHtml = await marked.parse(md);

  console.log("[3/5] 检测系统浏览器");
  if (BROWSER_CANDIDATES.length === 0) {
    throw new Error(
      "未找到 Chrome 或 Edge。请设置 CHROME_PATH 环境变量指向 chrome.exe 或 msedge.exe",
    );
  }
  const executablePath = BROWSER_CANDIDATES[0];
  console.log("      使用:", executablePath);

  console.log("[4/5] 启动浏览器并生成 PDF");
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--font-render-hinting=none",
    ],
  });
  try {
    const page = await browser.newPage();
    const html = HTML_TEMPLATE(bodyHtml);
    await page.setContent(html, { waitUntil: "load", timeout: 60000 });
    // 等待字体加载完成
    await page.evaluateHandle("document.fonts.ready");
    // 额外等待 500ms 确保布局稳定
    await new Promise((r) => setTimeout(r, 500));
    // 确保字体加载完成
    await page.evaluateHandle("document.fonts.ready");
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await page.pdf({
      path: OUTPUT_PATH,
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
      preferCSSPageSize: true,
    });
  } finally {
    await browser.close();
  }

  console.log("[5/5] 完成！");
  console.log(`      输出: ${OUTPUT_PATH}`);
  const stat = await fs.stat(OUTPUT_PATH);
  console.log(`      大小: ${(stat.size / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error("生成失败:", err);
  process.exit(1);
});
