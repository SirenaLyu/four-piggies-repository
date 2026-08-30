import type { UIMessage } from "ai";

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export function getPendingApprovals(message: UIMessage): PendingApproval[] {
  const approvals: PendingApproval[] = [];
  for (const part of message.parts as Array<Record<string, unknown>>) {
    if (
      typeof part.type === "string" &&
      part.type.startsWith("tool-") &&
      part.state === "approval-requested"
    ) {
      const approval = part.approval as { id?: string } | undefined;
      approvals.push({
        approvalId: String(approval?.id ?? ""),
        toolCallId: String(part.toolCallId ?? ""),
        toolName: part.type.slice("tool-".length),
        input: part.input,
      });
    }
  }
  return approvals;
}

export function hasPendingApprovals(message: UIMessage): boolean {
  return getPendingApprovals(message).length > 0;
}

export function summarizeApproval(approval: PendingApproval): string {
  const input = approval.input as Record<string, unknown> | null;
  if (!input) return approval.toolName;
  if (approval.toolName === "execute_command") {
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    return `程序: ${String(input.executable ?? "")}\n参数: ${JSON.stringify(args)}` +
      (input.cwd ? `\ncwd: ${String(input.cwd)}` : "");
  }
  if (approval.toolName === "write_file") {
    const content = String(input.content ?? "");
    const preview = content.length > 200 ? `${content.slice(0, 200)}…` : content;
    return `写入: ${String(input.path ?? "")}` +
      (input.cwd ? `\ncwd: ${String(input.cwd)}` : "") +
      `\n\n${preview}`;
  }
  return JSON.stringify(input, null, 2).slice(0, 500);
}

export function stripPendingApprovals<
  T extends { parts?: Array<Record<string, unknown>> },
>(messages: T[]): T[] {
  return messages.map((message) => {
    if (!message.parts) return message;
    const parts = message.parts.filter(
      (part) =>
        !(
          typeof part.type === "string" &&
          part.type.startsWith("tool-") &&
          part.state === "approval-requested"
        ),
    );
    return { ...message, parts: parts as T["parts"] };
  });
}
