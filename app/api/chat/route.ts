/**
 * 聊天 API 路由 —— HTTP 壳
 *
 * 职责：解析请求 → 调检索路由 → 选 prompt → 流式回复。
 * 检索与 prompt 选择的全部逻辑在 lib/retrieval/ 与 lib/prompts.ts 中。
 */

import { convertToModelMessages, createTextStreamResponse, streamText } from "ai";
import { chatClient, CHAT_MODEL } from "../../lib/ai-clients";
import { extractMessageText } from "../../lib/message-text";
import { retrieveForQuery } from "../../lib/retrieval/router";
import { buildSystemPrompt } from "../../lib/retrieval/prompt-builder";

export async function POST(req: Request) {
  const body = await req.json();
  const messages = body.messages ?? [];

  // 取最后一条用户消息作为检索 query
  const lastUserMessage = messages
    .filter((m: { role: string }) => m.role === "user")
    .at(-1);
  const userQuery = lastUserMessage
    ? extractMessageText(lastUserMessage as Record<string, unknown>)
    : "";

  // 检索路由（embed → 分类 → Supabase → Dify → Tavily 三层兜底）
  const routeResult = userQuery
    ? await retrieveForQuery(userQuery)
    : { context: "", primary: "fallback" as const, usedBackend: "supabase" as const };

  const systemPrompt = buildSystemPrompt(routeResult, userQuery);

  // 对话模型未配置密钥时，返回可读的错误响应而非 unhandledRejection
  try {
    const result = await streamText({
      model: chatClient.chat(CHAT_MODEL),
      system: systemPrompt,
      messages: await convertToModelMessages(messages),
    });

    return createTextStreamResponse({
      stream: result.textStream,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[chat] 生成回答失败: ${message}`);
    return Response.json(
      { error: "对话模型不可用", detail: message },
      { status: 503 },
    );
  }
}
