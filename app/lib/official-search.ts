type GovPolicyItem = {
  title?: unknown;
  summary?: unknown;
  url?: unknown;
  pubtimeStr?: unknown;
  pcode?: unknown;
  puborg?: unknown;
};

type GovPolicyPayload = {
  code?: unknown;
  searchVO?: {
    listVO?: unknown;
  };
};

const POLICY_PATTERN =
  /政策|条例|规定|规划|办法|意见|通知|决定|批复|政府工作报告|国发|国办/i;
const OFFICIAL_SCOPE_PATTERN = /国务院|中国政府网|gov\.cn|国发|国办|官方/i;

function cleanText(value: unknown, maxLength = 500): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isOfficialGovUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return host === "gov.cn" || host.endsWith(".gov.cn");
  } catch {
    return false;
  }
}

export function extractGovPolicySearchTerms(query: string): string | null {
  if (!POLICY_PATTERN.test(query) || !OFFICIAL_SCOPE_PATTERN.test(query)) {
    return null;
  }

  const cleaned = query
    .replace(/https?:\/\/\S+|\bsite:\S+/gi, " ")
    .replace(/20\d{2}(?:[-/.年]\d{1,2}(?:[-/.月]\d{1,2}(?:日)?)?)?年?/g, " ")
    .replace(
      /国务院办公厅|国务院|中国政府网|gov\.cn|官方|官网|政策文件库|政策|文件|原文|全文|最新|最近|近期|今天|今日|现在|截至|截止|发布|印发|通知|意见|决定|批复|条例|规定|规划|办法|层面|可信|来源|链接|请|查找|查询|检索|列出|内容|相关|基准日期|目标日期/gi,
      " ",
    )
    .replace(/[，。；：、!?！？()[\]（）【】“”"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length < 2) return null;
  return cleaned.slice(0, 80);
}

export function formatGovPolicyResults(payload: unknown): string {
  const typed = payload as GovPolicyPayload;
  if (typed?.code !== 200 || !Array.isArray(typed.searchVO?.listVO)) return "";

  const blocks: string[] = [];
  const seenUrls = new Set<string>();
  for (const rawItem of typed.searchVO.listVO as GovPolicyItem[]) {
    const title = cleanText(rawItem?.title, 240);
    const url = cleanText(rawItem?.url, 1_000);
    if (!title || !isOfficialGovUrl(url) || seenUrls.has(url)) continue;

    const date = cleanText(rawItem?.pubtimeStr, 40);
    const documentNumber = cleanText(rawItem?.pcode, 80);
    const publisher = cleanText(rawItem?.puborg, 120);
    const summary = cleanText(rawItem?.summary, 500);
    const details = [
      "来源类型：中国政府网政策文件库（国务院文件）",
      date && `发布日期：${date}`,
      documentNumber && `文号：${documentNumber}`,
      publisher && `发布机构：${publisher}`,
      summary && `摘要：${summary}`,
      `来源：${url}`,
    ].filter(Boolean);
    blocks.push(`${title}\n${details.join("\n")}`);
    seenUrls.add(url);
    if (blocks.length >= 5) break;
  }
  return blocks.join("\n\n");
}

export async function searchGovPolicyLibrary(
  query: string,
  signal: AbortSignal,
): Promise<string> {
  const terms = extractGovPolicySearchTerms(query);
  if (!terms) return "";

  const url = new URL("https://sousuo.www.gov.cn/search-gov/data");
  url.search = new URLSearchParams({
    t: "zhengcelibrary_gw",
    q: terms,
    p: "1",
    n: "5",
    sort: "score",
    sortType: "1",
    searchfield: "title",
    type: "gwyzcwjk",
  }).toString();
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) return "";
  return formatGovPolicyResults(await response.json());
}
