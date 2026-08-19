/**
 * 会话标题 API 路由 —— HTTP 壳
 *
 * 核心逻辑（LLM 标题生成 + 清洗）在 lib/services/title-generator.ts。
 */

import { generateTitle, sanitizeTitle } from "../../lib/services/title-generator";

export type SummarizeMessage = { role: "user" | "assistant"; text: string };

export async function POST(req: Request) {
  let body: { messages?: SummarizeMessage[] };
  try {
    body = (await req.json()) as { messages?: SummarizeMessage[] };
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const messages = body.messages ?? [];
  const userMsg = messages.find((m) => m.role === "user");
  const assistantMsg = messages.find((m) => m.role === "assistant");

  if (!userMsg || !userMsg.text) {
    return Response.json({ error: "user message required" }, { status: 400 });
  }

  const userText = userMsg.text.slice(0, 4000);
  const assistantText = (assistantMsg?.text ?? "").slice(0, 800);

  try {
    const title = await generateTitle({ userText, assistantText });
    return Response.json({ title });
  } catch (e) {
    // 模型失败时降级：用用户问题前 15 字作标题
    const fallback = sanitizeTitle(userText, userText);
    return Response.json(
      { title: fallback, warning: e instanceof Error ? e.message : "generateText failed" },
      { status: 200 },
    );
  }
}
