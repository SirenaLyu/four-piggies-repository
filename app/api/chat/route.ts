import {
  convertToModelMessages,
  createTextStreamResponse,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { z } from "zod";
import { chatClient, CHAT_MODEL } from "../../lib/ai-clients";
import {
  getDifyKnowledgeConfig,
  retrieveKnowledgeContext,
} from "../../lib/dify-knowledge";

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
 * 工具 2: search_school_news
 * 调用 Tavily Search API 搜索学校官网的最新通知、新闻
 */
const searchSchoolNewsTool = tool({
  description:
    "搜索学校官网的最新通知、近期活动或知识库中查不到的实时校园信息。" +
    "仅当 query_knowledge_base 无法提供有效答案，且问题确实与中国科学技术大学相关时，才使用此工具。",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "搜索关键词，系统会自动限定在学校官网（ustc.edu.cn）范围内搜索",
      ),
  }),
  execute: async ({ query }) => {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
      return (
        "联网搜索服务尚未配置。请联系管理员设置环境变量：\n" +
        "- `TAVILY_API_KEY`：Tavily Search API 密钥"
      );
    }

    console.log(`[search_school_news] 搜索: ${query} site:ustc.edu.cn`);

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
        const errorText = await response.text();
        console.error(
          `[search_school_news] HTTP ${response.status}: ${errorText}`,
        );
        return `联网搜索失败（HTTP ${response.status}）。请稍后重试。`;
      }

      const data = await response.json();

      const parts: string[] = [];

      if (data.answer) {
        parts.push(`📌 **搜索摘要**\n${data.answer}`);
      }

      if (data.results && data.results.length > 0) {
        parts.push(
          "\n🔗 **相关链接**\n" +
            data.results
              .map(
                (r: { title: string; content: string; url: string }, i: number) =>
                  `${i + 1}. **${r.title}**\n   ${r.content}\n   来源：${r.url}`,
              )
              .join("\n\n"),
        );
      }

      const result = parts.join("\n") || "未找到相关新闻或通知。";
      console.log(
        `[search_school_news] 结果长度: ${result.length} 字符`,
      );
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[search_school_news] 异常: ${message}`);
      return `联网搜索异常：${message}`;
    }
  },
});

// ============================================================================
// 系统提示词
// ============================================================================

const SYSTEM_PROMPT = `你是中国科学技术大学智能校园助手，名字叫"科大精灵"，专门回答关于学校的各类问题。

## 可用工具

你有两个工具可以调用。请根据用户问题的类型，自主选择最合适的工具：

### 1. query_knowledge_base — 查询学校知识库
- **包含内容**：政策文件、规章制度、办事流程、人员信息（教学秘书、行政人员等）、办公地点、联系方式等知识库文档
- **适用场景**：用户询问学校政策、管理规定、办事指南、申请流程、具体人员信息、电话号码、办公地点等
- **示例**：
  - "如何申请奖学金？"
  - "学生宿舍管理规定是什么？"
  - "网络空间安全学院的教学秘书是谁？"
  - "数学科学学院的办公电话是什么？"

### 2. search_school_news — 搜索学校官网最新信息
- **搜索范围**：学校官网（ustc.edu.cn）的近期通知、新闻、活动等
- **适用场景**：当 query_knowledge_base 无法提供有效答案，且问题明显与中国科学技术大学相关时使用
- **示例**：
  - "最近有什么学术讲座？"
  - "今年的校运会是什么时候？"
  - "最新的放假通知在哪里？"

## 工具调用策略

1. **分析用户问题**，判断属于哪种信息类型
2. **优先调用一次** query_knowledge_base（知识库文档与资料）
3. 只有当知识库返回"未检索到相关内容"或内容明显与问题无关时：
   - 问题仍与学校相关 → 再调用 search_school_news 补充搜索
   - 问题与学校无关 → 直接告知用户你只能回答学校相关问题
4. **知识库已命中相关内容时，不要再调用 search_school_news**（每次工具调用都会增加用户等待时间），直接综合知识库结果回答
5. 如果一个工具返回"未找到"或"未配置"，**尝试其他工具**

## 回答要求

- 使用**中文**回答，语气友好、乐于助人
- **严格基于**工具返回的结果，不要编造信息
- 如果所有工具都无法获取有效信息，**诚实告知**用户，建议用户访问学校官网或相关部门
- 回答格式清晰，适当使用 Markdown 排版（表格、列表等）
- 引用信息来源（如"根据知识库检索结果..."、"根据学校官网..."）`;

// ============================================================================
// API 路由
// ============================================================================

export async function POST(req: Request) {
  // 全链路耗时打点：请求进入 → 首块文本 → 各 step → 流结束
  const requestStart = Date.now();
  const body = await req.json();
  const rawMessages = body.messages ?? [];

  // 预处理：移除模型不支持的文件类型
  const messages = sanitizeMessagesForModel(rawMessages);

  const result = streamText({
    model: chatClient.chat(CHAT_MODEL),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(
      messages as Parameters<typeof convertToModelMessages>[0],
    ),
    tools: {
      query_knowledge_base: queryKnowledgeBaseTool,
      search_school_news: searchSchoolNewsTool,
    },
    // 允许多轮工具调用：模型可以多次调用工具，综合结果后回答
    stopWhen: stepCountIs(5),
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

  // 包装文本流：记录首个文本块到达时间（即用户看到第一个字的时间）与流结束时间
  let firstChunkLogged = false;
  const instrumentedStream = result.textStream.pipeThrough(
    new TransformStream<string, string>({
      transform(chunk, controller) {
        if (!firstChunkLogged) {
          firstChunkLogged = true;
          console.log(`[chat] 首个文本块到达（TTFB）：耗时 ${Date.now() - requestStart}ms`);
        }
        controller.enqueue(chunk);
      },
      flush() {
        console.log(`[chat] 流结束，总耗时 ${Date.now() - requestStart}ms`);
      },
    }),
  );

  return createTextStreamResponse({
    stream: instrumentedStream,
  });
}
