/**
 * 消息文本提取 —— 兼容新旧两种消息格式
 *
 * 旧格式：{ content: "..." }
 * 新格式（AI SDK v7 UIMessage）：{ parts: [{ type: "text", text: "..." }] }
 *
 * chat / summarize / export 三个路由共用，避免各处重复实现。
 */

/** 从任意消息对象中提取纯文本内容 */
export function extractMessageText(m: Record<string, unknown>): string {
  if (typeof m.content === "string" && m.content.length > 0) return m.content;
  if (Array.isArray(m.parts)) {
    return (m.parts as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
  }
  return "";
}

/** 把 { role, text } 形式的消息数组拼成对话记录文本（供 LLM 读取） */
export function buildTranscript(
  messages: Array<{ role: "user" | "assistant"; text: string }>,
): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.text}`)
    .join("\n\n");
}

/**
 * 发送前的消息清理：移除仍处于 approval-requested 状态的整个工具 part。
 *
 * 若保留 tool-call part 而不回传 approval-response，AI SDK 服务端
 * validateApprovedToolApprovals 会抛 MissingToolResultsError。
 * 因此用户未响应确认就发新消息时，整条待确认工具调用一并丢弃
 * （卡片自然消失，模型在下一轮可重新发起）。
 */
export function stripPendingApprovals<T extends { parts?: Array<Record<string, unknown>> }>(
  messages: T[],
): T[] {
  return messages.map((m) => {
    if (!m.parts) return m;
    const parts = m.parts.filter((p) => {
      if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        return p.state !== "approval-requested";
      }
      return true;
    });
    return { ...m, parts: parts as T["parts"] };
  });
}
