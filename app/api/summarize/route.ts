import { generateText } from "ai";
import { chatClient, CHAT_MODEL } from "../../lib/ai-clients";
import { guardApiRequest } from "../../lib/api-security";
import {
  createTelemetryContext,
  errorMessage,
  logEvent,
  withRequestId,
} from "../../lib/telemetry";
import { readJsonBody, RequestBodyError } from "../../lib/request-body";

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
  const telemetry = createTelemetryContext(req, "summarize");
  const startedAt = Date.now();
  const respond = (response: Response) =>
    withRequestId(response, telemetry.requestId);
  const blocked = guardApiRequest(req, { scope: "summarize", defaultLimit: 80 });
  if (blocked) {
    logEvent(telemetry, "request.blocked", { status: blocked.status }, "warn");
    return respond(blocked);
  }

  let body: { messages?: SummarizeMessage[] };
  try {
    body = await readJsonBody<{ messages?: SummarizeMessage[] }>(req, 64 * 1024);
  } catch (error) {
    const requestError =
      error instanceof RequestBodyError
        ? error
        : new RequestBodyError("invalid json", 400);
    return respond(
      Response.json({ error: requestError.message }, { status: requestError.status }),
    );
  }

  const messages = Array.isArray(body.messages)
    ? body.messages
        .filter(
          (message): message is SummarizeMessage =>
            Boolean(message) &&
            (message.role === "user" || message.role === "assistant") &&
            typeof message.text === "string",
        )
        .slice(0, 10)
    : [];
  const userMsg = messages.find((m) => m.role === "user");
  const assistantMsg = messages.find((m) => m.role === "assistant");

  if (!userMsg || !userMsg.text) {
    return respond(
      Response.json({ error: "user message required" }, { status: 400 }),
    );
  }

  const userText = userMsg.text.slice(0, 4000);
  const assistantText = (assistantMsg?.text ?? "").slice(0, 800);

  try {
    const result = await generateText({
      model: chatClient.chat(CHAT_MODEL),
      abortSignal: req.signal,
      system: SYSTEM_PROMPT,
      prompt: `用户问题：${userText}\n\n助手回答：${assistantText}`,
    });
    const title = sanitizeTitle(result.text, userText);
    logEvent(telemetry, "summarize.completed", {
      durationMs: Date.now() - startedAt,
      inputChars: userText.length + assistantText.length,
    });
    return respond(Response.json({ title }));
  } catch (e) {
    const fallback = sanitizeTitle(userText, userText);
    logEvent(
      telemetry,
      "summarize.fallback",
      { durationMs: Date.now() - startedAt, error: errorMessage(e) },
      "warn",
    );
    return respond(
      Response.json(
        { title: fallback, warning: errorMessage(e) },
        { status: 200 },
      ),
    );
  }
}
