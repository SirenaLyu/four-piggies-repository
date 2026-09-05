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

export function summarizeApproval(approval: PendingApproval, memories: Array<{ id: string; content: string }> = []): string {
  const input = approval.input as Record<string, unknown> | null;
  if (!input) return approval.toolName;
  if (approval.toolName === "update_memory") {
    const change = input.change as Record<string, unknown> | undefined;
    if (!change) return "记忆变更";
    if (change.action === "profile") return `更新基础记忆\n专业：${change.major}\n年级：${change.grade}`;
    if (change.action === "add") return `新增记忆：${change.content}`;
    const previous = memories.find((entry) => entry.id === change.id)?.content ?? `条目 ${change.id}`;
    if (change.action === "update") return `修改记忆\n原内容：${previous}\n新内容：${change.content}`;
    if (change.action === "delete") return `删除记忆：${previous}`;
    return "跳过首次资料填写";
  }
  if (approval.toolName === "execute_command") {
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    return `程序: ${String(input.executable ?? "")}\n参数: ${JSON.stringify(args)}` +
      (input.cwd ? `\ncwd: ${String(input.cwd)}` : "");
  }
  if (approval.toolName === "write_file") {
    const content = String(input.content ?? "");
    const preview = content.length > 600 ? `${content.slice(0, 600)}…` : content;
    return `写入: ${String(input.path ?? "")}` +
      (input.cwd ? `\ncwd: ${String(input.cwd)}` : "") +
      `\n模式: ${input.overwrite ? "覆盖（需要哈希校验）" : "仅新建"}` +
      `\n字符数: ${content.length}` +
      `\n\n${preview}`;
  }
  if (approval.toolName === "apply_patch") {
    const replacements = Array.isArray(input.replacements)
      ? input.replacements as Array<Record<string, unknown>>
      : [];
    const preview = replacements.slice(0, 3).map((replacement, index) => {
      const before = String(replacement.oldText ?? "").slice(0, 240);
      const after = String(replacement.newText ?? "").slice(0, 240);
      return `变更 ${index + 1}\n- ${before}\n+ ${after}`;
    }).join("\n\n");
    return `补丁目标: ${String(input.path ?? "")}\n哈希: ${String(input.expectedSha256 ?? "").slice(0, 12)}…\n变更数: ${replacements.length}\n\n${preview}`;
  }
  if (approval.toolName === "read_file") {
    return `读取并发送到当前模型 API: ${String(input.path ?? "")}\n行范围: ${String(input.startLine ?? 1)}–${String(input.endLine ?? "自动上限")}`;
  }
  if (approval.toolName === "search_text") {
    return `在本地文件中搜索并发送匹配片段到当前模型 API\n目录: ${String(input.root ?? "")}\n关键词: ${String(input.query ?? "")}\n文件: ${String(input.filePattern ?? "全部文本文件")}`;
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
