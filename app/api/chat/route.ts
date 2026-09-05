import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { z } from "zod";
import { chatModel } from "../../lib/ai-clients";
import {
  getDifyKnowledgeConfig,
  retrieveKnowledgeContext,
} from "../../lib/dify-knowledge";
import { FS_TOOLS, setAllowedDirectories } from "../../lib/tools/fs-tools";
import { buildAgentPromptSections } from "../../lib/tools/agent-prompt";

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从 data URL 中解码文本内容（仅处理 text/plain 等文本类型）
 */
function decodeTextFromDataUrl(dataUrl: string): string | null {
  try {
    const match = dataUrl.match(
      /^data:text\/(?:plain|html|csv|markdown);(?:charset=utf-8,)?(.*)$/i,
    );
    if (!match) return null;

    if (dataUrl.includes(";base64,")) {
      const base64Part = dataUrl.split(",")[1];
      if (base64Part) {
        return Buffer.from(base64Part, "base64").toString("utf-8");
      }
    }
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * 预处理消息：移除模型不支持的 file parts（text/plain 等），
 * 将文本文件内容提取为 text parts，避免 AI_UnsupportedFunctionalityError
 */
function sanitizeMessagesForModel(
  messages: Array<{
    role: string;
    parts?: Array<Record<string, unknown>>;
    content?: unknown;
  }>,
): typeof messages {
  return messages.map((m) => {
    if (!Array.isArray(m.parts)) return m;

    const safeParts: Array<Record<string, unknown>> = [];
    const droppedFiles: string[] = [];

    for (const part of m.parts) {
      if (part.type === "text") {
        safeParts.push(part);
      } else if (part.type === "file") {
        const mediaType = String(part.mediaType ?? "");
        if (mediaType.startsWith("image/")) {
          safeParts.push(part);
        } else if (mediaType.startsWith("text/")) {
          const url = String(part.url ?? "");
          const decoded = decodeTextFromDataUrl(url);
          if (decoded) {
            safeParts.push({
              type: "text",
              text: `[文件 ${part.filename || "未命名"} 的内容如下]\n${decoded}`,
            });
          }
          droppedFiles.push(String(part.filename ?? "未知文件"));
        } else {
          droppedFiles.push(String(part.filename ?? "未知文件"));
        }
      } else {
        safeParts.push(part);
      }
    }

    if (droppedFiles.length > 0) {
      const existingTextPart = safeParts.find((p) => p.type === "text");
      const note =
        `\n\n[系统提示：对话历史中包含以下附件，但当前模型不支持直接读取这些文件类型：${droppedFiles.join("、")}]`;
      if (existingTextPart) {
        existingTextPart.text = (existingTextPart.text || "") + note;
      } else {
        safeParts.push({ type: "text", text: note });
      }
    }

    return { ...m, parts: safeParts };
  });
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 工具 1: query_knowledge_base
 * 调用 Dify 知识库检索 API（支持多知识库并发检索）查询学校文档资料
 */
const queryKnowledgeBaseTool = tool({
  description:
    "查询学校的知识库资料，包括政策文件、规章制度、办事流程、人员联系方式、办公地点等文档内容。" +
    "当用户询问学校政策、办事流程、管理规定、申请条件、人员信息、联系方式等内容时使用此工具。",
  inputSchema: z.object({
    query: z
      .string()
      .describe("用户的问题，尽可能保留完整语义以便知识库精确检索"),
  }),
  execute: async ({ query }) => {
    console.log(`[query_knowledge_base] 查询: ${query}`);

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
      // 并发检索所有已配置的 Dify 知识库，合并去重后得到上下文
      const startedAt = Date.now();
      const result = await retrieveKnowledgeContext(query);
      console.log(
        `[query_knowledge_base] 工具总耗时 ${Date.now() - startedAt}ms`,
      );

      if (!result.ok || !result.context) {
        console.warn(`[query_knowledge_base] 未命中：${result.error ?? "无结果"}`);
        return `知识库中未检索到相关内容。${result.error ?? ""}`.trim();
      }

      console.log(
        `[query_knowledge_base] 命中 ${result.chunkCount} 个片段` +
          (result.error ? `（${result.error}）` : ""),
      );
      return result.error ? `${result.error}\n\n${result.context}` : result.context;
    } catch (err: unknown) {
      // 兜底：即使检索模块内部异常，也只返回错误文本，不让主进程崩溃
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[query_knowledge_base] 异常: ${message}`);
      return `知识库查询异常：${message}。请稍后重试。`;
    }
  },
});

/**
 * 工具 2: web_search
 * 调用 Dify 联网搜索 Workflow（内部使用 SearXNG 搜索引擎）获取实时网络信息
 */
const webSearchTool = tool({
  description:
    "实时联网搜索工具：通过搜索引擎检索互联网上的最新公开信息。" +
    "当知识库查不到答案、内容可能过时，或用户需要最新动态（新闻、通知、讲座、活动、政策变化等）时使用。" +
    "优先聚焦与中国科学技术大学相关的内容，但也可以搜索一般性问题。" +
    "搜索词必须用完整校名“中国科学技术大学”（不要用“中科大”等缩写，缩写会搜不到），" +
    "保持简短自然的核心关键词，不要堆砌同义词或多个关键词组合。",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "要搜索的关键词：简短自然（如“中国科学技术大学 放假安排”），" +
        "校名用全称，不堆砌同义词，保留完整语义以获得更好的搜索结果",
      ),
  }),
  execute: async ({ query }) => {
    const apiKey = process.env.DIFY_WORKFLOW_API_KEY;

    if (!apiKey) {
      return (
        "联网搜索服务尚未配置。请联系管理员设置环境变量：\n" +
        "- `DIFY_WORKFLOW_API_KEY`：Dify 联网搜索工作流的 API 密钥"
      );
    }

    const baseUrl = (process.env.DIFY_BASE_URL || "").replace(/\/+$/, "");

    console.log(`[web_search] 调用 Dify Workflow 搜索: ${query}`);

    try {
      const response = await fetch(`${baseUrl}/v1/workflows/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          inputs: { query },
          response_mode: "blocking",
          user: "campus-ai-assistant",
        }),
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[web_search] HTTP ${response.status}: ${errorText}`,
        );
        return `联网搜索失败（HTTP ${response.status}）。请稍后重试。`;
      }

      const data = await response.json();
      const result = data?.data?.outputs?.result;

      if (typeof result === "string" && result.trim()) {
        // 截断过长的搜索结果：科大代理 prefill 慢，控制上下文长度以降低首 token 延迟
        const MAX_SEARCH_CHARS = 2400;
        const trimmed =
          result.length > MAX_SEARCH_CHARS
            ? `${result.slice(0, MAX_SEARCH_CHARS)}…（搜索结果已截断）`
            : result;
        console.log(
          `[web_search] 结果长度: ${result.length} 字符` +
            (result.length > MAX_SEARCH_CHARS ? `（截断至 ${MAX_SEARCH_CHARS}）` : ""),
        );
        return trimmed;
      }

      return "未找到相关新闻或通知。不要再换关键词重复搜索同一主题，请直接基于知识库结果或已有知识回答。";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[web_search] 异常: ${message}`);
      return `联网搜索异常：${message}`;
    }
  },
});

// ============================================================================
// 系统提示词
// ============================================================================

const SYSTEM_PROMPT = `你是中国科学技术大学智能校园助手，名字叫"科大精灵"，专门回答关于学校的各类问题。

## 能力说明（重要）

你确实具备**实时联网搜索能力**：工具 web_search 会通过搜索引擎联网检索，返回互联网上的实时信息。任何时候都不要声称自己"不能联网""无法搜索""没有搜索能力"——当知识库查不到或需要最新信息时，直接调用 web_search。

## 可用工具

你有以下工具可以调用。请根据用户问题的类型，自主选择最合适的工具：

### 1. query_knowledge_base — 查询学校知识库
- **包含内容**：政策文件、规章制度、办事流程、人员信息（教学秘书、行政人员等）、办公地点、联系方式等知识库文档
- **适用场景**：用户询问学校政策、管理规定、办事指南、申请流程、具体人员信息、电话号码、办公地点等
- **示例**：
  - "如何申请奖学金？"
  - "学生宿舍管理规定是什么？"
  - "网络空间安全学院的教学秘书是谁？"
  - "数学科学学院的办公电话是什么？"

### 2. web_search — 实时联网搜索
- **搜索范围**：互联网上的实时公开信息（优先聚焦中国科学技术大学相关内容，也支持一般性问题搜索）
- **适用场景**：当 query_knowledge_base 无法提供有效答案、内容可能过时，或用户需要最新动态（新闻、通知、讲座、活动、放假安排等）时使用
- **示例**：
  - "最近有什么学术讲座？"
  - "今年的校运会是什么时候？"
  - "最新的放假通知在哪里？"

## 工具调用策略

1. **分析用户问题**：如果是简单寒暄或不需要任何资料的闲聊，直接回答，不要调用工具。
2. 需要校园信息时，**在同一个步骤里同时（并行）调用** query_knowledge_base 和 web_search，一次性获取知识库与联网结果。
3. 拿到两个工具的结果后，**综合两者直接回答，不要再调用任何工具**。
4. 如果某个工具返回"未找到"或"未配置"，忽略它、基于另一个工具的结果回答。
5. **永远不要说你不能联网搜索**：web_search 就是你的联网能力，直接调用它即可。
6. **web_search 无结果时不要反复换词重试**（最多重试一次）：继续搜大概率还是没有，
   应立即基于知识库结果或已有知识回答，并告知用户未能搜到实时信息。

## 回答要求

- 使用**中文**回答，语气友好、乐于助人
- **严格基于**工具返回的结果，不要编造信息
- 如果所有工具都无法获取有效信息，**诚实告知**用户，建议用户访问学校官网或相关部门
- 回答格式清晰，适当使用 Markdown 排版（表格、列表等）
- 引用信息来源（如"根据知识库检索结果..."、"根据联网搜索结果..."）`;

// ============================================================================
// API 路由
// ============================================================================

/** 单轮问答结果缓存 TTL（毫秒） */
const ANSWER_CACHE_TTL_MS = 3 * 60 * 1000;
const answerCache = new Map<string, { text: string; ts: number }>();

function normalizeQueryKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/** 从消息列表中提取最后一条用户消息的纯文本 */
function extractLastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as {
      role?: string;
      parts?: Array<{ type?: string; text?: string }>;
      content?: unknown;
    };
    if (m?.role !== "user") continue;
    if (Array.isArray(m.parts)) {
      return m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");
    }
    if (typeof m.content === "string") return m.content;
  }
  return "";
}

/** 把一段缓存文本包装成 UI message stream 流式响应 */
function cachedUIMessageResponse(text: string): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const w = writer as unknown as { write: (part: unknown) => void };
      const id = "0";
      w.write({ type: "start" });
      w.write({ type: "start-step" });
      w.write({ type: "text-start", id });
      w.write({ type: "text-delta", id, delta: text });
      w.write({ type: "text-end", id });
      w.write({ type: "finish-step" });
      w.write({ type: "finish", finishReason: "stop" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

export async function POST(req: Request) {
  // 全链路耗时打点：请求进入 → 首块文本 → 各 step → 流结束
  const requestStart = Date.now();
  const body = await req.json();
  const rawMessages = body.messages ?? [];

  // 授权目录随请求传入（前端 localStorage），注入文件工具模块
  const authorizedDirs = Array.isArray(body.authorizedDirectories)
    ? (body.authorizedDirectories as string[])
    : [];
  setAllowedDirectories(authorizedDirs);

  // 单轮问答的结果缓存：同一问题短时间内直接复用上一次回答
  const lastUserText = extractLastUserText(rawMessages);
  const isSingleTurn =
    Array.isArray(rawMessages) &&
    rawMessages.filter((m) => (m as { role?: string }).role === "user").length === 1;
  const cacheKey =
    isSingleTurn && lastUserText ? normalizeQueryKey(lastUserText) : null;
  if (cacheKey) {
    const cached = answerCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ANSWER_CACHE_TTL_MS) {
      console.log(`[chat] 命中回答缓存，直接返回`);
      return cachedUIMessageResponse(cached.text);
    }
  }

  // 预处理：移除模型不支持的文件类型
  const messages = sanitizeMessagesForModel(rawMessages);

  const result = streamText({
    model: chatModel,
    system: SYSTEM_PROMPT + buildAgentPromptSections(),
    messages: await convertToModelMessages(
      messages as Parameters<typeof convertToModelMessages>[0],
    ),
    tools: {
      query_knowledge_base: queryKnowledgeBaseTool,
      web_search: webSearchTool,
      ...FS_TOOLS,
    },
    // 允许多轮工具调用：模型可以多次调用工具，综合结果后回答
    stopWhen: stepCountIs(3),
    // 文件工具审批：危险操作需用户确认，只读操作自动执行
    toolApproval: {
      write_file: "user-approval",
      execute_command: "user-approval",
      list_dir: "approved",
      read_file: "approved",
    },
    // 签名密钥：绑定 approval 请求与响应，防伪造（本地部署随机值即可）
    experimental_toolApprovalSecret:
      process.env.TOOL_APPROVAL_SECRET ?? "campus-ai-local-secret",
    // 每个 step（一轮模型调用/工具调用）结束时打印耗时与工具名
    onStepFinish: ({ stepNumber, toolCalls, text, usage, performance, finishReason }) => {
      console.log(
        `[chat] step#${stepNumber} 完成（距请求开始 ${Date.now() - requestStart}ms，` +
          `本轮 ${performance.stepTimeMs}ms，其中等模型 ${performance.responseTimeMs}ms）：` +
          `工具=[${toolCalls.map((c) => c.toolName).join(",") || "无"}] ` +
          `文本长度=${text.length} ` +
          `tokens=${usage.totalTokens ?? "?"} ` +
          `finish=${finishReason}`,
      );
    },
  });

  console.log(`[chat] streamText 已创建，耗时 ${Date.now() - requestStart}ms，开始等待模型输出`);

  // 完成后缓存本次回答文本（供下一次相同问题直接命中）
  void result.text.then((text) => {
    if (cacheKey && text && text.trim()) {
      answerCache.set(cacheKey, { text, ts: Date.now() });
    }
  });

  // 用 UI message stream 返回：除了文本，还要把工具调用/审批请求原样传给前端
  return result.toUIMessageStreamResponse({ sendReasoning: false });
}
