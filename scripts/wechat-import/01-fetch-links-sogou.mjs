// ============================================================================
// 01 · 从搜狗微信搜索收集公众号文章链接（辅助手段）
// ----------------------------------------------------------------------------
// 用法：node 01-fetch-links-sogou.mjs "中国科学技术大学" [--pages 5]
// 输出：links/中国科学技术大学.txt，每行一个文章 URL（已解析为 mp.weixin.qq.com 真实地址）
//
// 说明：
// - 搜狗只能搜到最近几个月内的文章且存在验证码反爬，属于「链接来源的补充」；
//   更完整的做法是在微信客户端打开公众号 → 历史消息 → 右上角… → 复制链接，
//   手动粘贴进 links/公众号名.txt。
// - 搜狗文章列表页链接是 /link?url=xxx 跳转地址，本脚本会逐个跟随重定向，
//   解析成可直接抓取的 mp.weixin.qq.com/s/xxx 地址。
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { load as cheerioLoad } from "cheerio";
import { LINKS_DIR, createCookieSession, ensureDir, log, sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const account = args.find((a) => !a.startsWith("--"));
const pagesFlag = args.find((a) => a.startsWith("--pages"));
const pages = pagesFlag ? Number(pagesFlag.split("=")[1] ?? pagesFlag.split(" ")[1] ?? 5) : 5;

if (!account) {
  console.error("用法：node 01-fetch-links-sogou.mjs \"公众号名称\" [--pages=5]");
  process.exit(1);
}

const SOGOU_SEARCH = "https://weixin.sogou.com/weixin";
const SOGOU_ORIGIN = "https://weixin.sogou.com";
const outFile = path.join(LINKS_DIR, `${account}.txt`);

ensureDir(LINKS_DIR);
const existing = fs.existsSync(outFile)
  ? new Set(fs.readFileSync(outFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
  : new Set();

/** 解析搜狗列表页，返回 [{ title, date, link }]，link 为 /link?url= 跳转地址 */
function parseListPage(html) {
  const $ = cheerioLoad(html);
  const items = [];
  $("ul.news-list > li").each((_, li) => {
    const $li = $(li);
    const $a = $li.find("h3 a").first();
    const href = $a.attr("href");
    const title = $a.text().trim().replace(/\s+/g, "");
    const date = $li.find(".s2 span, .s2 script").first().text().trim() || $li.find(".s3").text().trim();
    if (href && title) items.push({ title, date, link: href.startsWith("http") ? href : `${SOGOU_ORIGIN}${href}` });
  });
  return items;
}

/** 跟随搜狗跳转链接，解析出真实的 mp.weixin.qq.com 地址（带 Cookie 会话） */
async function resolveLink(session, link) {
  const { finalUrl } = await session.fetch(link, {
    referer: SOGOU_ORIGIN,
    timeoutMs: 10_000,
  });
  return finalUrl;
}

async function main() {
  log("01", `开始抓取「${account}」的文章链接，共 ${pages} 页`);
  const session = createCookieSession();
  const collected = [];
  let newCount = 0;
  let verifyHit = false;

  for (let page = 1; page <= pages; page++) {
    const url = `${SOGOU_SEARCH}?type=2&s_from=input&query=${encodeURIComponent(account)}&ie=utf8&page=${page}`;
    try {
      const { text } = await session.fetch(url, { referer: SOGOU_SEARCH, retries: 1 });
      if (text.includes("seccode") || text.includes("请输入验证码") || /antispider|verify/.test(text)) {
        verifyHit = true;
        log("01", `第 ${page} 页触发验证码，停止翻页（搜狗反爬限制）`);
        break;
      }
      const items = parseListPage(text);
      if (items.length === 0) {
        log("01", `第 ${page} 页无结果，结束`);
        break;
      }
      log("01", `第 ${page} 页解析到 ${items.length} 条候选`);
      for (const item of items) {
        try {
          const finalUrl = await resolveLink(session, item.link);
          if (/mp\.weixin\.qq\.com\/s\//.test(finalUrl) && !existing.has(finalUrl)) {
            collected.push(`${finalUrl}\t${item.title}\t${item.date}`);
            existing.add(finalUrl);
            newCount++;
          }
        } catch {
          log("01", `  跳转解析失败，跳过：${item.title.slice(0, 30)}`);
        }
        await sleep(600); // 放缓节奏，降低触发验证码概率
      }
    } catch (err) {
      log("01", `第 ${page} 页请求失败：${err.message}`);
    }
    await sleep(1500);
  }

  if (collected.length > 0) {
    fs.appendFileSync(outFile, `${collected.join("\n")}\n`, "utf8");
  }
  log("01", `完成：新增 ${newCount} 条链接，累计清单 ${existing.size} 条 → ${outFile}`);
  if (verifyHit) {
    log("01", "提示：搜狗反爬较严且只覆盖近期文章。建议在微信中打开公众号 → 历史消息 → 右上角… → 复制链接，手动补充到 links/ 目录");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
