const CAMPUS_ENTITY =
  /中国科学技术大学|中科大|科大|USTC|校园|校内|教务|本科生院|研究生院/i;

const STABLE_CAMPUS_TOPIC =
  /食堂|餐厅|美食广场|宿舍|图书馆|借书|还书|选课|课程|学分|班车|校车|校历|开学|放假|奖学金|助学金|校园卡|一卡通/i;

const REALTIME_QUERY =
  /最新|最近|近期|刚刚|今日|今天|明天|本周|本月|今年|实时|当前|现在|天气|新闻|通知|公告|公示|讲座|活动|截止|变更/i;

const STABLE_DOCUMENT_FIELD_LOOKUP =
  /(?:通知|公告|公示).{0,30}(?:联系人|联系方式|联系电话|办公地点)|(?:联系人|联系方式|联系电话|办公地点).{0,30}(?:通知|公告|公示)/i;

const EXPLICIT_REALTIME_MARKER =
  /最新|最近|近期|刚刚|今日|今天|明天|本周|本月|今年|实时|当前|现在|天气|新闻|讲座|活动|截止|变更/i;

const AGENT_FILE_INTENT =
  /(?:读取|阅读|查看|看看|浏览|打开|分析|检查|搜索|查找|列出|修改|编辑|写入|创建|新建|删除|运行|执行|测试|构建|修复|重构).{0,16}(?:文件|目录|文件夹|项目|代码|仓库|脚本|命令|测试|构建)|(?:文件|目录|文件夹|项目|代码|仓库|脚本|命令).{0,16}(?:读取|阅读|查看|看看|浏览|分析|检查|搜索|查找|列出|修改|编辑|写入|创建|新建|删除|运行|执行|测试|构建|修复|重构)|(?:npm|pnpm|yarn|git|node|python)(?:\.exe)?\b|[A-Za-z]:\\|\/(?:home|Users|workspace|project)\//i;

const AGENT_MUTATION_INTENT =
  /修改|编辑|写入|创建|新建|删除|重命名|移动|运行|执行|测试|构建|安装|修复|重构/i;

/**
 * 稳定且主题明确的校园问题可在模型调用前直接检索知识库，省去一次
 * “模型决定调用哪个工具”的网络往返。实时问题仍走原有工具选择流程。
 */
export function shouldPrefetchKnowledge(query: string): boolean {
  const normalized = query.trim();
  const stableDocumentFieldLookup =
    STABLE_DOCUMENT_FIELD_LOOKUP.test(normalized) &&
    !EXPLICIT_REALTIME_MARKER.test(normalized);
  return (
    normalized.length >= 2 &&
    normalized.length <= 200 &&
    (CAMPUS_ENTITY.test(normalized) || STABLE_CAMPUS_TOPIC.test(normalized)) &&
    (!REALTIME_QUERY.test(normalized) || stableDocumentFieldLookup)
  );
}

/** Agent 开关是能力上限；只有当前问题确实涉及本地项目时才注册高风险工具。 */
export function shouldUseAgentTools(query: string): boolean {
  const normalized = query.trim();
  return normalized.length > 0 && AGENT_FILE_INTENT.test(normalized);
}

/** 简单读取保持较短链路；修改、测试和执行类任务允许更多工具步骤。 */
export function agentFinalAnswerStep(query: string): number {
  return AGENT_MUTATION_INTENT.test(query) ? 7 : 5;
}

export function modelHistoryLimit(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 24;
  return Math.min(50, Math.max(6, Math.floor(parsed)));
}

/** 只向模型发送最近若干条消息；浏览器中的完整会话记录保持不变。 */
export function selectRecentMessages<T extends { role?: string }>(
  messages: T[],
  limit: number,
): T[] {
  if (messages.length <= limit) return messages;

  const recent = messages.slice(-limit);
  const firstUserIndex = recent.findIndex((message) => message.role === "user");
  return firstUserIndex > 0 ? recent.slice(firstUserIndex) : recent;
}
