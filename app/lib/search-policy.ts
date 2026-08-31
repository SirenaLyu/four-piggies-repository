const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

export const MAX_WEB_SEARCH_CALLS = 2;
export const MAX_KNOWLEDGE_SEARCH_CALLS = 1;
export const FINAL_ANSWER_STEP = 3;
export const AGENT_FINAL_ANSWER_STEP = 6;

export interface RetrievalUsage {
  webSearches: number;
  knowledgeSearches: number;
}

export function finalAnswerStepForCapabilities(agentEnabled: boolean): number {
  return agentEnabled ? AGENT_FINAL_ANSWER_STEP : FINAL_ANSWER_STEP;
}

const WEATHER_PATTERN =
  /天气|气温|温度|降雨|下雨|降水|空气质量|风力|台风|暴雨|雷阵雨/i;
const CAMPUS_PATTERN =
  /中国科学技术大学|中科大|科大|USTC|校内|校园|教务|研究生院|本科生院|图书馆|班车|校车|奖学金|助学金/i;
const RECENCY_PATTERN =
  /最新|最近|近期|刚刚|今日|今天|本周|本月|latest|recent|newest|today/i;

const WEATHER_OFFICIAL_DOMAINS = [
  "weather.cma.cn",
  "nmc.cn",
  "weather.com.cn",
];

const DEFAULT_BLOCKED_DOMAINS = [
  "baijiahao.baidu.com",
  "baike.baidu.com",
  "wenku.baidu.com",
  "zhidao.baidu.com",
  "toutiao.com",
  "douyin.com",
  "kuaishou.com",
  "2345.com",
  "tianqi.com",
  "eastday.com",
];

const UNSAFE_CONTENT_PATTERN =
  /色情|黄色(?:电影|网站)|成人视频|成人(?:内容|视频|区|网站|自拍|免费)|情色|无码|人妻|约炮|裸聊|博彩|赌博|私密.*网站|代开发票|采集站|站群|SEO\s*推广|忽略(?:以上|之前|系统).*指令|ignore\s+(?:all\s+)?previous\s+instructions|system\s+prompt|泄露.*提示词/i;

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

export function searchReferenceDate(now = new Date()): string {
  return shanghaiDate(now);
}

/**
 * 把对时间和来源敏感的查询改写成稳定的搜索词。
 * 保留用户原问题，同时补充绝对日期、完整天气字段与实体关键词。
 * 当前 Dify/SearXNG 对 site: 组合查询的召回不稳定，因此来源约束放在结果阶段执行。
 */
export function extractWeatherLocation(query: string): string | null {
  const weatherIndex = query.search(WEATHER_PATTERN);
  if (weatherIndex <= 0) return null;

  const prefix = query
    .slice(0, weatherIndex)
    .replace(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?/g, " ")
    .replace(/今天|今日|明天|后天|未来\s*\d{1,2}\s*天|现在|当前|实时/g, " ")
    .replace(/请问|请查询|查询|查一下|我想知道|帮我|看一下/g, " ")
    .replace(/[的\s,，。?？]+/g, " ")
    .trim();
  const candidates = prefix.match(/[\p{Script=Han}]{2,12}/gu);
  const candidate = candidates?.at(-1);
  if (!candidate) return null;

  return candidate
    .replace(/^.*省(?=.{2,})/, "")
    .replace(/[市县]$/, "") || null;
}

function expandCampusAlias(query: string): string {
  if (/中国科学技术大学/.test(query)) return query;
  return query.replace(/中科大|中国科大|USTC|科大/gi, "中国科学技术大学");
}

function appendRelativeDate(query: string, now: Date): string {
  if (/\b20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?\b/.test(query)) {
    return query;
  }
  if (/后天/.test(query)) return `${query} 目标日期 ${shanghaiDate(now, 2)}`;
  if (/明天/.test(query)) return `${query} 目标日期 ${shanghaiDate(now, 1)}`;
  if (/昨天|昨日/.test(query)) return `${query} 目标日期 ${shanghaiDate(now, -1)}`;
  if (/今天|今日|today/i.test(query)) {
    return `${query} 目标日期 ${shanghaiDate(now)}`;
  }
  if (RECENCY_PATTERN.test(query) && !/\b20\d{2}(?:年)?\b/.test(query)) {
    return `${query} 检索基准日期 ${shanghaiDate(now)}`;
  }
  return query;
}

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
      `${extractWeatherLocation(normalized) ?? "当地"}气象台`,
    ].join(" ");
  }

  if (CAMPUS_PATTERN.test(normalized)) {
    return appendRelativeDate(expandCampusAlias(normalized), now);
  }

  return appendRelativeDate(normalized, now);
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

function requestedSiteDomain(query: string): string | null {
  const match = query.match(/\bsite:([^\s)]+)/i);
  return match?.[1]?.toLowerCase().replace(/^www\./, "") ?? null;
}

function queryRelevanceTerms(query: string): string[] {
  const latinTerms = Array.from(query.matchAll(/[a-z][a-z0-9.-]{1,}/gi)).map(
    (match) => match[0].toLowerCase(),
  );
  const cleanedChinese = query
    .replace(/https?:\/\/\S+|\bsite:\S+/gi, " ")
    .replace(/20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}(?:日)?)?/g, " ")
    .replace(
      /最新|最近|近期|刚刚|今日|今天|明天|后天|昨天|未来|官方|发布|来源|链接|完整|查询|请问|相关|情况|目标日期|检索基准日期/g,
      " ",
    )
    .replace(/[^\p{Script=Han}\s]/gu, " ");
  const chineseTerms = cleanedChinese
    .split(/\s+/)
    .filter((term) => term.length >= 2)
    .flatMap((term) => {
      if (term.length <= 6) return [term];
      const grams: string[] = [];
      for (let index = 0; index <= term.length - 3; index += 1) {
        grams.push(term.slice(index, index + 3));
      }
      return grams;
    });
  return Array.from(new Set([...latinTerms, ...chineseTerms]));
}

function relevancePriority(block: string, query: string): number {
  const normalizedBlock = block.toLowerCase();
  const terms = queryRelevanceTerms(query);
  const matchedWeight = terms.reduce(
    (score, term) => score + (normalizedBlock.includes(term) ? Math.min(6, term.length) : 0),
    0,
  );
  return Math.min(50, matchedWeight * 2);
}

function freshnessPriority(block: string, query: string): number {
  if (!RECENCY_PATTERN.test(query)) return 0;
  const queryYearMonth = query.match(/\b(20\d{2})[-/.年](\d{1,2})/);
  if (queryYearMonth) {
    const sameMonth = new RegExp(
      `${queryYearMonth[1]}[-/.年]0?${Number(queryYearMonth[2])}(?:月)?`,
    );
    if (sameMonth.test(block)) return 24;
    if (block.includes(queryYearMonth[1])) return 10;
  }
  const currentYear = new Date().getFullYear().toString();
  return block.includes(currentYear) ? 8 : 0;
}

function normalizedContentFingerprint(block: string): string {
  return block
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/来源[:：].*$/gim, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "")
    .slice(0, 220);
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
  const weatherLocation = extractWeatherLocation(query);
  const locationScore = weatherLocation && block.includes(weatherLocation) ? 40 : 0;
  const siteDomain = requestedSiteDomain(query);
  let trustScore = 0;
  if (siteDomain && hosts.some((host) => hostMatches(host, siteDomain))) {
    trustScore = 160;
  }
  if (WEATHER_PATTERN.test(query)) {
    if (
      hosts.some((host) =>
        WEATHER_OFFICIAL_DOMAINS.some((domain) => hostMatches(host, domain)),
      )
    ) {
      trustScore = Math.max(trustScore, 120);
    }
  }
  if (CAMPUS_PATTERN.test(query)) {
    if (hosts.some((host) => hostMatches(host, "ustc.edu.cn"))) {
      trustScore = Math.max(trustScore, 120);
    }
  }
  if (hosts.some((host) => hostMatches(host, "gov.cn"))) {
    trustScore = Math.max(trustScore, 80);
  }
  if (hosts.some((host) => hostMatches(host, "edu.cn"))) {
    trustScore = Math.max(trustScore, 60);
  }
  if (hosts.length === 0) trustScore = Math.max(trustScore, 10);
  return (
    trustScore +
    locationScore +
    relevancePriority(block, query) +
    freshnessPriority(block, query)
  );
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
  options: {
    blockedDomains?: string[];
    maxChars?: number;
    maxBlocks?: number;
    maxPerDomain?: number;
  } = {},
): string {
  const configuredDomains = options.blockedDomains ?? [];
  const blockedDomains = [...DEFAULT_BLOCKED_DOMAINS, ...configuredDomains]
    .map((domain) => domain.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);

  let safeBlocks = splitSearchResult(raw)
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
      hosts: hostsInText(entry.block),
      priority: sourcePriority(entry.block, query),
    }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index);

  const generallyRelevant = safeBlocks.filter(
    ({ block }) => relevancePriority(block, query) > 0,
  );
  if (generallyRelevant.length >= 2) safeBlocks = generallyRelevant;

  if (CAMPUS_PATTERN.test(query)) {
    const officialBlocks = safeBlocks.filter(({ hosts }) =>
      hosts.some((host) => hostMatches(host, "ustc.edu.cn")),
    );
    if (officialBlocks.length > 0) {
      safeBlocks = officialBlocks;
    } else {
      const campusRelevant = safeBlocks.filter(({ block }) =>
        /中国科学技术大学|中科大|中国科大|USTC/i.test(block),
      );
      const trustedCampusBlocks = campusRelevant.filter(({ hosts }) =>
        hosts.some(
          (host) => hostMatches(host, "edu.cn") || hostMatches(host, "gov.cn"),
        ),
      );
      safeBlocks =
        trustedCampusBlocks.length > 0 ? trustedCampusBlocks : campusRelevant;
    }
  }

  if (WEATHER_PATTERN.test(query)) {
    const location = extractWeatherLocation(query);
    if (location) {
      const locationRelevant = safeBlocks.filter(({ block }) =>
        block.includes(location),
      );
      if (locationRelevant.length === 0) {
        return `未找到与“${location}”直接相关且日期匹配的可靠天气结果。`;
      }
      safeBlocks = locationRelevant;
    }
    const officialWeatherBlocks = safeBlocks.filter(({ hosts }) =>
      hosts.some((host) =>
        WEATHER_OFFICIAL_DOMAINS.some((domain) => hostMatches(host, domain)),
      ),
    );
    if (officialWeatherBlocks.length > 0) safeBlocks = officialWeatherBlocks;
  }

  if (safeBlocks.length === 0) {
    return "搜索结果未通过内容安全与来源筛选，无法提供可靠结果。";
  }

  const maxChars = Math.min(20_000, Math.max(1_000, options.maxChars ?? 8_000));
  const maxBlocks = Math.min(12, Math.max(1, options.maxBlocks ?? 6));
  const maxPerDomain = Math.min(4, Math.max(1, options.maxPerDomain ?? 2));
  const selected: string[] = [];
  const selectedFingerprints = new Set<string>();
  const domainCounts = new Map<string, number>();
  let length = 0;
  for (const { block, hosts } of safeBlocks) {
    if (selected.length >= maxBlocks) break;
    const fingerprint = normalizedContentFingerprint(block);
    if (fingerprint && selectedFingerprints.has(fingerprint)) continue;
    const domain = hosts[0] ?? "__no_domain__";
    if ((domainCounts.get(domain) ?? 0) >= maxPerDomain) continue;
    const nextLength = length + block.length + (selected.length > 0 ? 2 : 0);
    if (nextLength > maxChars) {
      if (selected.length === 0) selected.push(block.slice(0, maxChars));
      break;
    }
    selected.push(block);
    if (fingerprint) selectedFingerprints.add(fingerprint);
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
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

export function isReliableSearchResult(result: string): boolean {
  const normalized = result.trim();
  return (
    normalized.length >= 30 &&
    !/^(?:未找到|没有找到|搜索结果未通过|联网搜索失败|联网搜索异常)/.test(
      normalized,
    )
  );
}

export function activeToolNamesForStep(
  toolNames: string[],
  stepNumber: number,
  usage: RetrievalUsage,
  finalAnswerStep = FINAL_ANSWER_STEP,
): string[] {
  if (stepNumber >= finalAnswerStep) return [];
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
