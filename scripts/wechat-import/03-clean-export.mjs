// ============================================================================
// 03 · 清洗抓取结果并导出 Markdown（供 Dify 导入）
// ----------------------------------------------------------------------------
// 用法：node 03-clean-export.mjs [--account 公众号名]
// 输入：raw/*.json
// 输出：
//   output/公众号名/YYYY-MM-DD-标题.md   清洗后的单篇文章
//   output/index.json                   全部文章索引（04 脚本读取）
//
// 清洗策略：
// - HTML → 简化 Markdown（段落/标题/列表/表格/链接/加粗）
// - 丢弃图片（知识检索用不到，仅统计数量）
// - 删除正文尾部「引导关注/点赞/在看/二维码」类噪声段落，
//   正文中间的报名二维码等信息保留（避免误删有效内容）
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { load as cheerioLoad } from "cheerio";
import { OUTPUT_DIR, RAW_DIR, ensureDir, log, readJson, safeName, writeJson } from "./lib.mjs";

const args = process.argv.slice(2);
const accountArg = args.find((a) => a.startsWith("--account"))?.split("=")[1];

/** 尾部噪声段落模式：命中且位于正文末尾的段落会被删除 */
const NOISE_PATTERNS = [
  /长按.{0,6}(识别|扫描).{0,12}(二维码|关注)/,
  /(扫码|长按).{0,8}(关注|加群|入群|进群)/,
  /点击.{0,8}(关注|名片|星标|加星)/,
  /设为星标|添加星标|星标我们/,
  /(点赞|点个赞|点一下).{0,10}(在看|分享|转发|关注)/,
  /欢迎(关注|转发|分享|投稿|点赞|在看|点个)/,
  /感谢.{0,8}(阅读|观看|支持|关注)/,
  /(版权|原创).{0,20}(声明|所有|归.{0,10}所有)/,
  /如需转载.{0,30}/,
  /本文(来源|整理|编辑|作者|策划).{0,40}/,
  /^#?#? ?(阅读原文|查看原文|点击阅读)/,
  /下期再见|敬请期待|敬请关注/,
  /^图片来源.{0,30}$/,
  /^(编辑|摄影|文字|图片|校对|美编|排版|审核|统筹|监制|策划|执行编辑)[:：].{0,40}$/,
  /^（?(责任编辑|总编|主编|新媒体中心|融媒体中心|党委宣传部).{0,30}）?$/,
];

/** 去除所有空白字符，用于段落匹配 */
const compact = (s) => s.replace(/\s+/g, "");

/**
 * 把 #js_content 的 HTML 转成简化 Markdown。
 * 规则：标题转 #、段落换行、li 转 -、a 转 [文本](链接)、strong/b 转 **，其余标签剥掉。
 */
function htmlToMarkdown(html) {
  const $ = cheerioLoad(html);
  // 移除无用的内嵌样式脚本与 iframe
  $("script, style, iframe, noscript").remove();
  // 图片统计并移除
  const imgCount = $("img").length;
  $("img").remove();

  const lines = [];
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.type === "text") {
        const text = child.data.replace(/\s+/g, " ").trim();
        if (text) lines.push(text);
        continue;
      }
      if (child.type !== "tag") continue;
      const tag = child.tagName.toLowerCase();
      if (/^(p|section|div)$/.test(tag)) {
        // p 是语义块直接提取；section/div 可能是容器也可能直接装文本：
        // 内部存在块级子节点时递归下钻，否则按文本块处理
        const hasBlockChild = $(child).find("p, h1, h2, h3, h4, h5, h6, li, table, blockquote").length > 0;
        if (tag === "p" || !hasBlockChild) {
          const text = $(child).text().trim();
          if (text) lines.push(text);
        } else {
          walk(child);
        }
      } else if (/^h[1-6]$/.test(tag)) {
        const text = $(child).text().trim();
        if (text) lines.push(`${tag[1] === "1" ? "#" : "#".repeat(Number(tag[1]))} ${text}`);
      } else if (tag === "li") {
        const text = $(child).text().trim();
        if (text) lines.push(`- ${text}`);
      } else if (tag === "br") {
        lines.push("");
      } else if (tag === "table") {
        const rows = [];
        $(child).find("tr").each((_, tr) => {
          const cells = $(tr).find("th, td").map((__, td) => $(td).text().trim().replace(/\|/g, "\\|")).get();
          if (cells.length) rows.push(`| ${cells.join(" | ")} |`);
        });
        if (rows.length) {
          lines.push(rows[0]);
          lines.push(`| ${rows[0].split("|").slice(1, -1).map(() => "---").join(" | ")} |`);
          lines.push(...rows.slice(1));
        }
      } else if (tag === "blockquote") {
        const text = $(child).text().trim();
        if (text) lines.push(`> ${text}`);
      } else {
        walk(child); // 其他标签（含内联格式标签）递归处理
      }
    }
  };
  walk($("#js_content")[0] ?? $("body")[0]);

  return { markdown: lines.map((l) => l.trim()).filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n"), imgCount };
}

/** 删除正文末尾连续命中噪声模式的行（逐行判断，避免整篇误删） */
function stripTrailingNoise(markdown) {
  const lines = markdown.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let end = lines.length;
  while (end > 0) {
    const compactLine = compact(lines[end - 1]);
    if (compactLine.length > 0 && compactLine.length <= 120 && NOISE_PATTERNS.some((re) => re.test(compactLine))) {
      end--;
    } else {
      break;
    }
  }
  return lines.slice(0, end).join("\n");
}

/** 把发布时间统一成 YYYY-MM-DD（兼容 ISO“2026-08-24”与中文“2026年8月31日”“8月31日”） */
function normalizeDate(raw) {
  if (!raw) return "";
  const iso = raw.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const y = raw.match(/(20\d{2})/)?.[1] ?? "";
  const m = raw.match(/(\d{1,2})月/)?.[1] ?? "";
  const d = raw.match(/(\d{1,2})日/)?.[1] ?? "";
  if (!m || !d) return y ? `${y}` : "";
  return `${y || new Date().getFullYear()}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 文件名安全化并限制长度 */
function safeFileName(name) {
  return safeName(name).replace(/[#%&{}<>]/g, "").slice(0, 80);
}

async function main() {
  ensureDir(OUTPUT_DIR);
  const files = fs
    .readdirSync(RAW_DIR)
    .filter((f) => f.endsWith(".json") && (!accountArg || f === `${accountArg}.json`));

  if (files.length === 0) {
    log("03", "raw/ 目录为空，请先运行 node 02-fetch-articles.mjs");
    return;
  }

  const index = [];
  let totalArticles = 0;
  let totalImages = 0;

  for (const file of files) {
    const articles = readJson(path.join(RAW_DIR, file), []);
    const account = path.basename(file, ".json");
    const accountDir = path.join(OUTPUT_DIR, safeName(account));
    ensureDir(accountDir);

    let ok = 0;
    let skipped = 0;
    for (const article of articles) {
      if (!article.contentHtml) {
        skipped++; // 抓取失败的记录
        continue;
      }
      const { markdown, imgCount } = htmlToMarkdown(article.contentHtml);
      const cleaned = stripTrailingNoise(markdown);
      if (!cleaned) {
        skipped++;
        continue;
      }
      const date = normalizeDate(article.publishTime);
      const filePath = path.join(accountDir, `${date || "unknown"}-${safeFileName(article.title || article.url)}.md`);
      const header = [
        `> 公众号：${article.account || account}`,
        `> 标题：${article.title || ""}`,
        date ? `> 发布时间：${date}` : "",
        `> 原文链接：${article.url}`,
      ]
        .filter(Boolean)
        .join("\n");
      fs.writeFileSync(filePath, `${header}\n\n${cleaned}\n`, "utf8");

      index.push({ account: article.account || account, title: article.title, date, url: article.url, file: filePath });
      totalImages += imgCount;
      ok++;
    }
    totalArticles += ok;
    log("03", `「${account}」导出 ${ok} 篇（跳过 ${skipped}），丢弃图片 ${totalImages} 张`);
  }

  writeJson(path.join(OUTPUT_DIR, "index.json"), index);
  log("03", `清洗完成：共 ${totalArticles} 篇 → output/ 目录。下一步：node 04-import-dify.mjs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
