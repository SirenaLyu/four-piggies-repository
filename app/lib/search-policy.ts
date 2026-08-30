const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

export const MAX_WEB_SEARCH_CALLS = 2;
export const MAX_KNOWLEDGE_SEARCH_CALLS = 1;
export const FINAL_ANSWER_STEP = 3;

export interface RetrievalUsage {
  webSearches: number;
  knowledgeSearches: number;
}

const WEATHER_PATTERN =
  /天气|气温|温度|降雨|下雨|降水|空气质量|风力|台风|暴雨|雷阵雨/i;
const CAMPUS_PATTERN =
  /中国科学技术大学|中科大|科大|USTC|校内|校园|教务|研究生院|本科生院|图书馆|班车|校车|奖学金|助学金/i;

const WEATHER_OFFICIAL_DOMAINS = [
  "weather.cma.cn",
  "nmc.cn",
  "weather.com.cn",
];

const DEFAULT_BLOCKED_DOMAINS = [
  "baijiahao.baidu.com",
  "toutiao.com",
  "douyin.com",
  "kuaishou.com",
  "2345.com",
  "tianqi.com",
];

const UNSAFE_CONTENT_PATTERN =
  /色情|成人视频|成人内容|赌博|博彩|约炮|裸聊|代开发票|采集站|站群|SEO\s*推广|忽略(?:以上|之前|系统).*指令|ignore\s+(?:all\s+)?previous\s+instructions|system\s+prompt|泄露.*提示词/i;

function shanghaiDate(now: Date, offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const baseUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day) + offsetDays,
  );
  return new Date(baseUtc).toISOString().slice(0, 10);
}

/**
 * 把对时间和来源敏感的查询改写成稳定的搜索词。
 * 保留用户原问题，同时补充绝对日期、完整天气字段与可信域名约束。
 */
export function normalizeWebSearchQuery(
  query: string,
  now = new Date(),
): string {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (!normalized) return normalized;
  if (/\bsite:/i.test(normalized)) return normalized;

  if (WEATHER_PATTERN.test(normalized)) {
    let dateHint: string;
    if (/后天/.test(normalized)) {
      dateHint = shanghaiDate(now, 2);
    } else if (/明天/.test(normalized)) {
      dateHint = shanghaiDate(now, 1);
    } else {
      const futureDays = normalized.match(/未来\s*(\d{1,2})\s*天/);
      if (futureDays) {
        const days = Math.min(14, Math.max(1, Number(futureDays[1])));
        dateHint = `${shanghaiDate(now)}至${shanghaiDate(now, days - 1)}`;
      } else {
        dateHint = shanghaiDate(now);
      }
    }
    return [
      normalized,
      `日期 ${dateHint}`,
      "完整天气预报 最高气温 最低气温 降水概率 风力",
      `(${WEATHER_OFFICIAL_DOMAINS.map((domain) => `site:${domain}`).join(" OR ")})`,
    ].join(" ");
  }

  if (CAMPUS_PATTERN.test(normalized)) {
    return `${normalized} site:ustc.edu.cn`;
  }

  return normalized;
}

function hostnameFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function hostsInText(text: string): string[] {
  return Array.from(text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi))
    .map((match) => hostnameFromUrl(match[0]))
    .filter((host): host is string => Boolean(host));
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function splitSearchResult(raw: string): string[] {
  const normalized = raw.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const blocks = normalized
    .split(/\n{2,}|\n(?=\s*(?:#{1,6}\s+|[-*]\s+|\d+[.)、]\s*))/g)
    .map((block) => block.trim())
    .filter(Boolean);

  // 某些 Workflow 把所有结果压成一个超长段落；此时退化为逐行过滤。
  if (blocks.length === 1 && blocks[0].length > 3_000) {
    return blocks[0]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return blocks;
}

function sourcePriority(block: string, query: string): number {
  const hosts = hostsInText(block);
  if (WEATHER_PATTERN.test(query)) {
    if (
      hosts.some((host) =>
        WEATHER_OFFICIAL_DOMAINS.some((domain) => hostMatches(host, domain)),
      )
    ) {
      return 120;
    }
  }
  if (CAMPUS_PATTERN.test(query)) {
    if (hosts.some((host) => hostMatches(host, "ustc.edu.cn"))) return 120;
  }
  if (hosts.some((host) => hostMatches(host, "gov.cn"))) return 80;
  if (hosts.some((host) => hostMatches(host, "edu.cn"))) return 60;
  return hosts.length === 0 ? 20 : 0;
}

function dateCompatibleWithQuery(block: string, query: string): boolean {
  const requestedDate = query.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (!requestedDate) return true;

  const requested = `${requestedDate[1]}-${Number(requestedDate[2])}-${Number(requestedDate[3])}`;
  const datedReferences = Array.from(
    block.matchAll(/\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?/g),
  ).map(
    (match) => `${match[1]}-${Number(match[2])}-${Number(match[3])}`,
  );

  // 没有显式日期的实时页面仍可保留；若写出了日期，则必须与请求日期一致。
  return datedReferences.length === 0 || datedReferences.includes(requested);
}

/**
 * 对 Dify/SearXNG 返回的文本做最小信任处理：
 * - 删除已知低质量域名、色情博彩和提示词注入内容；
 * - 校园/天气查询把官方来源排到前面；
 * - 限制送入模型的总长度，避免搜索噪声淹没有效证据。
 */
export function sanitizeWebSearchResult(
  raw: string,
  query: string,
  options: { blockedDomains?: string[]; maxChars?: number } = {},
): string {
  const configuredDomains = options.blockedDomains ?? [];
  const blockedDomains = [...DEFAULT_BLOCKED_DOMAINS, ...configuredDomains]
    .map((domain) => domain.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);

  const safeBlocks = splitSearchResult(raw)
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => !UNSAFE_CONTENT_PATTERN.test(block))
    .filter(({ block }) => dateCompatibleWithQuery(block, query))
    .filter(({ block }) => {
      const hosts = hostsInText(block);
      return !hosts.some((host) =>
        blockedDomains.some((domain) => hostMatches(host, domain)),
      );
    })
    .map((entry) => ({
      ...entry,
      priority: sourcePriority(entry.block, query),
    }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index);

  if (safeBlocks.length === 0) {
    return "搜索结果未通过内容安全与来源筛选，无法提供可靠结果。";
  }

  const maxChars = Math.min(20_000, Math.max(1_000, options.maxChars ?? 12_000));
  const selected: string[] = [];
  let length = 0;
  for (const { block } of safeBlocks) {
    const nextLength = length + block.length + (selected.length > 0 ? 2 : 0);
    if (nextLength > maxChars) {
      if (selected.length === 0) selected.push(block.slice(0, maxChars));
      break;
    }
    selected.push(block);
    length = nextLength;
  }
  return selected.join("\n\n");
}

export function blockedSearchDomainsFromEnv(
  value: string | undefined,
): string[] {
  return (value ?? "")
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean);
}

export function activeToolNamesForStep(
  toolNames: string[],
  stepNumber: number,
  usage: RetrievalUsage,
): string[] {
  if (stepNumber >= FINAL_ANSWER_STEP) return [];
  return toolNames.filter((toolName) => {
    if (toolName === "web_search") {
      return usage.webSearches < MAX_WEB_SEARCH_CALLS;
    }
    if (toolName === "query_knowledge_base") {
      return usage.knowledgeSearches < MAX_KNOWLEDGE_SEARCH_CALLS;
    }
    return true;
  });
}
