import { createClient } from "@supabase/supabase-js";
import { convertToModelMessages, createTextStreamResponse, embed, streamText } from "ai";
import { chatClient, embeddingClient, EMBEDDING_MODEL, CHAT_MODEL } from "../../lib/ai-clients";

// ===== Supabase 客户端 =====
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
);

// ===== 工具函数 =====

/**
 * 从消息中提取文本内容，兼容旧格式 { content } 和新格式 { parts: [{ type: "text", text }] }
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

/**
 * 简单意图检测：判断问题是否与"课程替代"相关。
 * 命中关键词时，会额外查询 campus_substitute_pool。
 */
function isCourseSubstituteQuery(q: string): boolean {
  return /替代|代替|替换|换课|等效课程|学分互认|能不能代替|可以替代|能替代|可替代/.test(q);
}

// ===== 三类来源的向量检索 =====

/** 1. 通用校园文档(原有 campus_documents) */
async function searchDocuments(embedding: number[]): Promise<string> {
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: embedding,
    match_threshold: 0.5,
    match_count: 5,
  });

  if (error || !data || data.length === 0) return "";

  return data
    .map(
      (doc: { title: string; content: string }) =>
        `【校园资料】${doc.title ?? ""}\n${doc.content}`,
    )
    .join("\n\n---\n\n");
}

/** 2. POI(校园建筑/食堂/宿舍/AED 等) */
async function searchPois(embedding: number[]): Promise<string> {
  const { data, error } = await supabase.rpc("match_pois", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 6,
  });
  if (error || !data || data.length === 0) return "";

  return data
    .map(
      (p: {
        title: string;
        address: string | null;
        category: string | null;
        xiaoqu: string | null;
        description: string | null;
        telephone: string | null;
        url: string | null;
      }) => {
        const lines = [`【校园地点】${p.title}`];
        if (p.category) lines.push(`分类:${p.category}`);
        if (p.xiaoqu) lines.push(`校区:${p.xiaoqu}`);
        if (p.address) lines.push(`地址:${p.address}`);
        if (p.telephone) lines.push(`电话:${p.telephone}`);
        if (p.description && p.description !== "暂无介绍！")
          lines.push(`简介:${p.description}`);
        if (p.url) lines.push(`链接:${p.url}`);
        return lines.join(" ");
      },
    )
    .join("\n\n---\n\n");
}

/** 3. 课程信息 */
async function searchCourses(embedding: number[]): Promise<string> {
  const { data, error } = await supabase.rpc("match_courses", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 5,
  });
  if (error || !data || data.length === 0) return "";

  return data
    .map(
      (c: {
        cn: string;
        en: string | null;
        code: string | null;
        period: number | null;
        credits: number | null;
        role: string | null;
      }) => {
        const lines = [`【课程】${c.cn}`];
        if (c.en) lines.push(`(${c.en})`);
        if (c.code) lines.push(`代码:${c.code}`);
        if (c.period) lines.push(`学时:${c.period}`);
        if (c.credits != null) lines.push(`学分:${c.credits}`);
        if (c.role) lines.push(`角色:${c.role}`);
        return lines.join(" ");
      },
    )
    .join("\n\n---\n\n");
}

/** 4. 课程替代关系(只在用户明确询问时调用,基于课程文本模糊匹配) */
async function searchSubstitutes(courseText: string): Promise<string> {
  if (!courseText) return "";
  const { data, error } = await supabase.rpc("find_substitute_courses", {
    p_course_text: courseText,
  });
  if (error || !data || data.length === 0) return "";

  // 按查询课程聚合
  const byQuery = new Map<string, string[]>();
  for (const r of data as Array<{
    query_course_cn: string;
    query_course_code: string | null;
    substitute_cn: string | null;
    substitute_code: string | null;
    original_cn: string | null;
    original_code: string | null;
  }>) {
    const key = `${r.query_course_cn}${r.query_course_code ? `(${r.query_course_code})` : ""}`;
    if (!byQuery.has(key)) byQuery.set(key, []);
    const sub = r.substitute_cn
      ? `${r.substitute_cn}${r.substitute_code ? `(${r.substitute_code})` : ""}`
      : null;
    const orig = r.original_cn
      ? `${r.original_cn}${r.original_code ? `(${r.original_code})` : ""}`
      : null;
    if (sub && orig) byQuery.get(key)!.push(`替代课:${sub} ← 原课:${orig}`);
  }

  return Array.from(byQuery.entries())
    .map(([k, v]) => `【课程替代】${k}\n${v.slice(0, 5).join("\n")}`)
    .join("\n\n---\n\n");
}

/**
 * 综合检索：并行查 POI / 课程 / 通用文档，按意图可能附加课程替代查询。
 */
async function searchRelevantDocuments(userQuery: string): Promise<string> {
  // 1. 一次 embedding,三处复用
  const { embedding } = await embed({
    model: embeddingClient.embedding(EMBEDDING_MODEL),
    value: userQuery,
  });

  // 2. 并行查三张表
  const [docText, poiText, courseText] = await Promise.all([
    searchDocuments(embedding),
    searchPois(embedding),
    searchCourses(embedding),
  ]);

  // 3. 意图命中时再查替代池 — 从 userQuery 抠出课程名
  //    匹配两种语序:
  //      "X 能替代 什么课"   → 课程名 X 在关键词前
  //      "X 替代 Y"          → 课程名 X 在关键词前
  //      "能替代 X 吗"       → 课程名 X 在关键词后
  //    去掉疑问词/助词后取剩余 token,再 fallback 用整句
  let substituteText = "";
  if (isCourseSubstituteQuery(userQuery)) {
    const cleaned = userQuery
      .replace(/[???！!。.,，、]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // 先尝试:课程名在关键词前
    const beforeMatch = cleaned.match(/^(.+?)\s*(?:能|可以|可)?(?:替代|代替|替换|换课|等效)/);
    // 再尝试:课程名在关键词后
    const afterMatch = cleaned.match(/(?:替代|代替|替换|换课|等效)(?:什么|哪些|啥|成|为|做)?\s*(.+)$/);
    const courseName =
      (beforeMatch?.[1] && beforeMatch[1].length >= 2 ? beforeMatch[1] : "") ||
      (afterMatch?.[1] && afterMatch[1].length >= 2 ? afterMatch[1] : "") ||
      cleaned;
    substituteText = await searchSubstitutes(courseName);
  }

  return [docText, poiText, courseText, substituteText]
    .filter(Boolean)
    .join("\n\n===\n\n");
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

  // 用 embeddingClient 转向量 → Supabase 向量搜索 → 拼接结果
  const context = userQuery
    ? await searchRelevantDocuments(userQuery)
    : "";

  // 拼接系统提示
  const systemPrompt = `你是中国科学技术大学智能校园助手，名字叫"科大精灵"，专门回答关于学校的问题。

你可以参考以下三类检索结果:
- 【校园资料】人工整理的校园政策、流程等文本
- 【校园地点】食堂/宿舍/教学楼/AED/出入口等校园 POI(地址、电话、简介)
- 【课程】课程名、代码、学时、学分
- 【课程替代】替代课与原课的对应关系

请基于上述资料回答。若资料不足或不确定,请如实说明。涉及具体地点/电话/课程代码时,优先采用检索结果,不要臆造。

${context || "（未找到相关学校资料，请根据你的知识回答）"}`;

  // 用 chatClient 流式生成回答
  const result = await streamText({
    model: chatClient.chat(CHAT_MODEL),
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
  });

  return createTextStreamResponse({
    stream: result.textStream,
  });
}