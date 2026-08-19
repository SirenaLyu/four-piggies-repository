/**
 * Supabase 检索层 —— 9 路 match_* RPC 的封装
 *
 * 每张校园数据表对应一个检索函数，职责：
 *   1. 调用对应的 Supabase RPC（pgvector 余弦相似度检索）
 *   2. 把行数据格式化成带中文前缀的上下文文本（如【校历】xxx）
 *
 * 全部函数返回空串表示无命中，由上层（router.ts）决定是否降级到 Dify/Tavily。
 * 被 lib/retrieval/router.ts 调用。
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * 模块级客户端单例，首次 import 时创建。
 * 环境变量缺失时用占位值兜底（RPC 调用会失败并返回空，触发上层降级到 Dify/Tavily），
 * 避免"未配置 Supabase 的环境连构建/启动都过不去"。
 */
export const supabase: SupabaseClient = createClient(
  process.env.SUPABASE_URL ?? "https://placeholder.supabase.co",
  process.env.SUPABASE_ANON_KEY ?? "placeholder-anon-key",
);

// ===== 各表行类型（与 supabase/migrations 中的表结构对应） =====

interface CalendarRow {
  academic_year: string | null;
  semester: string | null;
  start_date: string | null;
  end_date: string | null;
  event_title: string;
  source_url: string | null;
}

interface ShuttleRow {
  route_name: string;
  direction: string | null;
  departure: string | null;
  arrival: string | null;
  depart_time: string | null;
  arrive_time: string | null;
  weekday_only: string | null;
  period: string | null;
  note: string | null;
}

interface NoticeRow {
  title: string;
  url: string | null;
  publish_date: string | null;
  author: string | null;
  category: string | null;
  body_preview: string | null;
}

interface LibraryHoursRow {
  branch: string;
  floor: string | null;
  service: string | null;
  weekday_hours: string | null;
  weekend_hours: string | null;
  phone: string | null;
  source_url: string | null;
}

interface ScholarshipRow {
  title: string;
  url: string | null;
  publish_date: string | null;
  publisher: string | null;
  category: string | null;
  body_preview: string | null;
}

interface PoiRow {
  title: string;
  address: string | null;
  category: string | null;
  xiaoqu: string | null;
  description: string | null;
  telephone: string | null;
  url: string | null;
}

interface CourseRow {
  cn: string;
  en: string | null;
  code: string | null;
  period: number | null;
  credits: number | null;
  role: string | null;
}

interface DocumentRow {
  title: string | null;
  content: string;
}

// ===== 通用 RPC 调用辅助 =====

/** 调用一个 match_* RPC，失败或无命中时返回空数组 */
async function callMatchRpc<T>(
  rpcName: string,
  queryEmbedding: number[],
  matchCount: number,
): Promise<T[]> {
  const { data, error } = await supabase.rpc(rpcName, {
    query_embedding: queryEmbedding,
    match_threshold: 0.4,
    match_count: matchCount,
  });
  if (error || !data || data.length === 0) return [];
  return data as T[];
}

// ===== 1. 校历（campus_calendar） =====

export async function searchCalendar(embedding: number[]): Promise<string> {
  const rows = await callMatchRpc<CalendarRow>("match_calendar", embedding, 8);
  return rows
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

// ===== 2. 班车（campus_shuttle） =====

export async function searchShuttle(embedding: number[]): Promise<string> {
  const rows = await callMatchRpc<ShuttleRow>("match_shuttle", embedding, 10);
  return rows
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

// ===== 3. 教务通知（campus_notices） =====

export async function searchNotices(embedding: number[]): Promise<string> {
  const rows = await callMatchRpc<NoticeRow>("match_notices", embedding, 5);
  return rows
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

// ===== 4. 图书馆（campus_library_hours） =====

export async function searchLibraryHours(embedding: number[]): Promise<string> {
  const rows = await callMatchRpc<LibraryHoursRow>("match_library_hours", embedding, 8);
  return rows
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

// ===== 5. 奖学金（campus_scholarships） =====

export async function searchScholarships(embedding: number[]): Promise<string> {
  const rows = await callMatchRpc<ScholarshipRow>("match_scholarships", embedding, 5);
  return rows
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

// ===== 6. 校园地点 POI（campus_pois） =====

export async function searchPois(embedding: number[]): Promise<string> {
  const rows = await callMatchRpc<PoiRow>("match_pois", embedding, 6);
  return rows
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

// ===== 7. 课程信息（campus_courses） =====

/**
 * query 含 5-8 位数字串时优先按课程代码 ilike 反查，
 * 无命中再走 embedding 相似度检索。
 */
export async function searchCourses(embedding: number[], query: string): Promise<string> {
  let rows: CourseRow[] = [];

  const codeMatch = query.match(/\b(\d{5,8})\b/);
  if (codeMatch) {
    const { data, error } = await supabase
      .from("campus_courses")
      .select("cn, en, code, period, credits, role")
      .ilike("code", `%${codeMatch[1]}%`)
      .limit(5);
    if (!error && data && data.length > 0) rows = data as CourseRow[];
  }

  if (rows.length === 0) {
    rows = await callMatchRpc<CourseRow>("match_courses", embedding, 5);
  }

  return rows
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

// ===== 8. 课程替代关系（campus_substitute_pool，文本模糊匹配） =====

interface SubstituteRow {
  query_course_cn: string;
  query_course_code: string | null;
  substitute_cn: string | null;
  substitute_code: string | null;
  original_cn: string | null;
  original_code: string | null;
}

/** 按课程名/代码/英文名做 ilike 模糊匹配，返回替代关系文本 */
export async function searchSubstitutes(courseText: string): Promise<string> {
  if (!courseText) return "";
  const { data, error } = await supabase.rpc("find_substitute_courses", {
    p_course_text: courseText,
  });
  if (error || !data || data.length === 0) return "";

  // 按"被查询的课程"分组，每组列最多 5 条替代关系
  const byQuery = new Map<string, string[]>();
  for (const r of data as SubstituteRow[]) {
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

// ===== 9. 通用校园文档（campus_documents，仅 fallback 类目使用） =====

export async function searchDocuments(embedding: number[]): Promise<string> {
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: embedding,
    match_threshold: 0.5,
    match_count: 5,
  });
  if (error || !data || data.length === 0) return "";
  return (data as DocumentRow[])
    .map((doc) => `【校园资料】${doc.title ?? ""}\n${doc.content}`)
    .join("\n\n---\n\n");
}
