// ============================================================================
// fetch_url 工具：打开指定网页并提取正文，供模型阅读链接全文
// ----------------------------------------------------------------------------
// 搜索/知识库结果常只含标题与摘要；模型可用本工具打开具体 URL（通常来自
// web_search 结果中的官方链接）阅读全文后综合回答。
// 安全设计：
// - SSRF 防护：仅 http/https；IP 字面量与 DNS 解析结果均拒绝内网/保留地址；
//   重定向逐跳重新校验，防止跳转到内网；
// - 提示词注入防护：正文仅作为“不可信参考资料”返回，由系统提示词统一约束；
// - 限流：每轮最多 MAX_URL_FETCH_CALLS 次、15s 超时、响应体积上限；
// - 内容类型限制：仅接受 HTML / 纯文本，二进制直接拒绝。
// ============================================================================

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { tool } from "ai";
import { z } from "zod";
import { withTimeoutSignal } from "../abort-signals.ts";
import { MAX_URL_FETCH_CALLS, type RetrievalUsage } from "../search-policy.ts";
import { TtlLruCache } from "../ttl-lru-cache.ts";
import {
  errorMessage,
  logEvent,
  type TelemetryContext,
} from "../telemetry.ts";

const FETCH_URL_TIMEOUT_MS = 15_000;
const MAX_CONTENT_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 8_000;
const MAX_REDIRECTS = 3;
const FETCH_URL_CACHE_TTL_MS = 2 * 60 * 1000;

const FETCH_RESULT_PREFIX = "【网页正文（已做安全过滤）】";
const FETCH_CACHED_RESULT_PREFIX = "【网页正文（缓存，已做安全过滤）】";

const urlFetchCache = new TtlLruCache<string, string>(
  200,
  FETCH_URL_CACHE_TTL_MS,
);

/** 私有/保留 IPv4 段（含 CGNAT、链路本地、组播与保留段） */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true; // 畸形地址按不安全处理
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** 地址（IPv4/IPv6 字面量，可带方括号）是否属于内网/保留地址 */
function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(bare);
  if (version === 4) return isPrivateIPv4(bare);
  if (version === 6) {
    if (bare === "::1" || bare === "::") return true;
    if (bare.startsWith("fc") || bare.startsWith("fd")) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(bare)) return true; // 链路本地 fe80::/10
    const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4 映射地址
    if (mapped) return isPrivateIPv4(mapped[1]);
    return false;
  }
  return false;
}

/**
 * 校验 URL 是否允许访问（协议 + SSRF 检查，域名会做 DNS 解析并校验全部地址）。
 * 返回 URL 表示允许；返回 string 为拒绝原因。
 */
export async function assertSafeUrl(
  rawUrl: string,
): Promise<URL | string> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return "不是合法的 URL，请提供完整的 http/https 链接";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `仅支持 http/https 链接（不支持 ${url.protocol}//）`;
  }
  if (isPrivateAddress(url.hostname)) {
    return `目标地址（${url.hostname}）属于内网/保留地址，已拒绝访问`;
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0) {
    try {
      const records = await lookup(url.hostname, { all: true });
      if (records.length === 0) return "无法解析该域名";
      if (records.some((record) => isPrivateAddress(record.address))) {
        return `域名（${url.hostname}）解析到内网地址，已拒绝访问`;
      }
    } catch {
      return "无法解析该域名，请确认链接是否正确";
    }
  }
  return url;
}

function safeCodePoint(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10_ffff
    ? String.fromCodePoint(code)
    : "";
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      safeCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

/** 从 HTML 中提取可读正文：去脚本样式、块级转换行、剥标签、解码实体。 */
export function extractReadableText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|svg|iframe|template)\b[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(?:p|div|section|article|header|footer|nav|aside|main|li|tr|h[1-6]|blockquote|pre|table|thead|tbody|ul|ol|dl|dt|dd|figcaption|figure|form|fieldset)\s*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, "");
  return decodeEntities(stripped)
    .split("\n")
    .map((line) => line.replace(/[ \t\u3000]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 抓取网页：重定向逐跳校验（防跳内网），校验内容类型与体积后返回正文。 */
async function fetchWebPage(
  rawUrl: string,
  signal: AbortSignal,
): Promise<{ text: string; finalUrl: string }> {
  let current = await assertSafeUrl(rawUrl);
  if (typeof current === "string") throw new Error(current);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; CampusAIAssistant/1.0; +https://ustc.edu.cn)",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
      signal: withTimeoutSignal(signal, FETCH_URL_TIMEOUT_MS),
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === MAX_REDIRECTS) throw new Error("重定向次数超过上限");
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`重定向响应缺少 Location 头（HTTP ${response.status}）`);
      }
      const next = await assertSafeUrl(new URL(location, current).toString());
      if (typeof next === "string") throw new Error(next);
      current = next;
      continue;
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      throw new Error(
        `不支持的页面类型：${contentType || "未知"}（仅支持 HTML / 纯文本）`,
      );
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_CONTENT_BYTES) {
      throw new Error(
        `页面体积超过限制（约 ${(contentLength / 1_000_000).toFixed(1)}MB）`,
      );
    }
    const raw = (await response.text()).slice(0, MAX_CONTENT_BYTES * 2);
    const text = extractReadableText(raw);
    return { text, finalUrl: current.toString() };
  }
  throw new Error("重定向次数超过上限");
}

export function createUrlFetchTool(
  usage: RetrievalUsage,
  requestSignal: AbortSignal,
  telemetry: TelemetryContext = {
    requestId: "background",
    scope: "fetch_url",
  },
) {
  return tool({
    description:
      "打开指定网页并阅读全文。当 web_search 或知识库结果只给出标题、摘要和链接，" +
      "而摘要信息不足以回答问题时使用；输入必须是完整的 http/https 链接，优先选择官方域名（ustc.edu.cn、gov.cn 等）。",
    inputSchema: z.object({
      url: z
        .string()
        .describe("要阅读的网页完整链接（http/https），通常来自搜索结果中的 URL"),
    }),
    execute: async ({ url }) => {
      if ((usage.urlFetches ?? 0) >= MAX_URL_FETCH_CALLS) {
        return (
          `网页阅读次数已达上限（${MAX_URL_FETCH_CALLS} 次）。` +
          "请综合已有资料给出最终答案；证据不足时明确说明。"
        );
      }
      const cacheKey = url.trim().toLowerCase();
      const cached = urlFetchCache.get(cacheKey);
      if (cached) {
        logEvent(telemetry, "fetch_url.cache_hit", { urlChars: url.length });
        return `${FETCH_CACHED_RESULT_PREFIX}\n${cached}`;
      }
      usage.urlFetches = (usage.urlFetches ?? 0) + 1;
      logEvent(telemetry, "fetch_url.started", { urlChars: url.length });
      const startedAt = Date.now();
      try {
        const { text, finalUrl } = await fetchWebPage(url, requestSignal);
        if (!text) {
          throw new Error("该网页没有可提取的正文（可能是空页面或纯脚本渲染）");
        }
        const body =
          text.length > MAX_TEXT_CHARS
            ? `${text.slice(0, MAX_TEXT_CHARS)}\n（正文过长，已截断）`
            : text;
        urlFetchCache.set(cacheKey, `来源：${finalUrl}\n${body}`);
        logEvent(telemetry, "fetch_url.completed", {
          durationMs: Date.now() - startedAt,
          urlChars: url.length,
          textChars: body.length,
        });
        return `${FETCH_RESULT_PREFIX}\n来源：${finalUrl}\n${body}`;
      } catch (err: unknown) {
        if (requestSignal.aborted) throw err;
        const message = errorMessage(err);
        logEvent(
          telemetry,
          "fetch_url.failed",
          { durationMs: Date.now() - startedAt, error: message },
          "error",
        );
        return `网页阅读失败：${message}`;
      }
    },
  });
}
