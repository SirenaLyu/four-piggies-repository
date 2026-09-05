// ============================================================================
// 02 · 批量抓取微信公众号文章正文（无需登录，断点续传）
// ----------------------------------------------------------------------------
// 用法：node 02-fetch-articles.mjs [--account 公众号名] [--limit 20]
// 输入：links/*.txt（每行一个文章 URL，可带 \t 标题 \t 日期）
// 输出：raw/公众号名.json（增量追加；已抓取的 URL 自动跳过）
//
// 说明：
// - 微信文章页 mp.weixin.qq.com/s/xxx 无需登录即可公开访问（个别设置了
//   仅关注可见的文章会失败，脚本会标记并跳过）。
// - 频繁请求可能触发微信风控（返回验证页），默认并发 3、每篇间隔 1~2 秒；
//   失败会重试，连续失败过多会自动暂停等待。
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { load as cheerioLoad } from "cheerio";
import { LINKS_DIR, RAW_DIR, ensureDir, fetchText, log, mapLimit, readJson, sleep, writeJson, WECHAT_UA } from "./lib.mjs";

const args = process.argv.slice(2);
const accountArg = args.find((a) => a.startsWith("--account"))?.split("=")[1];
const limitArg = args.find((a) => a.startsWith("--limit"))?.split("=")[1];
const LIMIT = limitArg ? Number(limitArg) : 0; // 0 = 全部

const CONCURRENCY = 3;
const INTERVAL_MS = 1200; // 每篇之间的基础间隔
const MAX_CONSECUTIVE_FAILURES = 8;

ensureDir(LINKS_DIR);
ensureDir(RAW_DIR);

/** 读取 links 目录下所有清单：{ 公众号名: [ {url, title, date} ] } */
function loadAllLinks() {
  const result = {};
  for (const file of fs.readdirSync(LINKS_DIR)) {
    if (!file.endsWith(".txt")) continue;
    const account = path.basename(file, ".txt");
    const lines = fs
      .readFileSync(path.join(LINKS_DIR, file), "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    result[account] = lines.map((line) => {
      const [url, title, date] = line.split(/\t/);
      return { url, title: title ?? "", date: date ?? "" };
    });
  }
  return result;
}

/** 从文章 HTML 中提取结构化信息 */
function parseArticle(html, url) {
  const $ = cheerioLoad(html);
  const title = $("#activity-name").text().trim() || $("title").text().trim();
  const account = $("#js_name").text().trim();
  const publishTime = parsePublishTime($);
  const contentHtml = $("#js_content").html() ?? "";
  return { title, account, publishTime, contentHtml };
}

/** 发布时间：#publish_time 文本，或页面内 var ct = "时间戳" */
function parsePublishTime($) {
  const node = $("#publish_time").text().trim();
  if (node) return node;
  const html = $.html();
  const m = html.match(/var\s+ct\s*=\s*"(\d{10})"/);
  if (m) {
    const d = new Date(Number(m[1]) * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return "";
}

/** 判断是否命中微信风控验证页 */
function isBlocked(html) {
  return (
    !html.includes("js_content") &&
    (html.includes("环境异常") || html.includes("访问过于频繁") || html.includes("去验证") || html.includes("captcha"))
  );
}

async function fetchOne(item, account) {
  await sleep(INTERVAL_MS * (0.7 + Math.random() * 0.6));
  const { text, finalUrl } = await fetchText(item.url, {
    headers: { "User-Agent": WECHAT_UA, Referer: "https://mp.weixin.qq.com/" },
    timeoutMs: 20_000,
  });
  if (isBlocked(text)) {
    throw new Error("触发微信风控验证页");
  }
  const parsed = parseArticle(text, finalUrl);
  const resolvedAccount = parsed.account || account; // 以页面内公众号名为准
  return {
    url: finalUrl,
    inputAccount: account,
    account: resolvedAccount,
    title: parsed.title || item.title,
    publishTime: parsed.publishTime || item.date,
    contentHtml: parsed.contentHtml,
    fetchedAt: new Date().toISOString(),
  };
}

async function main() {
  const allLinks = loadAllLinks();
  const accounts = accountArg
    ? { [accountArg]: allLinks[accountArg] ?? [] }
    : allLinks;

  if (Object.keys(accounts).length === 0) {
    log("02", "links/ 目录为空。先用 01 脚本搜狗抓链接，或手动把文章链接粘贴到 links/公众号名.txt");
    return;
  }

  let totalDone = 0;
  let totalFailed = 0;

  for (const [account, links] of Object.entries(accounts)) {
    const rawFile = path.join(RAW_DIR, `${account}.json`);
    const existing = readJson(rawFile, []);
    const doneUrls = new Set(existing.map((a) => a.url));

    const pending = links.filter((l) => !doneUrls.has(l.url));
    const slice = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;
    if (slice.length === 0) {
      log("02", `「${account}」无需抓取（${existing.length} 篇已在库）`);
      continue;
    }

    log("02", `「${account}」待抓取 ${slice.length} 篇（已抓 ${existing.length} 篇），并发 ${CONCURRENCY}`);
    const results = [];
    let failures = 0;

    await mapLimit(slice, CONCURRENCY, async (item) => {
      try {
        const article = await fetchOne(item, account);
        results.push(article);
        failures = 0;
        totalDone++;
        log("02", `✓ ${article.title?.slice(0, 40) || item.url}（${article.publishTime || "时间未知"}）`);
      } catch (err) {
        failures++;
        totalFailed++;
        results.push({ url: item.url, inputAccount: account, error: err.message, fetchedAt: new Date().toISOString() });
        log("02", `✗ 失败：${err.message} — ${item.url}`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          log("02", `连续失败 ${failures} 次，疑似被风控，暂停 60 秒`);
          await sleep(60_000);
          failures = 0;
        }
      }
    });

    existing.push(...results);
    writeJson(rawFile, existing);
    const okCount = results.filter((r) => r.contentHtml).length;
    log("02", `「${account}」本批完成：成功 ${okCount} / 失败 ${results.length - okCount}，累计 ${existing.length} 篇 → ${rawFile}`);
  }

  log("02", `全部完成：累计新增成功 ${totalDone} 篇，失败 ${totalFailed} 篇。下一步：node 03-clean-export.mjs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
