// ============================================================================
// 05 · 公众号文章图片文字识别（OCR）
// ----------------------------------------------------------------------------
// 用法：node 05-ocr-images.mjs [--account 公众号名] [--model 模型名]
// 输入（两种模式自动适配）：
//   A. 流水线模式：output/index.json + raw/*.json（由 02/03 生成），
//      从正文 HTML 提取图片 URL → 下载 → OCR → 追加到 md 文末
//   B. md 模式：外部工具（如 wechatDownload）导出的 md 文件，
//      从 md 里提取图片引用（本地图片直接读，URL 带防盗链下载）→ OCR → 插到图片下方
// 输出：
//   images/                   图片缓存目录（按内容哈希命名）
//   ocr-log.json              OCR 幂等记录（已识别的图片不再重复调用）
//   output/**/*.md            回填识别文字
//
// 依赖环境变量（复用项目 .env.local）：
//   EMBEDDING_API_KEY / EMBEDDING_BASE_URL   硅基流动 key（兼容 OpenAI 格式）
//   OCR_MODEL                                 可选，覆盖模型名
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { load as cheerioLoad } from "cheerio";
import {
  OUTPUT_DIR,
  RAW_DIR,
  IMPORT_LOG,
  loadEnvLocal,
  log,
  mapLimit,
  readJson,
  sleep,
  writeJson,
  WECHAT_UA,
} from "./lib.mjs";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const accountArg = args.find((a) => a.startsWith("--account"))?.split("=")[1];
const concurrencyArg = args.find((a) => a.startsWith("--concurrency"))?.split("=")[1];
// 文章级并发（默认 2）：付费模型可提到 3~4 提速；免费模型若遇限流降为 1
const CONCURRENCY = concurrencyArg ? Number(concurrencyArg) : 2;

const env = loadEnvLocal();
// OCR 平台可独立配置（任意 OpenAI 兼容 API）：
//   优先级：系统环境变量 → .env.local 的 OCR_* → 硅基流动的 embedding 配置
const OCR_BASE_URL =
  process.env.OCR_BASE_URL?.replace(/\/$/, "") ||
  (env.OCR_BASE_URL || "").replace(/\/$/, "") ||
  (env.EMBEDDING_BASE_URL || "").replace(/\/$/, "") ||
  "https://api.siliconflow.cn/v1";
const OCR_API_KEY =
  process.env.OCR_API_KEY || env.OCR_API_KEY || env.EMBEDDING_API_KEY || "";
// 默认用硅基流动免费模型 PaddleOCR-VL-1.5（实测中文识别准确，零成本）；
// 识别质量不满意可 --model 或环境变量 OCR_MODEL 切换，如：
//   Qwen/Qwen3-VL-32B-Instruct   （输入 1 元/百万 token，识别更稳）
//   deepseek-ai/DeepSeek-OCR     （实测对 AI 渲染/部分截图识别不全，不推荐）
const OCR_MODEL = process.env.OCR_MODEL || "PaddlePaddle/PaddleOCR-VL-1.5";

if (!OCR_API_KEY) {
  console.error("缺少 OCR API key：请设置 OCR_API_KEY 环境变量，或确认项目根 .env.local 有 EMBEDDING_API_KEY");
  process.exit(1);
}

const IMAGES_DIR = path.join(path.dirname(IMPORT_LOG), "images");
const OCR_LOG = path.join(path.dirname(IMPORT_LOG), "ocr-log.json");
const OCRED = new Map(readJson(OCR_LOG, []));

// ocr-log 写入串行化（防多文章并发时互相覆盖丢记录）
let logWriteChain = Promise.resolve();
function persistOcrLog() {
  logWriteChain = logWriteChain.then(() => writeJson(OCR_LOG, [...OCRED.entries()]));
  return logWriteChain;
}

/** 识别 prompt：要求保留版面顺序、输出纯文本/Markdown */
const OCR_PROMPT =
  "这是一张微信公众号文章中的图片。请识别图片中的全部文字内容，按阅读顺序输出，保持段落和列表结构，只输出识别到的内容，不要添加任何解释。如果图片中没有文字，只输出「无文字」。注意：如果相同短语或句子在文中多次出现，只输出一次，严禁重复输出相同内容。";

// ---------------------------------------------------------------------------
// 复读/幻觉文本清洗（防模型输出退化）
// ---------------------------------------------------------------------------

/**
 * 压缩行内被高频重复的连续片段（重复 ≥5 次的 4~80 字符单元保留 1 次），
 * 循环处理直到收敛（存在多层嵌套重复时）。
 */
function compressRepetition(text) {
  if (text.length < 40) return text;
  let prev;
  do {
    prev = text;
    text = text.replace(/(.{4,80}?)\1{4,}/g, (m, unit) => unit);
  } while (text !== prev && text.length > 40);
  return text;
}

/**
 * 清洗 OCR 文本中的复读与模板幻觉：
 * 1. 字符级连续重复 → 压缩为一次；
 * 2. 句子模式级重复（如「1980年成立。1981年成立…」逐年编造）→ 压缩/丢弃；
 * 3. 空格分隔 token 序列幻觉（如日程表「10:00-10:30 10:35-10:40…」循环编造）→ 丢弃。
 */
function sanitizeOcrText(raw) {
  if (!raw) return raw;
  let text = compressRepetition(raw);
  const sentences = text.split(/(?<=[。！？!?；;])/);
  if (sentences.length >= 6) {
    const norm = (s) => s.replace(/\d+/g, "#");
    const count = new Map();
    for (const s of sentences) {
      const n = norm(s);
      count.set(n, (count.get(n) || 0) + 1);
    }
    const freq = [...count.entries()].filter(([, c]) => c >= 5).map(([n]) => n);
    if (freq.length > 0) {
      const repChars = sentences.filter((s) => freq.includes(norm(s))).join("").length;
      if (repChars / text.length >= 0.8) return ""; // 模板幻觉，整行丢弃
      const kept = new Set();
      text = sentences
        .filter((s) => {
          const n = norm(s);
          if (!freq.includes(n)) return true;
          if (kept.has(n)) return false;
          kept.add(n);
          return true;
        })
        .join("");
    }
  }
  // 空格分隔 token 序列幻觉：同一模式（数字→#）高频出现且占比高
  const tokens = text.split(/\s+/);
  if (tokens.length >= 12) {
    const tCount = new Map();
    for (const t of tokens) {
      const n = t.replace(/\d+/g, "#");
      tCount.set(n, (tCount.get(n) || 0) + 1);
    }
    const top = [...tCount.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 10 && top[1] / tokens.length >= 0.6) return "";
  }
  return text;
}

// ---------------------------------------------------------------------------
// 图片提取与下载
// ---------------------------------------------------------------------------

/** 从文章 HTML 中提取全部图片 URL（去重） */
function extractImageUrls(contentHtml) {
  const $ = cheerioLoad(contentHtml);
  const urls = [];
  $("img").each((_, img) => {
    const src = $(img).attr("src") || $(img).attr("data-src") || "";
    const clean = src.split("?")[0]; // 去掉签名参数，仅作去重键
    if (src.startsWith("http") && !urls.some((u) => u.split("?")[0] === clean)) {
      urls.push(src);
    }
  });
  return urls;
}

/** 从 Markdown 文本中提取图片引用，返回 [{ line, src }]（行号 0 起） */
export function extractImagesFromMarkdown(mdText) {
  const items = [];
  const lines = mdText.split("\n");
  const mdImgRe = /!\[[^\]]*\]\(\s*([^)\s]+)/g; // ![alt](src
  const htmlImgRe = /<img[^>]*src=["']([^"']+)["']/gi;
  lines.forEach((line, i) => {
    let m;
    mdImgRe.lastIndex = 0;
    while ((m = mdImgRe.exec(line))) {
      let src = m[1].trim();
      if (src.startsWith("<") && src.endsWith(">")) src = src.slice(1, -1); // <url> 形式
      if (src) items.push({ line: i, src });
    }
    htmlImgRe.lastIndex = 0;
    while ((m = htmlImgRe.exec(line))) {
      items.push({ line: i, src: m[1].trim() });
    }
  });
  return items;
}

/**
 * 解析图片引用为可识别来源：
 * URL → { kind: "url", value }；本地路径（相对 md 所在目录）→ { kind: "local", value }
 */
function resolveImageSource(src, mdFile) {
  if (/^https?:\/\//i.test(src)) return { kind: "url", value: src };
  const base = path.dirname(mdFile);
  const value = path.isAbsolute(src) ? src : path.resolve(base, src);
  return { kind: "local", value };
}

/** 下载图片到 images/ 缓存，返回本地路径；失败返回 null */
async function downloadImage(url) {
  const hash = crypto.createHash("md5").update(url.split("?")[0]).digest("hex");
  const ext = /\.(png|jpe?g|gif|webp)/i.test(url.split("?")[0])
    ? url.match(/\.(png|jpe?g|gif|webp)/i)[1].toLowerCase()
    : "jpg";
  const file = path.join(IMAGES_DIR, `${hash}.${ext === "jpeg" ? "jpg" : ext}`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;

  try {
    // 微信图片防盗链：必须带 Referer 与微信 UA 才能下载
    const res = await fetch(url, {
      headers: {
        Referer: "https://mp.weixin.qq.com/",
        "User-Agent": WECHAT_UA,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error("图片内容为空");
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    fs.writeFileSync(file, buf);
    return file;
  } catch (err) {
    log("05", `✗ 图片下载失败：${err.message} — ${url.slice(0, 80)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// OCR 识别
// ---------------------------------------------------------------------------

/** 调视觉模型识别图片文字（OpenAI 兼容 chat/completions） */
async function ocrImage(file) {
  const ext = path.extname(file).replace(".", "") || "jpg";
  const mime = ext === "jpg" ? "jpeg" : ext;
  const b64 = fs.readFileSync(file).toString("base64");
  const res = await fetch(`${OCR_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OCR_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OCR_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: OCR_PROMPT },
            { type: "image_url", image_url: { url: `data:image/${mime};base64,${b64}` } },
          ],
        },
      ],
      max_tokens: 3000,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}：${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim?.() ?? "";
}

/**
 * 识别单张图片（带缓存与幂等），返回 { file, text, cached? }
 * cached=true 表示命中缓存（未调用 API）。
 * source: { kind: "url", value } 或 { kind: "local", value }
 */
async function recognizeSource(source) {
  const key = source.kind === "url" ? source.value.split("?")[0] : source.value;
  const hit = OCRED.get(key);
  if (hit) return { ...hit, cached: true };

  // 取到本地文件：URL 需下载（防盗链），本地路径直接读
  let file = null;
  if (source.kind === "url") {
    file = await downloadImage(source.value);
  } else if (fs.existsSync(source.value)) {
    file = source.value;
  }
  if (!file) {
    const entry = { file: "", text: "", error: source.kind === "url" ? "下载失败" : "本地文件不存在" };
    log("05", `✗ ${entry.error}：${source.value.slice(0, 80)}`);
    return entry; // 失败不写缓存，重跑自动重试
  }
  try {
    const rawText = await ocrImage(file);
    const text = sanitizeOcrText(rawText); // 清洗复读/模板幻觉
    // 视为无文字的装饰图：不浪费后续检索空间
    const meaningful = text && text !== "无文字" && text.replace(/[#*\->\s]/g, "").length >= 4;
    const entry = { file, text: meaningful ? text : "", ts: new Date().toISOString() };
    OCRED.set(key, entry);
    await persistOcrLog();
    log("05", meaningful ? `✓ 识别 ${path.basename(file)}（${text.length} 字）` : `- 无文字 ${path.basename(file)}`);
    return entry;
  } catch (err) {
    const entry = { file, text: "", error: err.message };
    log("05", `✗ OCR 失败：${err.message} — ${path.basename(file)}`);
    return entry; // 失败不写缓存，重跑自动重试
  }
}

/** 兼容旧调用：按 URL 识别（HTML 模式） */
async function recognizeImage(url) {
  return recognizeSource({ kind: "url", value: url });
}

// ---------------------------------------------------------------------------
// 回填 Markdown
// ---------------------------------------------------------------------------

/** 把识别文字追加到 md 文末（HTML 模式） */
function appendOcrText(mdFile, imgTexts) {
  const existing = fs.readFileSync(mdFile, "utf8");
  if (existing.includes("【文中图片文字】")) return; // 已回填过
  const block = imgTexts
    .filter((t) => t.text)
    .map((t, i) => `（图片${i + 1}）${t.text}`)
    .join("\n\n");
  if (!block) return;
  fs.appendFileSync(mdFile, `\n\n---\n\n【文中图片文字】\n${block}\n`, "utf8");
  return block.length;
}

/**
 * 把识别文字插到对应图片引用下方（md 模式）：
 *   ![img](xxx.png)
 *   > 【图片文字】识别内容...
 * 幂等：图片行下一行已有标记则跳过。返回 { inserted, fixed }。
 * 同时修复既有标记行中的复读文本（模型输出退化产生的超长重复行）。
 */
function insertOcrText(mdFile, items) {
  const lines = fs.readFileSync(mdFile, "utf8").split("\n");
  const PREFIX = "> 【图片文字】";

  // ① 修复既有标记行的复读内容（行数不变，items 行号仍有效）
  let fixed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(PREFIX)) {
      const sanitized = sanitizeOcrText(lines[i].slice(PREFIX.length));
      if (sanitized !== lines[i].slice(PREFIX.length)) {
        // 整行被判定为模板幻觉时保留占位说明，避免行号变化
        lines[i] = sanitized ? PREFIX + sanitized : PREFIX + "（识别内容为重复模板，已自动清除）";
        fixed++;
      }
    }
  }

  // ② 从后往前插入新识别结果，避免行号偏移
  let inserted = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const { line, entry } = items[i];
    if (!entry?.text) continue;
    const next = (lines[line + 1] || "").trim();
    if (next.startsWith(PREFIX)) continue; // 已插入过
    lines.splice(line + 1, 0, `${PREFIX}${entry.text}`);
    inserted++;
  }
  if (fixed > 0 || inserted > 0) fs.writeFileSync(mdFile, lines.join("\n"), "utf8");
  return { inserted, fixed };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 扫描 output/ 目录下的全部 Markdown（按子目录名作为公众号名），
 * 用于外部工具（如 wechatDownload）导出的 md 文件直接 OCR，无需先跑 02/03。
 */
function scanMarkdownFiles() {
  const index = [];
  if (!fs.existsSync(OUTPUT_DIR)) return index;
  for (const entry of fs.readdirSync(OUTPUT_DIR)) {
    const dir = path.join(OUTPUT_DIR, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      index.push({ account: entry, title: path.basename(file, ".md"), date: "", url: "", file: path.join(dir, file) });
    }
  }
  return index;
}

async function main() {
  let index = readJson(path.join(OUTPUT_DIR, "index.json"), []);
  if (index.length === 0) {
    index = scanMarkdownFiles();
    if (index.length > 0) {
      log("05", `未找到 index.json，扫描 output/ 目录发现 ${index.length} 个 Markdown 文件（md 模式）`);
    }
  }
  if (index.length === 0) {
    log("05", "output/index.json 为空且 output/ 下没有 Markdown 文件，请先运行 node 03-clean-export.mjs 或把外部 md 放入 output/ 目录");
    return;
  }

  // 从 raw 数据按 url 匹配文章，拿到含图片的 contentHtml（流水线模式用）
  const rawByUrl = new Map();
  if (fs.existsSync(RAW_DIR)) {
    for (const file of fs.readdirSync(RAW_DIR).filter((f) => f.endsWith(".json"))) {
      for (const article of readJson(path.join(RAW_DIR, file), [])) {
        if (article.url && article.contentHtml) rawByUrl.set(article.url, article);
      }
    }
  }

  const targets = index.filter((a) => !accountArg || a.account === accountArg);
  if (targets.length === 0) {
    log("05", "没有可处理的文章（output/index.json 为空，或指定 --account 不存在）");
    return;
  }

  let totalImages = 0;
  let totalFilled = 0;
  let htmlMode = 0;
  let mdMode = 0;

  await mapLimit(targets, CONCURRENCY, async (article) => {
    const raw = rawByUrl.get(article.url);

    if (raw?.contentHtml) {
      // 流水线模式：从 HTML 提取图片 URL，识别后追加文末
      htmlMode++;
      const urls = extractImageUrls(raw.contentHtml);
      if (urls.length === 0) return;
      totalImages += urls.length;

      const imgTexts = [];
      for (const url of urls) {
        const entry = await recognizeImage(url);
        imgTexts.push(entry);
        if (!entry.cached) await sleep(500); // 仅新识别限速，缓存命中秒过
      }
      const appended = appendOcrText(article.file, imgTexts);
      if (appended) totalFilled++;
      log("05", `「${article.account}」${article.title?.slice(0, 30)}：图片 ${urls.length} 张，识别到文字 ${imgTexts.filter((t) => t.text).length} 张`);
      return;
    }

    // md 模式：外部工具导出的 md，从文件里提取图片引用，识别后插到图片下方
    if (!fs.existsSync(article.file)) return;
    mdMode++;
    const mdText = fs.readFileSync(article.file, "utf8");
    const refs = extractImagesFromMarkdown(mdText);
    // 即便本篇无图片引用，也执行一次修复（清理既有复读行）
    const { inserted: fixedOnly } = insertOcrText(article.file, []);
    if (refs.length === 0) {
      if (fixedOnly > 0) log("05", `「${article.account}」${article.title?.slice(0, 30)}：修复复读行 ${fixedOnly} 处`);
      return;
    }
    totalImages += refs.length;

    const items = [];
    for (const ref of refs) {
      const source = resolveImageSource(ref.src, article.file);
      const entry = await recognizeSource(source);
      items.push({ line: ref.line, entry });
      if (!entry.cached) await sleep(500); // 仅新识别限速，缓存命中秒过
    }
    const { inserted, fixed } = insertOcrText(article.file, items);
    if (inserted > 0) totalFilled++;
    log("05", `「${article.account}」${article.title?.slice(0, 30)}：图片 ${refs.length} 张，识别到文字 ${items.filter((i) => i.entry.text).length} 张，插入 ${inserted} 处${fixed > 0 ? `，修复复读 ${fixed} 处` : ""}`);
  });

  log("05", `OCR 完成：处理文章 ${targets.length} 篇（HTML 模式 ${htmlMode} / md 模式 ${mdMode}），图片 ${totalImages} 张，回填 ${totalFilled} 篇。`);
  log("05", `缓存与日志：${IMAGES_DIR}、${OCR_LOG}。下一步：node 04-import-dify.mjs（重跑会自动跳过已导入文档）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
