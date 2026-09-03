const CAMPUS_ENTITY =
  /中国科学技术大学|中科大|科大|USTC|校园|校内|教务|本科生院|研究生院/i;

const STABLE_CAMPUS_TOPIC =
  /食堂|餐厅|宿舍|图书馆|借书|还书|选课|课程|学分|班车|校车|校历|开学|放假|奖学金|助学金|校园卡|一卡通/i;

const REALTIME_QUERY =
  /最新|最近|近期|刚刚|今日|今天|明天|本周|本月|今年|实时|当前|现在|天气|新闻|通知|公告|公示|讲座|活动|截止|变更/i;

/**
 * 稳定且主题明确的校园问题可在模型调用前直接检索知识库，省去一次
 * “模型决定调用哪个工具”的网络往返。实时问题仍走原有工具选择流程。
 */
export function shouldPrefetchKnowledge(query: string): boolean {
  const normalized = query.trim();
  return (
    normalized.length >= 2 &&
    normalized.length <= 200 &&
    (CAMPUS_ENTITY.test(normalized) || STABLE_CAMPUS_TOPIC.test(normalized)) &&
    !REALTIME_QUERY.test(normalized)
  );
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
