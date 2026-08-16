import { createClient } from "@supabase/supabase-js";
import { convertToModelMessages, createTextStreamResponse, embed, streamText } from "ai";
import { chatClient, embeddingClient, EMBEDDING_MODEL, CHAT_MODEL } from "../../lib/ai-clients";
import {
  classifyWithEmbedding,
  isCourseSubstituteQuery,
  extractCourseName,
  type Category,
} from "../../lib/classifier";
import { PROMPT_TEMPLATES } from "../../lib/prompts";

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

// ===== 各类检索:7 类功能各对应一路 RPC =====

/** 1. 校历(campus_calendar) */
async function searchCalendar(embedding: number[]): Promise<string> {
  const { data, error } = await supabase.rpc("match_calendar", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 8,
  });
  if (error || !data || data.length === 0) return "";
  return (data as Array<{
    academic_year: string | null;
    semester: string | null;
    start_date: string | null;
    end_date: string | null;
    event_title: string;
    source_url: string | null;
  }>)
    .map((e) => {
      const lines = [`【校历】${e.event_title}`];
      if (e.academic_year || e.semester)
        lines.push(`${e.academic_year ?? ""}${e.semester ? ` ${e.semester}学期` : ""}`.trim());
      if (e.start_date)
        lines.push(`日期:${e.start_date}${e.end_date && e.end_date !== e.start_date ? ` ~ ${e.end_date}` : ""}`);
      if (e.source_url) lines.push(`来源:${e.source_url}`);
      return lines.join(" ");
    })
    .join("\n\n---\n\n");
}

/** 2. 班车(campus_shuttle) */
async function searchShuttle(embedding: number[]): Promise<string> {
  const { data, error } = await supabase.rpc("match_shuttle", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 10,
  });
  if (error || !data || data.length === 0) return "";
  return (data as Array<{
    route_name: string;
    direction: string | null;
    departure: string | null;
    arrival: string | null;
    depart_time: string | null;
    arrive_time: string | null;
    weekday_only: string | null;
    period: string | null;
    note: string | null;
  }>)
    .map((s) => {
      const lines = [`【班车】${s.route_name}`];
      if (s.direction) lines.push(s.direction);
      if (s.departure && s.arrival) lines.push(`${s.departure}→${s.arrival}`);
      if (s.depart_time)
        lines.push(`${s.depart_time}发车${s.arrive_time ? ` ${s.arrive_time}到` : ""}`);
      if (s.weekday_only) lines.push(s.weekday_only === "true" ? "工作日" : "每日");
      if (s.period) lines.push(`时段:${s.period}`);
      if (s.note) lines.push(`备注:${s.note}`);
      return lines.join(" ");
    })
    .join("\n\n---\n\n");
}

/** 3. 教务通知(campus_notices) */
async function searchNotices(embedding: number[]): Promise<string> {
  const { data, error } = await supabase.rpc("match_notices", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 5,
  });
  if (error || !data || data.length === 0) return "";
  return (data as Array<{
    title: string;
    url: string | null;
    publish_date: string | null;
    author: string | null;
    category: string | null;
    body_preview: string | null;
  }>)
    .map((n) => {
      const lines = [`【通知】${n.title}`];
      if (n.publish_date) lines.push(`发布:${n.publish_date}`);
      if (n.author) lines.push(`发布者:${n.author}`);
      if (n.category) lines.push(`类别:${n.category}`);
      if (n.body_preview) lines.push(`摘要:${n.body_preview}`);
      if (n.url) lines.push(`链接:${n.url}`);
      return lines.join(" ");
    })
    .join("\n\n---\n\n");
}

/** 4. 图书馆(campus_library_hours) */
async function searchLibraryHours(embedding: number[]): Promise<string> {
  const { data, error } = await supabase.rpc("match_library_hours", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 8,
  });
  if (error || !data || data.length === 0) return "";
  return (data as Array<{
    branch: string;
    floor: string | null;
    service: string | null;
    weekday_hours: string | null;
    weekend_hours: string | null;
    phone: string | null;
    source_url: string | null;
  }>)
    .map((l) => {
      const lines = [`【图书馆】${l.branch}`];
      if (l.floor) lines.push(`楼层:${l.floor}`);
      if (l.service) lines.push(`服务:${l.service}`);
      if (l.weekday_hours) lines.push(`工作日:${l.weekday_hours}`);
      if (l.weekend_hours) lines.push(`周末:${l.weekend_hours}`);
      if (l.phone) lines.push(`电话:${l.phone}`);
      return lines.join(" ");
    })
    .join("\n\n---\n\n");
}

/** 5. 奖学金(campus_scholarships) */
async function searchScholarships(embedding: number[]): Promise<string> {
  const { data, error } = await supabase.rpc("match_scholarships", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 5,
  });
  if (error || !data || data.length === 0) return "";
  return (data as Array<{
    title: string;
    url: string | null;
    publish_date: string | null;
    publisher: string | null;
    category: string | null;
    body_preview: string | null;
  }>)
    .map((s) => {
      const lines = [`【奖学金】${s.title}`];
      if (s.publish_date) lines.push(`发布:${s.publish_date}`);
      if (s.publisher) lines.push(`发布者:${s.publisher}`);
      if (s.category) lines.push(`类别:${s.category}`);
      if (s.body_preview) lines.push(`摘要:${s.body_preview}`);
      if (s.url) lines.push(`链接:${s.url}`);
      return lines.join(" ");
    })
    .join("\n\n---\n\n");
}

/** 6. POI(校园建筑/食堂/宿舍/AED 等) */
async function searchPois(embedding: number[]): Promise<string> {
  const { data, error } = await supabase.rpc("match_pois", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 6,
  });
  if (error || !data || data.length === 0) return "";

  return (data as Array<{
    title: string;
    address: string | null;
    category: string | null;
    xiaoqu: string | null;
    description: string | null;
    telephone: string | null;
    url: string | null;
  }>)
    .map((p) => {
      const lines = [`【校园地点】${p.title}`];
      if (p.category) lines.push(`分类:${p.category}`);
      if (p.xiaoqu) lines.push(`校区:${p.xiaoqu}`);
      if (p.address) lines.push(`地址:${p.address}`);
      if (p.telephone) lines.push(`电话:${p.telephone}`);
      if (p.description && p.description !== "暂无介绍！")
        lines.push(`简介:${p.description}`);
      if (p.url) lines.push(`链接:${p.url}`);
      return lines.join(" ");
    })
    .join("\n\n---\n\n");
}

/** 7. 课程信息(campus_courses) */
async function searchCourses(embedding: number[]): Promise<string> {
  const { data, error } = await supabase.rpc("match_courses", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 5,
  });
  if (error || !data || data.length === 0) return "";

  return (data as Array<{
    cn: string;
    en: string | null;
    code: string | null;
    period: number | null;
    credits: number | null;
    role: string | null;
  }>)
    .map((c) => {
      const lines = [`【课程】${c.cn}`];
      if (c.en) lines.push(`(${c.en})`);
      if (c.code) lines.push(`代码:${c.code}`);
      if (c.period) lines.push(`学时:${c.period}`);
      if (c.credits != null) lines.push(`学分:${c.credits}`);
      if (c.role) lines.push(`角色:${c.role}`);
      return lines.join(" ");
    })
    .join("\n\n---\n\n");
}

/** 8. 课程替代关系(文本模糊匹配,需课程名而非 embedding) */
async function searchSubstitutes(courseText: string): Promise<string> {
  if (!courseText) return "";
  const { data, error } = await supabase.rpc("find_substitute_courses", {
    p_course_text: courseText,
  });
  if (error || !data || data.length === 0) return "";

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

/** 9. 通用校园文档(campus_documents,仅 fallback 用) */
async function searchDocuments(embedding: number[]): Promise<string> {
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: embedding,
    match_threshold: 0.5,
    match_count: 5,
  });
  if (error || !data || data.length === 0) return "";
  return (data as Array<{ title: string; content: string }>)
    .map((doc) => `【校园资料】${doc.title ?? ""}\n${doc.content}`)
    .join("\n\n---\n\n");
}

/**
 * 按类目分发到对应 RPC。courses 类目内若命中课程替代关键词,附加替代查询。
 */
async function searchOne(
  category: Category,
  embedding: number[],
  query: string,
): Promise<string> {
  switch (category) {
    case "calendar":
      return searchCalendar(embedding);
    case "shuttle":
      return searchShuttle(embedding);
    case "notices":
      return searchNotices(embedding);
    case "library":
      return searchLibraryHours(embedding);
    case "scholarships":
      return searchScholarships(embedding);
    case "poi":
      return searchPois(embedding);
    case "courses": {
      const courseText = await searchCourses(embedding);
      if (isCourseSubstituteQuery(query)) {
        const subText = await searchSubstitutes(extractCourseName(query));
        return [courseText, subText].filter(Boolean).join("\n\n===\n\n");
      }
      return courseText;
    }
    case "fallback":
      return searchDocuments(embedding);
  }
}

/**
 * 分类路由:embed 一次 → 分类 → 按类调 1-2 路 RPC → 拼接上下文。
 */
async function searchRouted(userQuery: string): Promise<{
  context: string;
  primary: Category;
}> {
  const { embedding } = await embed({
    model: embeddingClient.embedding(EMBEDDING_MODEL),
    value: userQuery,
  });

  const { primary, secondary } = await classifyWithEmbedding(embedding);
  const cats: Category[] = [primary, secondary].filter(
    (c): c is Category => c !== null && c !== "fallback",
  );
  // fallback 时仍查通用文档
  if (cats.length === 0) cats.push("fallback");

  const parts = await Promise.all(cats.map((c) => searchOne(c, embedding, userQuery)));
  const context = parts.filter(Boolean).join("\n\n===\n\n");
  return { context, primary };
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

  // 分类路由 → 1-2 路 RPC → 上下文 + 主类目
  const { context, primary } = userQuery
    ? await searchRouted(userQuery)
    : { context: "", primary: "fallback" as Category };

  // 按主类目选专用 prompt 模板
  const systemPrompt = PROMPT_TEMPLATES[primary]({ context, query: userQuery });

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