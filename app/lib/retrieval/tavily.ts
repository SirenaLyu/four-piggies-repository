/**
 * Tavily 官网搜索 —— 检索链第三层兜底
 *
 * Supabase 与 Dify 都无命中时，搜索学校官网（ustc.edu.cn）的实时信息。
 * 未配置 TAVILY_API_KEY 时返回 null，由上层静默跳过，不影响无密钥环境运行。
 * 被 lib/retrieval/router.ts 调用。
 */

interface TavilySearchResult {
  title: string;
  content: string;
  url: string;
}

interface TavilyResponse {
  answer?: string;
  results?: TavilySearchResult[];
}

/**
 * 搜索学校官网最新通知/新闻。
 * @returns 格式化好的上下文文本；未配置密钥或失败时返回 null
 */
export async function searchSchoolNews(query: string): Promise<string | null> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: `${query} site:ustc.edu.cn`,
        search_depth: "basic",
        max_results: 5,
        include_answer: true,
      }),
    });

    if (!response.ok) {
      console.error(`[tavily] HTTP ${response.status}: ${await response.text()}`);
      return null;
    }

    const data = (await response.json()) as TavilyResponse;
    const parts: string[] = [];

    if (data.answer) {
      parts.push(`【官网搜索】摘要\n${data.answer}`);
    }
    if (data.results && data.results.length > 0) {
      parts.push(
        "【官网搜索】相关链接\n" +
          data.results
            .map(
              (r, i) =>
                `${i + 1}. ${r.title}\n   ${r.content}\n   来源:${r.url}`,
            )
            .join("\n\n"),
      );
    }

    const text = parts.join("\n\n") || null;
    if (text) console.log(`[tavily] 命中 ${data.results?.length ?? 0} 条结果`);
    return text;
  } catch (err) {
    console.error(`[tavily] 异常: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
