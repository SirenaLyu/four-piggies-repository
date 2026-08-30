const CLARIFICATION_RULES = `## 主动澄清规则
- 信息不足或需求模糊时，主动提出 1 个具体澄清问题，不要列问题清单。
- 文件/执行类需求先确认目标路径和预期产出；最多连续追问 2 次。`;

const TOOLS_RULES = `## 文件与执行能力
- list_dir、read_file 可直接执行；write_file、execute_command 需要用户批准。
- 所有路径必须位于用户授权目录和服务端允许根目录内。
- execute_command 使用 executable + args 数组，不支持 Shell 管道、重定向或命令拼接。
- 每次调用文件工具前，用一句话说明准备做什么。`;

export function buildAgentPromptSections(): string {
  return `\n\n${CLARIFICATION_RULES}\n\n${TOOLS_RULES}`;
}
