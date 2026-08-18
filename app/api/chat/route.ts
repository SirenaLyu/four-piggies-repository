import { convertToModelMessages, createTextStreamResponse, embed, isStepCount, streamText } from "ai";
import { chatClient, embeddingClient, EMBEDDING_MODEL, CHAT_MODEL } from "../../lib/ai-clients";
import { classifyWithEmbedding } from "../../lib/classifier";
import { campusTools } from "../../lib/tools";

/**
 * 从消息中提取文本内容,兼容旧格式 { content } 和新格式 { parts: [{ type: "text", text }] }
 */
function extractMessageText(m: Record<string, unknown>): string {
  if (typeof m.content === "string" && m.content.length > 0) return m.content;
  if (Array.isArray(m.parts)) {
    return (m.parts as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
  }
  return "";
}

// ===== 统一 system prompt =====
//
// tool calling 重构后,不再需要按类目选模板 —— 工具 description 已经把"什么场景调我"
// 写清楚了,LLM 自己挑。这里只保留所有类目共享的输出格式约定 + 反幻觉底线。
//
// classifier 的余弦分数不再驱动路由,但作为 hint 传给 LLM(降低调错工具的概率),
// 实现在 POST handler 里。

const BASE_IDENTITY = `你是中国科学技术大学智能校园助手,名字叫"科大精灵",专门回答关于学校的问题。`;

const FORMAT_RULES = `回答格式约定:
- 用换行分条呈现,每条一个事件/班次/通知,不要把多个不相关条目挤在一行
- 字段标签用 emoji + 中文:📅 日期 / ⏰ 时间 / 📍 地点 / 📞 电话 / 🔗 链接 / 👤 联系人 / 📧 邮箱 / 🏷️ 类别 / 📝 备注
- 引用具体值,不要用"大概""可能"等模糊词修饰日期、时刻、电话等
- 若工具结果提供来源链接,在末尾以 "🔗 链接: <url>" 形式给出`;

const TOOL_GUIDE = `你可以调用以下工具获取准确信息(不要用训练知识臆测):
- search_calendar:校历/开学/放假/考试周(语义相似查询,适合"什么时候开学"这类问题)
- search_shuttle:班车时刻表(语义相似查询)
- search_notices:教务处通知(含选课/考试/毕业论文/助教岗位/教室开放)
- search_library_hours:图书馆开放时间
- search_scholarships:奖学金/助学金/助学贷款/勤工助学
- search_pois:校园地点(教学楼/食堂/宿舍/AED 等)
- search_courses:课程信息/课程代码
- find_substitute_courses:课程替代关系(等效课/换课)
- get_calendar_events_on_date:按具体日期(YYYY-MM-DD)查校历事件——回答"下周二/8月25日有课吗"这类问题用这个,不要用 search_calendar
- get_shuttle_on_day:按星期几精确过滤班车——回答"周末有班车吗""工作日班次"用这个,不要用 search_shuttle
- search_dify_fallback:跨 5 库兜底(仅当其他工具无结果时再用)

调用原则:
- 一次可以并行调多个工具(如同时问"图书馆在哪+几点开门"→ search_pois + search_library_hours)
- 多步问题(如"我下周二没课,找个自习教室,顺便告诉我附近食堂中餐时间")可分步调多个工具
- 用户说"下周二/这周五"等相对日期时,先用今天日期(系统已知)推算出具体 YYYY-MM-DD 再调 get_calendar_events_on_date
- 工具返回 results 为空时,告诉用户"暂无相关信息",不要编造`;

const NO_HALLUCINATION_FOOTER =
  '\n\n重要:若工具返回空结果或不足以回答,直接回复"暂无相关信息",禁止使用训练知识臆测日期、时刻、姓名、电话、金额等具体信息。';

function buildSystemPrompt(hint?: string): string {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10); // YYYY-MM-DD
  const weekdayStr = today.toLocaleDateString("zh-CN", { weekday: "long" });
  const dateSection = `\n当前日期:${todayStr}(${weekdayStr})。用户说"下周二/这周五/明天"等相对日期时,以此为准推算具体 YYYY-MM-DD。\n`;
  const hintSection = hint
    ? `\n参考:基于 embedding 分类器,这条问题最相关的类目可能是 ${hint}。这只是 hint,你可以根据问题自由选择工具,不必受此约束。\n`
    : "";
  return `${BASE_IDENTITY}${dateSection}${hintSection}

${TOOL_GUIDE}

${FORMAT_RULES}${NO_HALLUCINATION_FOOTER}`;
}

// ===== API 路由 =====

export async function POST(req: Request) {
  const body = await req.json();
  const messages = body.messages ?? [];

  // 取最后一条用户消息
  const lastUserMessage = messages
    .filter((m: { role: string }) => m.role === "user")
    .at(-1);

  const userQuery = lastUserMessage
    ? extractMessageText(lastUserMessage as Record<string, unknown>)
    : "";

  // 分类器作为 hint(异步,不阻塞 LLM):失败就不带 hint 直接走 LLM 自主决策
  let hint: string | undefined;
  if (userQuery) {
    try {
      const { embedding } = await embed({
        model: embeddingClient.embedding(EMBEDDING_MODEL),
        value: userQuery,
      });
      const { primary, secondary } = await classifyWithEmbedding(embedding, userQuery);
      hint =
        primary !== "fallback"
          ? secondary
            ? `${primary} 或 ${secondary}`
            : primary
          : undefined;
    } catch {
      // 分类器失败不影响主流程,LLM 自己决策
    }
  }

  const result = await streamText({
    model: chatClient.chat(CHAT_MODEL),
    system: buildSystemPrompt(hint),
    tools: campusTools,
    stopWhen: isStepCount(5),
    messages: await convertToModelMessages(messages),
  });

  return createTextStreamResponse({
    stream: result.textStream,
  });
}
