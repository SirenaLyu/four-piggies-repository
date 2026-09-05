import { tool } from "ai";
import { sourceCitationCatalog, webSourcesFromText, type AnswerSource } from "./sources.ts";
import { z } from "zod";
import { withTimeoutSignal } from "./abort-signals.ts";
import { createCircuitBreaker } from "./circuit-breaker.ts";
import { searchGovPolicyLibrary } from "./official-search.ts";
import {
  MAX_WEB_SEARCH_CALLS,
  blockedSearchDomainsFromEnv,
  buildWebSearchQueries,
  isReliableSearchResult,
  normalizeWebSearchQuery,
  sanitizeWebSearchResult,
  searchResultDirectlyMatchesQuery,
  type RetrievalUsage,
} from "./search-policy.ts";
import { TtlLruCache } from "./ttl-lru-cache.ts";
import {
  errorMessage,
  logEvent,
  type TelemetryContext,
} from "./telemetry.ts";

const WEB_SEARCH_CACHE_TTL_MS = 2 * 60 * 1000;
const WEB_SEARCH_TOTAL_BUDGET_MS = 75_000;
const WORKFLOW_REQUEST_TIMEOUT_MS = 45_000;
const workflowCircuitBreaker = createCircuitBreaker(3, 30_000);
const webSearchCache = new TtlLruCache<string, string>(200, WEB_SEARCH_CACHE_TTL_MS);

export function createWebSearchTool(
  usage: RetrievalUsage,
  requestSignal: AbortSignal,
  telemetry: TelemetryContext = { requestId: "background", scope: "web_search" },
  onSources?: (sources: AnswerSource[]) => void,
) {
  return tool({
    description:
      "实时联网搜索工具：通过搜索引擎检索互联网上的最新公开信息。" +
      "当知识库查不到答案、内容可能过时，或用户需要最新动态（新闻、通知、讲座、活动、政策变化等）时使用。" +
      "优先聚焦与中国科学技术大学相关的内容，但也可以搜索一般性问题。",
    inputSchema: z.object({
      query: z
        .string()
        .describe("要搜索的关键词，保留完整语义以获得更好的搜索结果"),
    }),
    execute: async ({ query }) => {
      if (usage.webSearches >= MAX_WEB_SEARCH_CALLS) {
        return "联网搜索次数已达上限。禁止再次调用 web_search，请综合已有结果给出最终答案；证据不足时明确说明。";
      }
      usage.webSearches += 1;
      const apiKey = process.env.DIFY_WORKFLOW_API_KEY;
      if (!apiKey) {
        return (
          "联网搜索服务尚未配置。请联系管理员设置环境变量：\n" +
          "- `DIFY_WORKFLOW_API_KEY`：Dify 联网搜索工作流的 API 密钥"
        );
      }

      const baseUrl = (process.env.DIFY_BASE_URL || "").replace(/\/+$/, "");
      if (!baseUrl) return "联网搜索服务尚未配置。请联系管理员设置 DIFY_BASE_URL。";

      const searchQueries = buildWebSearchQueries(query);
      const normalizedQuery = searchQueries[0] ?? normalizeWebSearchQuery(query);
      const blockedDomains = blockedSearchDomainsFromEnv(
        process.env.DIFY_SEARCH_BLOCKED_DOMAINS,
      );
      const searchCacheKey = JSON.stringify({
        queries: searchQueries.map((item) => item.toLowerCase()),
        blockedDomains: [...blockedDomains].sort(),
      });
      const cachedResult = webSearchCache.get(searchCacheKey);
      if (cachedResult) {
        onSources?.(webSourcesFromText(cachedResult));
        logEvent(telemetry, "web_search.cache_hit", {
          queryChars: normalizedQuery.length,
        });
        return `【联网搜索结果（缓存，已做内容安全与来源筛选）】\n${cachedResult}${sourceCitationCatalog(webSourcesFromText(cachedResult))}`;
      }

      const startedAt = Date.now();
      logEvent(telemetry, "web_search.started", {
        queryChars: normalizedQuery.length,
        candidateQueries: searchQueries.length,
        callNumber: usage.webSearches,
      });
      const deadline = Date.now() + WEB_SEARCH_TOTAL_BUDGET_MS;
      const officialPolicyPromise = searchGovPolicyLibrary(
        normalizedQuery,
        withTimeoutSignal(requestSignal, 12_000),
      ).catch((error: unknown) => {
        logEvent(
          telemetry,
          "web_search.official_source_failed",
          { error: errorMessage(error) },
          "warn",
        );
        return "";
      });
      const workflowResults: string[] = [];
      let lastWorkflowError = "";

      if (!workflowCircuitBreaker.canRequest()) {
        lastWorkflowError = "联网搜索服务连续失败，正在短暂熔断";
        logEvent(
          telemetry,
          "web_search.circuit_open",
          { failureCount: workflowCircuitBreaker.snapshot().failures },
          "warn",
        );
      } else {
        for (const [index, searchQuery] of searchQueries.entries()) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 1_000) {
            lastWorkflowError = "联网搜索达到本轮总时间预算";
            break;
          }
          try {
            const response = await fetch(`${baseUrl}/v1/workflows/run`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                inputs: { query: searchQuery },
                response_mode: "blocking",
                user: "campus-ai-assistant",
              }),
              signal: withTimeoutSignal(
                requestSignal,
                Math.min(WORKFLOW_REQUEST_TIMEOUT_MS, remainingMs),
              ),
            });
            if (!response.ok) {
              const errorText = await response.text();
              lastWorkflowError = `HTTP ${response.status}`;
              logEvent(
                telemetry,
                "web_search.workflow_http_error",
                {
                  status: response.status,
                  attempt: index + 1,
                  errorChars: errorText.length,
                },
                "error",
              );
              workflowCircuitBreaker.recordFailure();
              continue;
            }
            workflowCircuitBreaker.recordSuccess();
            const data = await response.json();
            const result = data?.data?.outputs?.result;
            if (typeof result === "string" && result.trim()) workflowResults.push(result);
            const interimSafeResult = sanitizeWebSearchResult(
              workflowResults.join("\n\n"),
              normalizedQuery,
              { blockedDomains },
            );
            if (
              isReliableSearchResult(interimSafeResult) &&
              searchResultDirectlyMatchesQuery(interimSafeResult, normalizedQuery)
            ) {
              break;
            }
            if (index < searchQueries.length - 1) {
              logEvent(telemetry, "web_search.retrying", {
                nextAttempt: index + 2,
              });
            }
          } catch (error: unknown) {
            if (requestSignal.aborted) throw error;
            workflowCircuitBreaker.recordFailure();
            lastWorkflowError = errorMessage(error);
            logEvent(
              telemetry,
              "web_search.workflow_failed",
              { attempt: index + 1, error: lastWorkflowError },
              "warn",
            );
          }
        }
      }

      const officialPolicyResult = await officialPolicyPromise;
      if (officialPolicyResult || workflowResults.length > 0) {
        const combinedResult = [officialPolicyResult, ...workflowResults]
          .filter(Boolean)
          .join("\n\n");
        const safeResult = sanitizeWebSearchResult(combinedResult, normalizedQuery, {
          blockedDomains,
        });
        if (isReliableSearchResult(safeResult)) webSearchCache.set(searchCacheKey, safeResult);
        onSources?.(webSourcesFromText(safeResult));
        logEvent(telemetry, "web_search.completed", {
          durationMs: Date.now() - startedAt,
          workflowChars: workflowResults.reduce(
            (total, item) => total + item.length,
            0,
          ),
          officialChars: officialPolicyResult.length,
          safeChars: safeResult.length,
          attempts: workflowResults.length,
        });
        return `【联网搜索结果（已做内容安全与来源筛选）】\n${safeResult}${sourceCitationCatalog(webSourcesFromText(safeResult))}`;
      }
      if (lastWorkflowError) {
        logEvent(
          telemetry,
          "web_search.failed",
          { durationMs: Date.now() - startedAt, error: lastWorkflowError },
          "error",
        );
        return `联网搜索失败（${lastWorkflowError}）。请稍后重试。`;
      }
      logEvent(telemetry, "web_search.empty", {
        durationMs: Date.now() - startedAt,
      });
      return "未找到与查询直接相关的可靠结果。";
    },
  });
}
