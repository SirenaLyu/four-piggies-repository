/**
 * 智能体能力说明 —— 追加到 system prompt 的两段
 *
 * buildAgentPromptSections()：澄清指南 + 工具使用说明。
 * 在 chat route 中拼接到检索 prompt 之后。
 */

/** 澄清指南：三档行为 + 追问上限 */
const CLARIFICATION_RULES = `## 主动澄清规则
- 简单校园问答（校历/班车/图书馆/奖学金/地点/课程）：直接检索作答，不要追问。
- 信息不足或需求模糊时：主动提出 1 个具体澄清问题（如"你指的转专业是大一还是研一？"），不要列问题清单。
- 文件/执行类需求：先澄清目标路径、预期产出，再调用工具。
- 最多连续追问 2 次，第 3 次仍不明确时给出最佳猜测答案并说明假设。
- 不要为简单问题追问（如"图书馆几点开门"）。`;

/** 工具使用说明：能力边界 + 授权提示 */
const TOOLS_RULES = `## 文件与执行能力
- 你有四个工具：list_dir、read_file 直接执行；write_file、execute_command 需要用户批准。
- 所有路径必须位于用户授权目录内；工具返回"路径不在授权目录内"时，告诉用户"需要授权访问 <目录>"，等用户确认授权后重新调用工具。
- 运行代码的模式：先 write_file 写入脚本，再 execute_command 执行（如 node script.js）。
- 每次动手前，用一句话说明你准备做什么、为什么要做。`;

export function buildAgentPromptSections(): string {
  return `\n\n${CLARIFICATION_RULES}\n\n${TOOLS_RULES}`;
}
