/**
 * 对话标题生成服务 —— 从 app/api/summarize/route.ts 抽出的核心逻辑
 *
 * 用 AI 根据"用户问题 + 助手回答"生成 5-15 个汉字的会话标题。
 * 被 app/api/summarize/route.ts 调用。
 */

import { generateText } from "ai";
import { chatClient, CHAT_MODEL } from "../ai-clients";

const SYSTEM_PROMPT = `你是对话标题生成器。请根据下面的"用户问题"和"助手回答"，用 5 到 15 个汉字概括这次对话的主题。
要求：
- 只输出标题文字，不要加引号、不要加标点、不要换行、不要加任何前缀如"标题："。
- 标题应描述话题本身，例如"食堂退款流程"、"转专业申请条件"，而非"用户询问"或"AI回答"。
- 不要超过 15 个汉字。`;

export interface TitleInput {
  userText: string;
  assistantText?: string;
}

/** 清洗 LLM 输出：去引号换行、截断到 15 字 */
export function sanitizeTitle(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[\r\n"]/g, "").trim();
  if (!cleaned) return fallback.slice(0, 15);
  return cleaned.slice(0, 15);
}

/**
 * 生成会话标题。
 * @throws 模型调用失败时抛错，由调用方降级为 sanitizeTitle(fallback)
 */
export async function generateTitle(input: TitleInput): Promise<string> {
  const result = await generateText({
    model: chatClient.chat(CHAT_MODEL),
    system: SYSTEM_PROMPT,
    prompt: `用户问题：${input.userText}\n\n助手回答：${input.assistantText ?? ""}`,
  });
  return sanitizeTitle(result.text, input.userText);
}
