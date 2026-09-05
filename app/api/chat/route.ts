import { createHash } from "node:crypto";
import { citedSources, sourceCitationCatalog, mergeSources, type AnswerSource } from "../../lib/sources";
import { memoryChangeSchema } from "../../lib/memory";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  tool,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { createChatModel } from "../../lib/ai-clients";
import { getAuthenticatedUser, unauthorizedResponse } from "../../lib/auth-session";
import { getResolvedModelConfig, getUserMemory, changeUserMemory, getAuthSecrets } from "../../lib/auth-store";
import {
  getDifyKnowledgeConfig,
  retrieveKnowledgeContext,
  type KnowledgeRetrievalResult,
} from "../../lib/dify-knowledge";
import { TtlLruCache } from "../../lib/ttl-lru-cache";
import { guardApiRequest } from "../../lib/api-security";
import { createWebSearchTool } from "../../lib/web-search-tool";
import { readJsonBody, RequestBodyError } from "../../lib/request-body";
import {
  createTelemetryContext,
  errorMessage,
  logEvent,
  withRequestId,
  type TelemetryContext,
} from "../../lib/telemetry";
import {
  capabilityFingerprint,
  normalizeCapabilities,
} from "../../lib/capabilities";
import { buildSystemPrompt } from "../../lib/chat-system-prompt";
import {
  userProfileFingerprint,
} from "../../lib/user-profile";
import {
  modelHistoryLimit,
  selectRecentMessages,
  shouldPrefetchKnowledge,
} from "../../lib/chat-performance";
import {
  extractLastUserText,
  normalizeQueryKey,
  sanitizeMessagesForModel,
  type RawChatMessage,
} from "../../lib/chat-messages";
import { createAgentRuntimeContext } from "../../lib/tools/agent-runtime";
import {
  AGENT_TOOL_CALL_LIMITS,
  MAX_WEB_SEARCH_CALLS,
  activeToolNamesForStep,
  type RetrievalUsage,
} from "../../lib/search-policy";

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 工具 1: query_knowledge_base
 * 调用 Dify 知识库检索 API（支持多知识库并发检索）查询学校文档资料
 */
function createQueryKnowledgeBaseTool(
  requestSignal: AbortSignal,
  telemetry: TelemetryContext,
  onSources: (sources: AnswerSource[]) => void,
) {
  return tool({
    description:
      "查询学校的知识库资料，包括政策文件、规章制度、办事流程、人员联系方式、办公地点等文档内容。" +
      "当用户询问学校政策、办事流程、管理规定、申请条件、人员信息、联系方式等内容时使用此工具。",
    inputSchema: z.object({
      query: z
        .string()
        .describe("用户的问题，尽可能保留完整语义以便知识库精确检索"),
    }),
    execute: async ({ query }) => {
      logEvent(telemetry, "knowledge.started", { queryChars: query.length });

      // 先检查环境变量是否配置齐全，给管理员明确的提示
      const config = getDifyKnowledgeConfig();
      if (!config.baseUrl || !config.apiKey || config.datasetIds.length === 0) {
        const missing = [
          !config.baseUrl && "DIFY_BASE_URL",
          !config.apiKey && "DIFY_KNOWLEDGE_API_KEY",
          config.datasetIds.length === 0 && "DATASET_IDS",
        ]
          .filter(Boolean)
          .join("、");
        return (
          `知识库服务尚未配置（缺少环境变量：${missing}）。` +
          "请联系管理员在 .env.local 中补齐配置。"
        );
      }

      try {
        // 只检索路由命中的 Dify 知识库，合并去重后得到上下文
        const startedAt = Date.now();
        const result = await retrieveKnowledgeContext(
          query,
          requestSignal,
          telemetry,
        );
        onSources(result.sources ?? []);

        if (!result.ok || !result.context) {
          logEvent(
            telemetry,
            "knowledge.empty",
            {
              durationMs: Date.now() - startedAt,
              reason: result.error ?? "no_result",
            },
            "warn",
          );
          return `知识库中未检索到相关内容。${result.error ?? ""}`.trim();
        }

        logEvent(telemetry, "knowledge.completed", {
          durationMs: Date.now() - startedAt,
          chunkCount: result.chunkCount,
          partialFailure: Boolean(result.error),
        });
        return result.error
          ? `${result.error}\n\n${result.context}${sourceCitationCatalog(result.sources ?? [])}`
          : result.context + sourceCitationCatalog(result.sources ?? []);
      } catch (err: unknown) {
        if (requestSignal.aborted) throw err;
        // 兜底：即使检索模块内部异常，也只返回错误文本，不让主进程崩溃
        const message = errorMessage(err);
        logEvent(telemetry, "knowledge.failed", { error: message }, "error");
        return `知识库查询异常：${message}。请稍后重试。`;
      }
    },
  });
}

// ============================================================================
// API 路由
// ============================================================================

/** 单轮问答结果缓存 TTL（毫秒） */
const ANSWER_CACHE_TTL_MS = 3 * 60 * 1000;
const answerCache = new TtlLruCache<string, { text: string; sources: AnswerSource[] }>(200, ANSWER_CACHE_TTL_MS);

function priorAgentToolUsage(rawMessages: unknown[]): Record<string, number> {
  const lastUserIndex = rawMessages.findLastIndex(
    (message) => (message as { role?: string } | null)?.role === "user",
  );
  const seenCalls = new Set<string>();
  const counts: Record<string, number> = {};
  for (const message of rawMessages.slice(Math.max(0, lastUserIndex))) {
    const parts = (message as { parts?: unknown[] } | null)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const partValue of parts) {
      if (!partValue || typeof partValue !== "object") continue;
      const part = partValue as { type?: unknown; toolCallId?: unknown };
      if (typeof part.type !== "string" || !part.type.startsWith("tool-")) continue;
      const toolName = part.type.slice("tool-".length);
      if (!(toolName in AGENT_TOOL_CALL_LIMITS)) continue;
      const callId = typeof part.toolCallId === "string"
        ? part.toolCallId
        : `${toolName}:${seenCalls.size}`;
      if (seenCalls.has(callId)) continue;
      seenCalls.add(callId);
      counts[toolName] = (counts[toolName] ?? 0) + 1;
    }
  }
  return counts;
}

function logLatestApprovalResponses(
  rawMessages: unknown[],
  telemetry: TelemetryContext,
  userId: string,
): void {
  const latestAssistant = [...rawMessages]
    .reverse()
    .find((message) => (message as { role?: string } | null)?.role === "assistant") as
    | { parts?: unknown[] }
    | undefined;
  if (!Array.isArray(latestAssistant?.parts)) return;
  for (const partValue of latestAssistant.parts) {
    if (!partValue || typeof partValue !== "object") continue;
    const part = partValue as {
      type?: unknown;
      state?: unknown;
      approval?: { approved?: unknown };
    };
    if (
      typeof part.type === "string" &&
      part.type.startsWith("tool-") &&
      part.state === "approval-responded" &&
      typeof part.approval?.approved === "boolean"
    ) {
      logEvent(telemetry, "agent.approval_received", {
        userId,
        tool: part.type.slice("tool-".length),
        approved: part.approval.approved,
      });
    }
  }
}
/** 把缓存文本包装成 AI SDK UI message stream。 */
function cachedUIMessageResponse(text: string, requestId: string, sources: AnswerSource[]): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const streamWriter = writer as unknown as { write: (part: unknown) => void };
      const id = "cached-text";
      streamWriter.write({ type: "start" });
      if (sources.length) streamWriter.write({ type: "data-sources", id: "sources", data: { selection: "cited", sources } });
      streamWriter.write({ type: "start-step" });
      streamWriter.write({ type: "text-start", id });
      streamWriter.write({ type: "text-delta", id, delta: text });
      streamWriter.write({ type: "text-end", id });
      streamWriter.write({ type: "finish-step" });
      streamWriter.write({ type: "finish", finishReason: "stop" });
    },
  });
  return withRequestId(createUIMessageStreamResponse({ stream }), requestId);
}

export async function POST(req: Request) {
  const telemetry = createTelemetryContext(req, "chat");
  const requestStart = Date.now();
  const blocked = guardApiRequest(req, { scope: "chat", defaultLimit: 40 });
  if (blocked) {
    logEvent(telemetry, "request.blocked", { status: blocked.status }, "warn");
    return withRequestId(blocked, telemetry.requestId);
  }
  const authenticatedUser = await getAuthenticatedUser(req);
  if (!authenticatedUser) {
    return withRequestId(unauthorizedResponse(), telemetry.requestId);
  }

  // 全链路耗时打点：请求进入 → 首块文本 → 各 step → 流结束
  logEvent(telemetry, "request.started");
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(req, 15 * 1024 * 1024);
  } catch (error) {
    const requestError =
      error instanceof RequestBodyError
        ? error
        : new RequestBodyError("请求体必须是合法 JSON", 400);
    return withRequestId(
      Response.json({ error: requestError.message }, { status: requestError.status }),
      telemetry.requestId,
    );
  }
  const rawMessages = body.messages ?? [];
  if (
    !Array.isArray(rawMessages) ||
    rawMessages.length > 100 ||
    rawMessages.some(
      (message) => !message || typeof message !== "object" || Array.isArray(message),
    )
  ) {
    return withRequestId(
      Response.json(
        { error: "messages 必须是长度不超过 100 的数组" },
        { status: 400 },
      ),
      telemetry.requestId,
    );
  }

  const capabilities = normalizeCapabilities(body.capabilities);
  const memory = await getUserMemory(authenticatedUser.id);
  const userProfile = memory.profile;
  logLatestApprovalResponses(rawMessages, telemetry, authenticatedUser.id);

  // 单轮问答的结果缓存：同一问题短时间内直接复用上一次回答
  const lastUserText = extractLastUserText(rawMessages);
  const agentRuntime = await createAgentRuntimeContext({
    requested: capabilities.agent,
    query: lastUserText,
    userId: authenticatedUser.id,
    signal: req.signal,
    telemetry,
  });
  const agentToolsNeeded = agentRuntime.activated;
  const authorizedDirs = agentRuntime.authorizedDirectories;
  const localAgentBlocked = agentToolsNeeded && authorizedDirs.length === 0;
  const effectiveCapabilities = {
    ...capabilities,
    knowledgeBase: localAgentBlocked ? false : capabilities.knowledgeBase,
    webSearch: localAgentBlocked ? false : capabilities.webSearch,
    agent: agentRuntime.activated,
  };
  const isSingleTurn =
    Array.isArray(rawMessages) &&
    rawMessages.filter((m) => (m as { role?: string }).role === "user").length === 1;
  const hasAttachments = rawMessages.some((m) =>
    Array.isArray((m as { parts?: unknown[] }).parts) &&
    (m as { parts: Array<{ type?: string }> }).parts.some((part) => part.type === "file"),
  );
  const conversationId =
    typeof body.id === "string" && body.id.trim()
      ? body.id.trim().slice(0, 128)
      : "anonymous";
  const dirsFingerprint = authorizedDirs
    .map((directory) => directory.trim().toLowerCase())
    .sort()
    .join("|");
  const cacheKey =
    isSingleTurn && !hasAttachments && lastUserText && rawMessages.every((m) => (m as { role?: string }).role === "user")
      ? `${authenticatedUser.id}::memory-${memory.version}::${conversationId}::${capabilityFingerprint(effectiveCapabilities)}::${userProfileFingerprint(userProfile)}::${dirsFingerprint}::${normalizeQueryKey(lastUserText)}`
      : null;
  if (cacheKey) {
    const cached = answerCache.get(cacheKey);
    if (cached) {
      logEvent(telemetry, "answer_cache.hit", {
        durationMs: Date.now() - requestStart,
      });
      return cachedUIMessageResponse(cached.text, telemetry.requestId, cached.sources);
    }
  }

  // 稳定且主题明确的单轮校园问题直接预取知识库，减少一次模型工具选择往返。
  let prefetchedKnowledge: KnowledgeRetrievalResult | null = null;
  const knowledgeConfig = getDifyKnowledgeConfig();
  const canUseKnowledgeFastPath =
    effectiveCapabilities.knowledgeBase &&
    !agentToolsNeeded &&
    isSingleTurn &&
    !hasAttachments &&
    shouldPrefetchKnowledge(lastUserText) &&
    Boolean(
      knowledgeConfig.baseUrl &&
        knowledgeConfig.apiKey &&
        knowledgeConfig.datasetIds.length > 0,
    );
  if (canUseKnowledgeFastPath) {
    const startedAt = Date.now();
    const result = await retrieveKnowledgeContext(
      lastUserText,
      req.signal,
      telemetry,
    );
    if (result.ok && result.context) {
      prefetchedKnowledge = result;
      logEvent(telemetry, "knowledge.prefetch_completed", {
        durationMs: Date.now() - startedAt,
        chunkCount: result.chunkCount,
      });
    } else {
      logEvent(
        telemetry,
        "knowledge.prefetch_empty",
        {
          durationMs: Date.now() - startedAt,
          reason: result.error ?? "no_result",
        },
        "warn",
      );
    }
  }

  // 浏览器保留完整历史，仅向模型发送最近消息并移除不支持的附件。
  const historyLimit = modelHistoryLimit(process.env.CHAT_HISTORY_MESSAGES);
  const recentMessages = selectRecentMessages(
    rawMessages as RawChatMessage[],
    historyLimit,
  );
  if (recentMessages.length < rawMessages.length) {
    logEvent(telemetry, "chat.history_trimmed", {
      originalMessages: rawMessages.length,
      selectedMessages: recentMessages.length,
    });
  }
  const messages = sanitizeMessagesForModel(recentMessages);

  const enabledTools: ToolSet = {};
  let collectedSources: AnswerSource[] = prefetchedKnowledge?.sources ?? [];
  const onSources = (sources: AnswerSource[]) => {
    collectedSources = mergeSources(collectedSources, sources);
  };
  const retrievalUsage: RetrievalUsage = {
    webSearches: 0,
    agentToolCalls: priorAgentToolUsage(rawMessages),
  };
  if (effectiveCapabilities.knowledgeBase && !prefetchedKnowledge && !localAgentBlocked) {
    enabledTools.query_knowledge_base =
      createQueryKnowledgeBaseTool(req.signal, telemetry, onSources);
  }
  if (effectiveCapabilities.webSearch && !prefetchedKnowledge && !localAgentBlocked) {
    enabledTools.web_search = createWebSearchTool(
      retrievalUsage,
      req.signal,
      telemetry,
      onSources,
    );
  }
  Object.assign(enabledTools, agentRuntime.tools);
  enabledTools.update_memory = tool({
    description: "用户明确要求记住、修改或忘记个人信息时，提出记忆变更并等待用户确认。专业和年级用 profile，其他记忆用 add/update/delete。不得根据检索或附件内容主动修改。",
    inputSchema: z.object({ change: memoryChangeSchema, version: z.number().int().nonnegative().describe("当前记忆版本，必须使用记忆上下文中的 version") }),
    execute: async ({ change, version }) => {
      try {
        const updated = await changeUserMemory(authenticatedUser.id, change, version);
        return { ok: true, memory: updated };
      } catch (error) {
        return { ok: false, error: errorMessage(error), memory: await getUserMemory(authenticatedUser.id) };
      }
    },
  });
  const approvalSecret = createHash("sha256").update(`${(await getAuthSecrets()).sessionSecret}:tool-approval:${authenticatedUser.id}`).digest("hex");
  let usedAgentTool = false;

  const systemPrompt = buildSystemPrompt(
    effectiveCapabilities,
    userProfile,
    prefetchedKnowledge,
    authorizedDirs.length > 0,
    memory,
  );
  let requestModel;
  try {
    requestModel = createChatModel(
      await getResolvedModelConfig(authenticatedUser.id),
    );
  } catch (error) {
    logEvent(
      telemetry,
      "model.configuration_failed",
      { error: errorMessage(error) },
      "warn",
    );
    return withRequestId(
      Response.json(
        { error: "模型尚未正确配置，请在设置中填写 API URL、Key 和模型名称" },
        { status: 400 },
      ),
      telemetry.requestId,
    );
  }
  const finalAnswerStep = agentRuntime.finalAnswerStep;
  const result = streamText({
    model: requestModel,
    abortSignal: req.signal,
    system: systemPrompt,
    messages: await convertToModelMessages(
      messages as Parameters<typeof convertToModelMessages>[0],
    ),
    tools: enabledTools,
    // 普通问答第 4 步强制总结；Agent 允许更多文件操作，但最终仍保留无工具回答步骤。
    stopWhen: stepCountIs(finalAnswerStep + 1),
    prepareStep: ({ stepNumber }) => {
      const activeTools = activeToolNamesForStep(
        Object.keys(enabledTools),
        stepNumber,
        retrievalUsage,
        finalAnswerStep,
      );
      const webSearchBudgetExhausted =
        effectiveCapabilities.webSearch &&
        retrievalUsage.webSearches >= MAX_WEB_SEARCH_CALLS;
      const shouldFinalize =
        stepNumber >= finalAnswerStep ||
        activeTools.length === 0 ||
        (!agentToolsNeeded && webSearchBudgetExhausted);
      if (shouldFinalize) {
        return {
          activeTools: [],
          toolChoice: "none" as const,
          instructions:
            `${systemPrompt}\n\n## 当前步骤要求\n` +
            "这是最终回答步骤，所有工具均已关闭。请立即综合已有工具结果，直接给出完整答案；" +
            "不得重复搜索、改用无关工具或只描述搜索过程，证据不足时明确说明。",
        };
      }
      return { activeTools };
    },
    toolApproval: { ...agentRuntime.toolApproval, update_memory: "user-approval" },
    experimental_toolApprovalSecret: approvalSecret,
    // 每个 step（一轮模型调用/工具调用）结束时打印耗时与工具名
    onStepFinish: ({ stepNumber, toolCalls, text, usage, performance, finishReason }) => {
      usedAgentTool ||= toolCalls.some((call) =>
        [
          "update_memory",
          "list_dir",
          "find_files",
          "search_text",
          "read_file",
          "write_file",
          "apply_patch",
          "execute_command",
        ].includes(call.toolName),
      );
      for (const call of toolCalls) {
        if (retrievalUsage.agentToolCalls && call.toolName in retrievalUsage.agentToolCalls) {
          retrievalUsage.agentToolCalls[call.toolName] += 1;
        } else if (call.toolName in AGENT_TOOL_CALL_LIMITS) {
          retrievalUsage.agentToolCalls![call.toolName] = 1;
        }
      }
      logEvent(telemetry, "chat.step_completed", {
        stepNumber,
        elapsedMs: Date.now() - requestStart,
        stepMs: performance.stepTimeMs,
        modelWaitMs: performance.responseTimeMs,
        tools: toolCalls.map((call) => call.toolName).join(",") || "none",
        textChars: text.length,
        tokens: usage.totalTokens,
        finishReason,
      });
    },
  });

  logEvent(telemetry, "chat.stream_created", {
    durationMs: Date.now() - requestStart,
    knowledgeBase: effectiveCapabilities.knowledgeBase,
    webSearch: effectiveCapabilities.webSearch,
    agentRequested: capabilities.agent,
    agentActivated: agentToolsNeeded,
    authorizedDirectoryCount: authorizedDirs.length,
  });

  // 完成后缓存本次回答文本（供下一次相同问题直接命中）
  void Promise.resolve(result.text)
    .then((text) => {
      if (cacheKey && !usedAgentTool && text && text.trim()) {
        answerCache.set(cacheKey, { text, sources: citedSources(text, collectedSources) });
      }
      logEvent(telemetry, "chat.completed", {
        durationMs: Date.now() - requestStart,
        textChars: text.length,
        webSearches: retrievalUsage.webSearches,
        usedAgentTool,
        answerCached: Boolean(
          cacheKey && !usedAgentTool && text && text.trim(),
        ),
      });
    })
    .catch((error: unknown) => {
      logEvent(
        telemetry,
        "chat.failed",
        { error: errorMessage(error), durationMs: Date.now() - requestStart },
        "error",
      );
    });

  const modelStream = result.toUIMessageStream({
    sendReasoning: false,
    onError: (error) => {
      logEvent(
        telemetry,
        "chat.stream_failed",
        { error: errorMessage(error), elapsedMs: Date.now() - requestStart },
        "error",
      );
      return "模型服务暂时不可用，请稍后重试。";
    },
  });
  const response = createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        let finalStepText = "";
        writer.merge(modelStream.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            if (chunk.type === "start-step") finalStepText = "";
            if (chunk.type === "text-delta") finalStepText += chunk.delta;
            if (chunk.type === "finish" && chunk.finishReason !== "error") {
              const sources = citedSources(finalStepText, collectedSources);
              if (sources.length) controller.enqueue({ type: "data-sources", id: "sources", data: { selection: "cited", sources } });
            }
            controller.enqueue(chunk);
          },
        })));
      },
    }),
  });
  return withRequestId(response, telemetry.requestId);
}
