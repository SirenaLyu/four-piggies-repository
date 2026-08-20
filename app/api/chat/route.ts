/**
 * 聊天 API 路由 —— HTTP 壳
 *
 * 职责：解析请求 → 检索路由 → 选 prompt → 流式回复（带文件/执行工具）。
 * 工具审批：write_file / execute_command 返回 'user-approval'，
 * 由 AI SDK 原生审批协议经前端 addToolApprovalResponse 回传后执行。
 */

import { convertToModelMessages, createTextStreamResponse, streamText } from "ai";
import { chatClient, CHAT_MODEL } from "../../lib/ai-clients";
import { extractMessageText } from "../../lib/message-text";
import { retrieveForQuery } from "../../lib/retrieval/router";
import { buildSystemPrompt } from "../../lib/retrieval/prompt-builder";
import { FS_TOOLS, setAllowedDirectories } from "../../lib/tools/fs-tools";
import { buildAgentPromptSections } from "../../lib/tools/agent-prompt";

export async function POST(req: Request) {
  const body = await req.json();
  const messages = body.messages ?? [];

  // 授权目录随请求传入（前端 localStorage），注入工具模块
  const authorizedDirs = Array.isArray(body.authorizedDirectories)
    ? (body.authorizedDirectories as string[])
    : [];
  setAllowedDirectories(authorizedDirs);

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

  const systemPrompt =
    buildSystemPrompt(routeResult, userQuery) + buildAgentPromptSections();

  try {
    const result = streamText({
      model: chatClient.chat(CHAT_MODEL),
      system: systemPrompt,
      messages: await convertToModelMessages(messages),
      tools: FS_TOOLS,
      // 工具审批：危险工具需要用户批准；只读工具自动执行
      toolApproval: {
        write_file: "user-approval",
        execute_command: "user-approval",
        list_dir: "approved",
        read_file: "approved",
      },
      // 签名密钥：绑定 approval 请求与响应，防伪造（本地部署随机值即可）
      experimental_toolApprovalSecret:
        process.env.TOOL_APPROVAL_SECRET ?? "campus-ai-local-secret",
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
