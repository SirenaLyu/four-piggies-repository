/**
 * approval part 工具函数 —— 在 UIMessage parts 中查找待确认的工具调用
 *
 * AI SDK v7 的审批流程：streamText 输出 tool-approval-request part
 * （出现在对应 tool-XXX part 的 approval 字段中），前端渲染确认卡片，
 * 用户批准/拒绝后调 addToolApprovalResponse 回传。
 */

import type { UIMessage } from "ai";

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** 提取消息中所有待确认的工具调用（state === 'approval-requested'） */
export function getPendingApprovals(message: UIMessage): PendingApproval[] {
  const result: PendingApproval[] = [];
  for (const part of message.parts as Array<Record<string, unknown>>) {
    if (
      typeof part.type === "string" &&
      part.type.startsWith("tool-") &&
      typeof part.state === "string" &&
      part.state === "approval-requested"
    ) {
      const approval = (part as { approval?: { id?: string } }).approval;
      result.push({
        approvalId: String(approval?.id ?? ""),
        toolCallId: String(part.toolCallId ?? ""),
        toolName: String(part.type).slice("tool-".length),
        input: (part as { input?: unknown }).input,
      });
    }
  }
  return result;
}

/** 判断消息是否含待确认工具调用 */
export function hasPendingApprovals(message: UIMessage): boolean {
  return getPendingApprovals(message).length > 0;
}

/** 生成确认卡片的摘要文本（命令/写入路径 + 输入预览） */
export function summarizeApproval(a: PendingApproval): string {
  const input = a.input as Record<string, unknown> | null;
  if (!input) return a.toolName;
  if (a.toolName === "execute_command") {
    return `命令: ${String(input.command ?? "")}` + (input.cwd ? `\ncwd: ${input.cwd}` : "");
  }
  if (a.toolName === "write_file") {
    const content = String(input.content ?? "");
    const preview = content.length > 200 ? content.slice(0, 200) + "…" : content;
    return `写入: ${String(input.path ?? "")}\n\n${preview}`;
  }
  return JSON.stringify(input, null, 2).slice(0, 500);
}
