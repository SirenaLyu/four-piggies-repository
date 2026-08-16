import { generateText } from "ai";
import { chatClient, CHAT_MODEL } from "../../lib/ai-clients";

const SYSTEM_PROMPT = `你是对话标题生成器。请根据下面的"用户问题"和"助手回答"，用 5 到 15 个汉字概括这次对话的主题。
要求：
- 只输出标题文字，不要加引号、不要加标点、不要换行、不要加任何前缀如"标题："。
- 标题应描述话题本身，例如"食堂退款流程"、"转专业申请条件"，而非"用户询问"或"AI回答"。
- 不要超过 15 个汉字。`;

type SummarizeMessage = { role: "user" | "assistant"; text: string };

function sanitizeTitle(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[\r\n"]/g, "").trim();
  if (!cleaned) return fallback.slice(0, 15);
  return cleaned.slice(0, 15);
}

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
    const result = await generateText({
      model: chatClient.chat(CHAT_MODEL),
      system: SYSTEM_PROMPT,
      prompt: `用户问题：${userText}\n\n助手回答：${assistantText}`,
    });
    const title = sanitizeTitle(result.text, userText);
    return Response.json({ title });
  } catch (e) {
    const fallback = sanitizeTitle(userText, userText);
    return Response.json(
      { title: fallback, warning: e instanceof Error ? e.message : "generateText failed" },
      { status: 200 },
    );
  }
}
