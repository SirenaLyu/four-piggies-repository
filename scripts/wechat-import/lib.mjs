// ============================================================================
// 公共工具模块：环境变量加载、HTTP 请求、路径与日志
// 供 scripts/wechat-import/ 下各步骤脚本共用
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录（scripts/wechat-import 的上上级） */
export const ROOT = path.resolve(__dirname, "..", "..");

/** 链接清单目录：links/公众号名.txt，每行一个文章 URL */
export const LINKS_DIR = path.join(__dirname, "links");

/** 原始抓取结果目录：raw/公众号名.json */
export const RAW_DIR = path.join(__dirname, "raw");

/** 清洗后输出目录：output/公众号名/日期-标题.md */
export const OUTPUT_DIR = path.join(__dirname, "output");

/** Dify 导入日志（用于幂等，避免重复导入） */
export const IMPORT_LOG = path.join(__dirname, "dify-import-log.json");

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 解析项目根 .env.local（支持 KEY="value" / KEY=value / # 注释），
 * 已存在的环境变量优先，不覆盖。
 */
export function loadEnvLocal() {
  const envPath = path.join(ROOT, ".env.local");
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key && !(key in process.env)) env[key] = value;
  }
  return env;
}

/**
 * 带 Cookie 管理的请求器：自动保存响应 Set-Cookie，重定向时携带并继续。
 * 用于搜狗等需要先建立会话（SNUID 等 Cookie）才能访问跳转链接的场景。
 * 返回 { status, text?, finalUrl }
 */
export function createCookieSession() {
  let cookies = "";
  return {
    get cookies() {
      return cookies;
    },
    async fetch(url, { headers = {}, referer, maxRedirects = 8, timeoutMs = 15_000 } = {}) {
      const allHeaders = { "User-Agent": randomUA(), Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", ...headers };
      if (referer) allHeaders.Referer = referer;
      let current = url;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        if (cookies) allHeaders.Cookie = cookies;
        const res = await fetch(current, {
          headers: allHeaders,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "manual",
        });
        // 合并 Set-Cookie（同覆盖）
        const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
        for (const raw of setCookies) {
          const kv = raw.split(";")[0];
          const key = kv.split("=")[0].trim();
          cookies = cookies
            .split(";")
            .filter((c) => c.split("=")[0].trim() !== key)
            .filter(Boolean)
            .join(";");
          cookies = cookies ? `${cookies};${kv}` : kv;
        }
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) return { status: res.status, finalUrl: current };
          current = new URL(location, current).toString();
          continue;
        }
        return { status: res.status, text: await res.text(), finalUrl: res.url || current };
      }
      throw new Error("重定向次数过多");
    },
  };
}

/** 模拟常见浏览器的 UA，降低被风控的概率 */
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
];

export function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/** 微信内置浏览器 UA（访问微信文章页更不易触发风控） */
export const WECHAT_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.47.2560(0x28002F3C) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64";

/**
 * GET 请求并返回文本。自动跟随重定向，可配重试与超时。
 * 返回 { status, text, finalUrl }
 */
export async function fetchText(url, { headers = {}, retries = 2, timeoutMs = 15_000, referer } = {}) {
  const allHeaders = { "User-Agent": randomUA(), Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", ...headers };
  if (referer) allHeaders.Referer = referer;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: allHeaders,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, text: await res.text(), finalUrl: res.url };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(1200 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** 从数组头部取最多 n 个元素并发执行，按序落盘 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function log(step, message) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  console.log(`[${time}][${step}] ${message}`);
}

/** 读取 JSON 文件，不存在或损坏时返回 fallback（兼容 UTF-8 BOM） */
export function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

/** 公众号名安全化为目录名/文件名片段 */
export function safeName(name) {
  return name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
}
