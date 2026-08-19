/**
 * Prompt 模板选择器 —— 把检索结果映射为 system prompt
 *
 * 纯函数、无 IO，输入检索产物，输出对应的 system prompt 文本。
 * 模板本体在 lib/prompts.ts，这里只做"选哪套模板"的决策：
 *   - supabase 后端 → PROMPT_TEMPLATES（检索结果带【校历】等中文前缀）
 *   - dify 后端    → DIFY_PROMPT_TEMPLATES / difyFallbackPrompt（key: value 格式）
 *   - tavily 后端  → TAVILY_PROMPT（官网搜索结果）
 * 被 app/api/chat/route.ts 调用。
 */

import {
  PROMPT_TEMPLATES,
  DIFY_PROMPT_TEMPLATES,
  difyFallbackPrompt,
  TAVILY_PROMPT,
} from "../prompts";
import { difySupports } from "./dify";
import type { RouteResult } from "./types";

export function buildSystemPrompt(
  result: RouteResult,
  userQuery: string,
): string {
  const { context, primary, usedBackend } = result;

  switch (usedBackend) {
    case "dify":
      // Dify 单库兜底：primary 在 5 类内用对应模板，否则用跨库撒网模板
      return difySupports(primary)
        ? DIFY_PROMPT_TEMPLATES[primary]({ context, query: userQuery })
        : difyFallbackPrompt({ context, query: userQuery });
    case "tavily":
      return TAVILY_PROMPT({ context, query: userQuery });
    case "supabase":
    default:
      return PROMPT_TEMPLATES[primary]({ context, query: userQuery });
  }
}
