/**
 * RAG 双后端检索质量对比评估
 *
 * 对每个评估 query,用同一份 bge-m3 query embedding 同时调:
 *   - Supabase pgvector(按 classifier 路由只调对应类目 RPC)
 *   - Dify retrieve API(用 docs/dify-retrieval-experiment.md 推荐配置:
 *     semantic_search + bge-reranker-v2-m3 + top_k=5 + 无阈值)
 *
 * 比较两边 top-1 / top-3 是否命中标注关键词,输出命中率 + MRR + 失败案例。
 *
 * 用法:
 *   npx tsx scripts/eval-retrieval.ts
 *   npx tsx scripts/eval-retrieval.ts --only=library,scholarships   # 只跑指定类目
 *   npx tsx scripts/eval-retrieval.ts --verbose                       # 打印每个 hit 的 top-1 内容
 *
 * 输出:
 *   - 控制台:命中表 + MRR 表 + 失败案例
 *   - docs/eval-retrieval-results.md:完整评估报告(由本脚本自动生成)
 */

import * as fs from "fs";
import * as path from "path";

// ===== 加载 .env.local(必须在 require classifier 之前) =====
function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnvFile(path.resolve(process.cwd(), ".env.local"));

// 延迟 require,确保 env 已就绪(tsx 用 CJS 输出,不支持顶层 await)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { embed } = require("ai");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createOpenAI } = require("@ai-sdk/openai");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createClient } = require("@supabase/supabase-js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { classifyWithEmbedding } = require("../app/lib/classifier");

// ===== 类型 =====
type Category =
  | "calendar"
  | "shuttle"
  | "notices"
  | "library"
  | "scholarships"
  | "poi"
  | "courses"
  | "fallback";

interface EvalCase {
  query: string;
  expectedCategory: Category;
  expectedKeywords: string[]; // top-1 / top-3 命中检测:返回的文本里出现任意一个就算命中
  expectedSubsidiary?: Category; // 跨类目 query 的副类目(分类器 secondary 应该是这个)
  note?: string;
}

// ===== 评估集 41 条 =====
const EVAL_CASES: EvalCase[] = [
  // ===== calendar 校历(6 条) =====
  {
    query: "2026 秋季什么时候开学",
    expectedCategory: "calendar",
    expectedKeywords: ["老生开学注册", "新生报到", "开学注册", "开始上课"],
    note: "直接提问(沿用现有探针)",
  },
  {
    query: "新生入学考试安排在几号",
    expectedCategory: "calendar",
    expectedKeywords: ["新生入学考试", "新生报到"],
    note: "直接提问",
  },
  {
    query: "下学期什么时候放寒假",
    expectedCategory: "calendar",
    expectedKeywords: ["学生寒假开始", "寒假"],
    note: "反向/模糊",
  },
  {
    query: "中秋节放几天假",
    expectedCategory: "calendar",
    expectedKeywords: ["中秋节", "中秋"],
    note: "含具体名称",
  },
  {
    query: "校庆那一天放假吗",
    expectedCategory: "calendar",
    expectedKeywords: ["校庆"],
    note: "含具体名称",
  },
  {
    query: "春节是哪天",
    expectedCategory: "calendar",
    expectedKeywords: ["春节", "除夕"],
    note: "含具体名称",
  },

  // ===== shuttle 班车(6 条) =====
  {
    query: "去高新区的班车几点发车",
    expectedCategory: "shuttle",
    expectedKeywords: ["高新", "12:30", "07:30", "18:00"],
    note: "直接提问(沿用现有探针)",
  },
  {
    query: "东区到西区最早几点有班车",
    expectedCategory: "shuttle",
    expectedKeywords: ["东区", "西区", "08:15"],
    note: "直接提问",
  },
  {
    query: "晚上回高新园区还有车吗",
    expectedCategory: "shuttle",
    expectedKeywords: ["高新", "20:00", "21:00", "返程"],
    note: "反向/模糊",
  },
  {
    query: "南区坐车去东区最早一班",
    expectedCategory: "shuttle",
    expectedKeywords: ["南区", "东区", "08:00"],
    note: "含具体名称",
  },
  {
    query: "周末有班车吗",
    expectedCategory: "shuttle",
    expectedKeywords: ["工作日", "每日"],
    note: "模糊",
  },
  {
    query: "校车时刻表",
    expectedCategory: "shuttle",
    expectedKeywords: ["主线", "去程", "返程", "点对点"],
    note: "极简问法",
  },

  // ===== notices 教务通知(6 条) =====
  {
    query: "最近的教务处通知讲什么",
    expectedCategory: "notices",
    expectedKeywords: ["教务处", "通知"],
    note: "直接提问(沿用现有探针)",
  },
  {
    query: "暑期公共教室开放吗",
    expectedCategory: "notices",
    expectedKeywords: ["暑期公共教室", "暑期", "教室"],
    note: "含具体名称",
  },
  {
    query: "本科生选课什么时候开始",
    expectedCategory: "notices",
    expectedKeywords: ["选课", "本科生选课"],
    note: "含具体名称",
  },
  {
    query: "毕业论文选题怎么报",
    expectedCategory: "notices",
    expectedKeywords: ["毕业论文", "选题"],
    note: "含具体名称",
  },
  {
    query: "助教岗位怎么申请",
    expectedCategory: "notices",
    expectedKeywords: ["助教"],
    note: "含具体名称",
  },
  {
    query: "实习管理有什么新规定",
    expectedCategory: "notices",
    expectedKeywords: ["实习管理"],
    note: "含具体名称",
  },

  // ===== library 图书馆(6 条) =====
  {
    query: "东区图书馆周六开门吗,几点关门",
    expectedCategory: "library",
    expectedKeywords: ["东区", "周末", "weekend"],
    note: "直接提问(沿用现有探针)",
  },
  {
    query: "周末想去借书,图书馆开门吗",
    expectedCategory: "library",
    expectedKeywords: ["东区", "西区", "周末", "weekend"],
    note: "反向提问",
  },
  {
    query: "图书馆五楼自习室几点关",
    expectedCategory: "library",
    expectedKeywords: ["5楼", "自习室"],
    note: "含具体名称",
  },
  {
    query: "西区图书馆还书在哪层",
    expectedCategory: "library",
    expectedKeywords: ["西区", "借阅"],
    note: "含具体名称",
  },
  {
    query: "借书最晚到几点",
    expectedCategory: "library",
    expectedKeywords: ["借阅", "8:00-22:00", "22:00"],
    note: "模糊",
  },
  {
    query: "图书馆电话多少",
    expectedCategory: "library",
    expectedKeywords: ["6360", "phone"],
    note: "模糊",
  },

  // ===== scholarships 奖学金(6 条) =====
  {
    query: "雪迪龙奖学金的联系人是谁,邮箱多少",
    expectedCategory: "scholarships",
    expectedKeywords: ["雪迪龙"],
    note: "直接含具体名称(沿用现有探针)",
  },
  {
    query: "最近的奖学金通知",
    expectedCategory: "scholarships",
    expectedKeywords: ["奖学金", "公示"],
    note: "模糊名称",
  },
  {
    query: "善义奖学金怎么申请",
    expectedCategory: "scholarships",
    expectedKeywords: ["善义"],
    note: "含具体名称",
  },
  {
    query: "郭永怀奖学金公示结果",
    expectedCategory: "scholarships",
    expectedKeywords: ["郭永怀"],
    note: "含具体名称",
  },
  {
    query: "中国科学院院长奖学金候选人名单",
    expectedCategory: "scholarships",
    expectedKeywords: ["中国科学院院长"],
    note: "含具体名称",
  },
  {
    query: "勤工助学岗位有哪些",
    expectedCategory: "scholarships",
    expectedKeywords: ["勤工助学"],
    note: "含具体名称",
  },

  // ===== poi 校园地点(6 条) =====
  {
    query: "三食堂在哪个校区,电话多少",
    expectedCategory: "poi",
    expectedKeywords: ["食堂", "校区"],
    note: "直接提问(沿用现有探针,数据里无三食堂,期望落东区学生食堂等)",
  },
  {
    query: "东区学生食堂在哪个校区",
    expectedCategory: "poi",
    expectedKeywords: ["东区学生食堂", "东校区"],
    note: "含具体名称",
  },
  {
    query: "图书馆在东校区吗",
    expectedCategory: "poi",
    expectedKeywords: ["图书馆", "东校区"],
    note: "含具体名称",
  },
  {
    query: "物理楼AED 在哪",
    expectedCategory: "poi",
    expectedKeywords: ["物理楼AED", "物理楼"],
    note: "含具体名称",
  },
  {
    query: "西区附近有餐厅吗",
    expectedCategory: "poi",
    expectedKeywords: ["西校区", "餐厅", "西区"],
    note: "反向/模糊",
  },
  {
    query: "正阳楼餐厅几点开饭",
    expectedCategory: "poi",
    expectedKeywords: ["正阳楼"],
    note: "含具体名称",
  },

  // ===== courses 课程(6 条,含替代池意图) =====
  {
    query: "量子力学这门课的代码和学分",
    expectedCategory: "courses",
    expectedKeywords: ["量子力学", "022090"],
    note: "直接提问(沿用现有探针)",
  },
  {
    query: "量子力学A能代替什么课",
    expectedCategory: "courses",
    expectedKeywords: ["量子力学A", "022148", "量子物理", "量子力学B"],
    expectedSubsidiary: "courses",
    note: "拼写/简称变体 + 替代池",
  },
  {
    query: "量子力学A 等效哪些课程",
    expectedCategory: "courses",
    expectedKeywords: ["量子力学A", "022148", "量子物理"],
    note: "等效课程变体",
  },
  {
    query: "高等量子力学学分多少",
    expectedCategory: "courses",
    expectedKeywords: ["高等量子力学"],
    note: "含具体名称",
  },
  {
    query: "课程代码 022059 是什么课",
    expectedCategory: "courses",
    expectedKeywords: ["022059", "量子力学B"],
    note: "用代码反查",
  },
  {
    query: "量子物理可以替代量子力学吗",
    expectedCategory: "courses",
    expectedKeywords: ["量子物理", "003158", "量子力学"],
    note: "反向替代",
  },

  // ===== fallback 通用(2 条;campus_documents 表为空,只看分类器) =====
  {
    query: "合肥明天天气怎么样",
    expectedCategory: "fallback",
    expectedKeywords: [],
    note: "fallback 探针(沿用现有);documents 表为空,只校验分类器",
  },
  {
    query: "科大旁边有什么好吃的餐厅",
    expectedCategory: "fallback",
    expectedKeywords: [],
    note: "fallback 探针(无关问题,但可能与 poi 干扰)",
  },

  // ===== 跨类目干扰(3 条) =====
  {
    query: "去图书馆坐班车几点",
    expectedCategory: "shuttle",
    expectedSubsidiary: "library",
    expectedKeywords: ["班车", "图书馆", "主线", "东区", "西区"],
    note: "跨类目干扰(shuttle 主 + library 副)",
  },
  {
    query: "开学注册期间图书馆开门吗",
    expectedCategory: "calendar",
    expectedSubsidiary: "library",
    expectedKeywords: ["开学注册", "图书馆", "东区"],
    note: "跨类目干扰(calendar 主 + library 副)",
  },
  {
    query: "选课期间有什么奖学金可以申请",
    expectedCategory: "notices",
    expectedSubsidiary: "scholarships",
    expectedKeywords: ["选课", "奖学金"],
    note: "跨类目干扰(notices 主 + scholarships 副)",
  },
];

// ===== Dify dataset_id 映射(仅 5 个有对应库) =====
const DIFY_DATASETS: Partial<Record<Category, string>> = {
  calendar: "ab7400a3-b5c5-4f80-8d75-84be0cc4bb63",
  shuttle: "781772a0-fee6-4077-ae61-c4eb16448c37",
  notices: "76ca3310-ba82-4cd4-90d8-c3ed6fc1f3a8",
  library: "748dd072-a42c-4cfc-8df4-b0dc9432be50",
  scholarships: "058eb792-77df-4c98-8f40-1feabf5c10dc",
  // poi / courses / fallback 在 Dify 无对应知识库
};

const DIFY_BASE = "http://114.214.241.106";
const DIFY_API_KEY = "dataset-tGSTzWOdMMWOLXnAMyEIT8ff";

// ===== 客户端 =====
const embeddingClient = createOpenAI({
  baseURL: process.env.EMBEDDING_BASE_URL!,
  apiKey: process.env.EMBEDDING_API_KEY!,
});
const EMBEDDING_MODEL = "BAAI/bge-m3";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
);

// ===== Supabase 各类目 RPC(仿 app/api/chat/route.ts,返回拼好的文本数组) =====

interface SupabaseHit {
  text: string;
  similarity: number;
}

async function searchCalendar(embedding: number[]): Promise<SupabaseHit[]> {
  const { data, error } = await supabase.rpc("match_calendar", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 8,
  });
  if (error || !data) return [];
  return (data as Array<{
    academic_year: string | null;
    semester: string | null;
    start_date: string | null;
    end_date: string | null;
    event_title: string;
    source_url: string | null;
    similarity: number;
  }>).map((e) => ({
    text: [
      e.event_title,
      e.academic_year,
      e.semester ? `${e.semester}学期` : "",
      e.start_date
        ? `${e.start_date}${e.end_date && e.end_date !== e.start_date ? `~${e.end_date}` : ""}`
        : "",
    ].filter(Boolean).join(" "),
    similarity: e.similarity,
  }));
}

async function searchShuttle(embedding: number[]): Promise<SupabaseHit[]> {
  const { data, error } = await supabase.rpc("match_shuttle", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 10,
  });
  if (error || !data) return [];
  return (data as Array<{
    route_name: string;
    direction: string | null;
    departure: string | null;
    arrival: string | null;
    depart_time: string | null;
    arrive_time: string | null;
    weekday_only: string | null;
    note: string | null;
    similarity: number;
  }>).map((s) => ({
    text: [
      s.route_name,
      s.direction,
      s.departure && s.arrival ? `${s.departure}→${s.arrival}` : "",
      s.depart_time
        ? `${s.depart_time}发车${s.arrive_time ? ` ${s.arrive_time}到` : ""}`
        : "",
      s.weekday_only ? (s.weekday_only === "true" ? "工作日" : "每日") : "",
      s.note ?? "",
    ].filter(Boolean).join(" "),
    similarity: s.similarity,
  }));
}

async function searchNotices(embedding: number[]): Promise<SupabaseHit[]> {
  const { data, error } = await supabase.rpc("match_notices", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 5,
  });
  if (error || !data) return [];
  return (data as Array<{
    title: string;
    publish_date: string | null;
    author: string | null;
    category: string | null;
    body_preview: string | null;
    similarity: number;
  }>).map((n) => ({
    text: [n.title, n.publish_date, n.author, n.category, n.body_preview]
      .filter(Boolean)
      .join(" "),
    similarity: n.similarity,
  }));
}

async function searchLibraryHours(embedding: number[]): Promise<SupabaseHit[]> {
  const { data, error } = await supabase.rpc("match_library_hours", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 8,
  });
  if (error || !data) return [];
  return (data as Array<{
    branch: string;
    floor: string | null;
    service: string | null;
    weekday_hours: string | null;
    weekend_hours: string | null;
    phone: string | null;
    similarity: number;
  }>).map((l) => ({
    text: [
      l.branch,
      l.floor ? `楼层:${l.floor}` : "",
      l.service ?? "",
      l.weekday_hours ? `工作日:${l.weekday_hours}` : "",
      l.weekend_hours ? `周末:${l.weekend_hours}` : "",
      l.phone ? `电话:${l.phone}` : "",
    ].filter(Boolean).join(" "),
    similarity: l.similarity,
  }));
}

async function searchScholarships(embedding: number[]): Promise<SupabaseHit[]> {
  const { data, error } = await supabase.rpc("match_scholarships", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 5,
  });
  if (error || !data) return [];
  return (data as Array<{
    title: string;
    publish_date: string | null;
    publisher: string | null;
    category: string | null;
    body_preview: string | null;
    similarity: number;
  }>).map((s) => ({
    text: [s.title, s.publish_date, s.publisher, s.category, s.body_preview]
      .filter(Boolean)
      .join(" "),
    similarity: s.similarity,
  }));
}

async function searchPois(embedding: number[]): Promise<SupabaseHit[]> {
  const { data, error } = await supabase.rpc("match_pois", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 6,
  });
  if (error || !data) return [];
  return (data as Array<{
    title: string;
    address: string | null;
    category: string | null;
    xiaoqu: string | null;
    description: string | null;
    telephone: string | null;
    similarity: number;
  }>).map((p) => ({
    text: [
      p.title,
      p.category ? `分类:${p.category}` : "",
      p.xiaoqu ? `校区:${p.xiaoqu}` : "",
      p.address ? `地址:${p.address}` : "",
      p.telephone ? `电话:${p.telephone}` : "",
      p.description && p.description !== "暂无介绍！" ? p.description : "",
    ].filter(Boolean).join(" "),
    similarity: p.similarity,
  }));
}

async function searchCourses(embedding: number[], query: string): Promise<SupabaseHit[]> {
  // query 中抠出可能的课程代码(6 位以上数字串),走文本 ilike 反查
  const codeMatch = query.match(/\b(\d{5,8})\b/);
  if (codeMatch) {
    const code = codeMatch[1];
    const { data: codeData, error: codeErr } = await supabase
      .from("campus_courses")
      .select("cn, en, code, period, credits, role")
      .ilike("code", `%${code}%`)
      .limit(5);
    if (!codeErr && codeData && codeData.length > 0) {
      return (codeData as Array<{
        cn: string;
        en: string | null;
        code: string | null;
        period: number | null;
        credits: number | null;
        role: string | null;
      }>).map((c) => ({
        text: [
          c.cn,
          c.en,
          c.code ? `代码:${c.code}` : "",
          c.period ? `学时:${c.period}` : "",
          c.credits != null ? `学分:${c.credits}` : "",
          c.role ? `角色:${c.role}` : "",
        ].filter(Boolean).join(" "),
        similarity: 1.0,
      }));
    }
  }
  const { data, error } = await supabase.rpc("match_courses", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 5,
  });
  if (error || !data) return [];
  return (data as Array<{
    cn: string;
    en: string | null;
    code: string | null;
    period: number | null;
    credits: number | null;
    role: string | null;
    similarity: number;
  }>).map((c) => ({
    text: [
      c.cn,
      c.en,
      c.code ? `代码:${c.code}` : "",
      c.period ? `学时:${c.period}` : "",
      c.credits != null ? `学分:${c.credits}` : "",
      c.role ? `角色:${c.role}` : "",
    ].filter(Boolean).join(" "),
    similarity: c.similarity,
  }));
}

async function searchSubstitutes(courseText: string): Promise<SupabaseHit[]> {
  if (!courseText) return [];
  const { data, error } = await supabase.rpc("find_substitute_courses", {
    p_course_text: courseText,
  });
  if (error || !data) return [];
  return (data as Array<{
    query_course_cn: string;
    query_course_code: string | null;
    substitute_cn: string | null;
    substitute_code: string | null;
    original_cn: string | null;
    original_code: string | null;
  }>).map((r) => ({
    text: [
      `查询课程:${r.query_course_cn}${r.query_course_code ? `(${r.query_course_code})` : ""}`,
      r.substitute_cn
        ? `替代课:${r.substitute_cn}${r.substitute_code ? `(${r.substitute_code})` : ""}`
        : "",
      r.original_cn
        ? `原课:${r.original_cn}${r.original_code ? `(${r.original_code})` : ""}`
        : "",
    ].filter(Boolean).join(" "),
    similarity: 1.0, // 文本检索无向量分数,置 1 表示"命中"
  }));
}

async function searchDocuments(embedding: number[]): Promise<SupabaseHit[]> {
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: embedding,
    match_threshold: 0.5,
    match_count: 5,
  });
  if (error || !data) return [];
  return (data as Array<{ title: string; content: string; similarity: number }>).map(
    (d) => ({
      text: `${d.title ?? ""} ${d.content ?? ""}`,
      similarity: d.similarity,
    }),
  );
}

// 复刻 classifier.ts 的 isCourseSubstituteQuery / extractCourseName
function isCourseSubstituteQuery(q: string): boolean {
  return /替代|代替|替换|换课|等效课程|学分互认|能不能代替|可以替代|能替代|可替代|等效/.test(
    q,
  );
}
function extractCourseName(query: string): string {
  const cleaned = query
    .replace(/[？?！!。.,，、]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const beforeMatch = cleaned.match(
    /^(.+?)\s*(?:能|可以|可)?(?:替代|代替|替换|换课|等效)/,
  );
  const afterMatch = cleaned.match(
    /(?:替代|代替|替换|换课|等效)(?:什么|哪些|啥|成|为|做)?\s*(.+)$/,
  );
  return (
    (beforeMatch?.[1] && beforeMatch[1].length >= 2 ? beforeMatch[1] : "") ||
    (afterMatch?.[1] && afterMatch[1].length >= 2 ? afterMatch[1] : "") ||
    cleaned
  );
}

// 路由后的检索:按类目调对应 RPC,courses 类目且含替代关键词时附加 find_substitute_courses
async function supabaseSearch(
  category: Category,
  embedding: number[],
  query: string,
): Promise<SupabaseHit[]> {
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
      const courseHits = await searchCourses(embedding, query);
      if (isCourseSubstituteQuery(query)) {
        const subHits = await searchSubstitutes(extractCourseName(query));
        return [...subHits, ...courseHits];
      }
      return courseHits;
    }
    case "fallback":
      return searchDocuments(embedding);
  }
}

// ===== Dify retrieve 调用(Node fetch,UTF-8 安全) =====
interface DifyHit {
  text: string;
  score: number;
}

async function difyRetrieve(
  datasetId: string,
  query: string,
): Promise<DifyHit[]> {
  const url = `${DIFY_BASE}/v1/datasets/${datasetId}/retrieve`;
  const payload = {
    query,
    retrieval_model: {
      search_method: "semantic_search",
      reranking_enable: true,
      reranking_mode: "reranking_model",
      reranking_model: {
        reranking_provider_name: "langgenius/siliconflow/siliconflow",
        reranking_model_name: "BAAI/bge-reranker-v2-m3",
      },
      top_k: 5,
      score_threshold_enabled: false,
    },
  };
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DIFY_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      return [];
    }
    const json = (await resp.json()) as {
      records?: Array<{
        segment?: { content?: string };
        score?: number;
      }>;
    };
    if (!json.records) return [];
    return json.records.map((r) => ({
      text: r.segment?.content ?? "",
      score: r.score ?? 0,
    }));
  } catch {
    return [];
  }
}

// ===== 命中检测 =====
function hitAtK(
  hits: { text: string }[],
  keywords: string[],
  k: number,
): boolean {
  if (keywords.length === 0) return false;
  const top = hits.slice(0, k);
  return top.some((h) => keywords.some((kw) => h.text.includes(kw)));
}

function firstHitRank(hits: { text: string }[], keywords: string[]): number {
  if (keywords.length === 0) return 0;
  for (let i = 0; i < hits.length; i++) {
    if (keywords.some((kw) => hits[i].text.includes(kw))) {
      return i + 1;
    }
  }
  return 0;
}

// ===== 主流程 =====
interface CaseResult {
  query: string;
  expectedCategory: Category;
  expectedSubsidiary?: Category;
  classifierPrimary: Category;
  classifierSecondary: Category | null;
  supabaseHits: SupabaseHit[];
  difyHits: DifyHit[];
  supabaseHit1: boolean;
  supabaseHit3: boolean;
  difyHit1: boolean;
  difyHit3: boolean;
  supabaseMrr: number;
  difyMrr: number;
  expectedKeywords: string[];
  note?: string;
  difySkipped: boolean;
}

function countByCategory(cases: EvalCase[]): Array<[Category, number]> {
  const map = new Map<Category, number>();
  for (const c of cases) {
    map.set(c.expectedCategory, (map.get(c.expectedCategory) ?? 0) + 1);
  }
  return Array.from(map.entries());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const onlyArg = args.find((a) => a.startsWith("--only="));
  const onlySet = onlyArg
    ? new Set(onlyArg.slice(7).split(",").map((s) => s.trim()).filter(Boolean))
    : null;

  const cases: EvalCase[] = onlySet
    ? EVAL_CASES.filter((c) => onlySet.has(c.expectedCategory))
    : EVAL_CASES;

  console.log("====================================================");
  console.log("RAG 检索双后端对比评估");
  console.log("====================================================");
  console.log(`评估集大小: ${cases.length} 条`);
  console.log(
    `类目分布: ${countByCategory(cases).map(([c, n]) => `${c}=${n}`).join(", ")}`,
  );
  console.log("");

  const results: CaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    process.stdout.write(`[${i + 1}/${cases.length}] ${c.query}  `);

    // 1. embed
    const { embedding } = await embed({
      model: embeddingClient.embedding(EMBEDDING_MODEL),
      value: c.query,
    });

    // 2. 分类器路由
    const { primary, secondary } = await classifyWithEmbedding(embedding, c.query);

    // 3. Supabase:贴近生产 searchRouted —— 路由后的 primary + secondary 都查,
    //    fallback 时走 match_documents(文档表为空,如实记录)
    //    分类错误会直接落空,如实记录
    const supabaseCats: Category[] = [primary, secondary].filter(
      (c2): c2 is Category => c2 !== null && c2 !== "fallback",
    );
    if (supabaseCats.length === 0) supabaseCats.push("fallback");
    const perCatHits = await Promise.all(
      supabaseCats.map((c2) => supabaseSearch(c2, embedding, c.query)),
    );
    // 拼接:secondary 的结果接在 primary 后(与 route.ts 的 parts.join 顺序一致)
    const supabaseHits: SupabaseHit[] = perCatHits.flat();

    // 4. Dify:用 expectedCategory 路由到对应 dataset_id
    //    (本评估想看"理想路由下"Dify vs Supabase 的检索质量差异,
    //     隔离"分类器误差"与"检索质量"两件事,所以 Dify 端用期望类目)
    //    若 Dify 无对应 dataset,跳过
    const difyDatasetId = DIFY_DATASETS[c.expectedCategory];
    let difyHits: DifyHit[] = [];
    let difySkipped = false;
    if (difyDatasetId) {
      difyHits = await difyRetrieve(difyDatasetId, c.query);
    } else {
      difySkipped = true;
    }

    // 5. 命中检测(若 expectedKeywords 为空 → fallback 类目不校验)
    const supabaseHit1 = hitAtK(supabaseHits, c.expectedKeywords, 1);
    const supabaseHit3 = hitAtK(supabaseHits, c.expectedKeywords, 3);
    const difyHit1 = difySkipped ? false : hitAtK(difyHits, c.expectedKeywords, 1);
    const difyHit3 = difySkipped ? false : hitAtK(difyHits, c.expectedKeywords, 3);

    const sRank = firstHitRank(supabaseHits, c.expectedKeywords);
    const dRank = difySkipped ? 0 : firstHitRank(difyHits, c.expectedKeywords);
    const supabaseMrr = c.expectedKeywords.length === 0 || sRank === 0 ? 0 : 1 / sRank;
    const difyMrr =
      c.expectedKeywords.length === 0 || difySkipped || dRank === 0 ? 0 : 1 / dRank;

    results.push({
      query: c.query,
      expectedCategory: c.expectedCategory,
      expectedSubsidiary: c.expectedSubsidiary,
      classifierPrimary: primary,
      classifierSecondary: secondary,
      supabaseHits,
      difyHits,
      supabaseHit1,
      supabaseHit3,
      difyHit1,
      difyHit3,
      supabaseMrr,
      difyMrr,
      expectedKeywords: c.expectedKeywords,
      note: c.note,
      difySkipped,
    });

    const sMark =
      c.expectedKeywords.length === 0
        ? "(fallback 无关键词)"
        : `s@1=${supabaseHit1 ? "Y" : "N"} s@3=${supabaseHit3 ? "Y" : "N"}`;
    const dMark = difySkipped
      ? "dify=N/A"
      : `d@1=${difyHit1 ? "Y" : "N"} d@3=${difyHit3 ? "Y" : "N"}`;
    const cls = `cls=${primary}${secondary ? `+${secondary}` : ""}`;
    console.log(`→ ${cls} | ${sMark} | ${dMark}`);
    if (verbose) {
      if (supabaseHits[0])
        console.log(`    supabase top1: ${supabaseHits[0].text.slice(0, 140)}`);
      if (difyHits[0])
        console.log(`    dify     top1: ${difyHits[0].text.slice(0, 140)}`);
    }
  }

  printSummary(results);
  writeReport(results);
}

function printSummary(results: CaseResult[]): void {
  console.log("\n====================================================");
  console.log("命中率汇总");
  console.log("====================================================");

  const withKw = results.filter((r) => r.expectedKeywords.length > 0);
  const difyEligible = withKw.filter((r) => !r.difySkipped);

  const s1 = withKw.filter((r) => r.supabaseHit1).length;
  const s3 = withKw.filter((r) => r.supabaseHit3).length;
  const d1 = difyEligible.filter((r) => r.difyHit1).length;
  const d3 = difyEligible.filter((r) => r.difyHit3).length;
  const sMrr = withKw.reduce((a, r) => a + r.supabaseMrr, 0) / withKw.length;
  const dMrr = difyEligible.reduce((a, r) => a + r.difyMrr, 0) / difyEligible.length;

  console.log(
    `Supabase  top-1: ${s1}/${withKw.length} = ${((s1 / withKw.length) * 100).toFixed(1)}%`,
  );
  console.log(
    `Supabase  top-3: ${s3}/${withKw.length} = ${((s3 / withKw.length) * 100).toFixed(1)}%`,
  );
  console.log(`Supabase  MRR  : ${sMrr.toFixed(3)}`);
  console.log(
    `Dify      top-1: ${d1}/${difyEligible.length} = ${((d1 / difyEligible.length) * 100).toFixed(1)}% (跳过 ${withKw.length - difyEligible.length} 条无对应库)`,
  );
  console.log(
    `Dify      top-3: ${d3}/${difyEligible.length} = ${((d3 / difyEligible.length) * 100).toFixed(1)}%`,
  );
  console.log(`Dify      MRR  : ${dMrr.toFixed(3)}`);

  const clsCorrect = results.filter(
    (r) => r.classifierPrimary === r.expectedCategory,
  ).length;
  console.log(
    `\n分类器 primary 路由准确: ${clsCorrect}/${results.length} = ${((clsCorrect / results.length) * 100).toFixed(1)}%`,
  );

  console.log("\n====================================================");
  console.log("失败案例(top-3 都没命中)");
  console.log("====================================================");
  const supabaseFails = withKw.filter((r) => !r.supabaseHit3);
  const difyFails = difyEligible.filter((r) => !r.difyHit3);
  console.log(`\nSupabase 失败 ${supabaseFails.length} 条:`);
  for (const r of supabaseFails) {
    console.log(
      `  - "${r.query}" (期望 ${r.expectedCategory},分类 ${r.classifierPrimary})` +
        (r.classifierPrimary !== r.expectedCategory ? " [分类错误]" : "") +
        `\n    top1: ${(r.supabaseHits[0]?.text ?? "(无结果)").slice(0, 160)}`,
    );
  }
  console.log(`\nDify 失败 ${difyFails.length} 条:`);
  for (const r of difyFails) {
    console.log(
      `  - "${r.query}" (期望 ${r.expectedCategory})` +
        `\n    top1: ${(r.difyHits[0]?.text ?? "(无结果)").slice(0, 160)}`,
    );
  }

  console.log("\n====================================================");
  console.log("跨类目干扰:classifier secondary 是否符合期望");
  console.log("====================================================");
  const cross = results.filter((r) => r.expectedSubsidiary);
  for (const r of cross) {
    const ok = r.classifierSecondary === r.expectedSubsidiary;
    console.log(
      `  [${ok ? "✓" : "✗"}] "${r.query}"` +
        ` → 期望 secondary=${r.expectedSubsidiary},实际 ${r.classifierSecondary ?? "(无)"}`,
    );
  }
}

function writeReport(results: CaseResult[]): void {
  const withKw = results.filter((r) => r.expectedKeywords.length > 0);
  const difyEligible = withKw.filter((r) => !r.difySkipped);

  const s1 = withKw.filter((r) => r.supabaseHit1).length;
  const s3 = withKw.filter((r) => r.supabaseHit3).length;
  const d1 = difyEligible.filter((r) => r.difyHit1).length;
  const d3 = difyEligible.filter((r) => r.difyHit3).length;
  const sMrr = withKw.reduce((a, r) => a + r.supabaseMrr, 0) / withKw.length;
  const dMrr = difyEligible.reduce((a, r) => a + r.difyMrr, 0) / difyEligible.length;
  const clsCorrect = results.filter(
    (r) => r.classifierPrimary === r.expectedCategory,
  ).length;

  const supabaseFails = withKw.filter((r) => !r.supabaseHit3);
  const difyFails = difyEligible.filter((r) => !r.difyHit3);
  const cross = results.filter((r) => r.expectedSubsidiary);

  const lines: string[] = [];
  lines.push("# RAG 双后端检索质量对比评估报告");
  lines.push("");
  lines.push(`**生成时间**:${new Date().toISOString()}`);
  lines.push(`**评估集大小**:${EVAL_CASES.length} 条 query`);
  lines.push(
    `**类目分布**:${countByCategory(EVAL_CASES).map(([c, n]) => `\`${c}\`=${n}`).join(", ")}`,
  );
  lines.push("");
  lines.push("## 1. 评估配置");
  lines.push("");
  lines.push("- **Embedding 模型**:BAAI/bge-m3(SiliconFlow)");
  lines.push(
    "- **Supabase**:`classifyWithEmbedding` 路由后的 primary 类目 → 对应 `match_*` RPC(match_threshold=0.4)",
  );
  lines.push(
    "- **Dify**:`semantic_search` + `reranking_model=BAAI/bge-reranker-v2-m3` + top_k=5 + 无阈值(docs/dify-retrieval-experiment.md 推荐配置)",
  );
  lines.push(
    "- **路由策略**:Dify 端用 `expectedCategory` 路由(理想路由),隔离分类器误差与检索质量两件事;Supabase 端用 classifier 的 primary(贴近生产)",
  );
  lines.push(
    "- **命中判定**:top-1 / top-3 内出现标注 `expectedKeywords` 任意一个即视为命中",
  );
  lines.push("- **MRR**:首个命中位置的倒数,无命中=0");
  lines.push("");
  lines.push("## 2. 总体命中率");
  lines.push("");
  lines.push("| 指标 | Supabase pgvector | Dify semantic+rerank |");
  lines.push("|---|---|---|");
  lines.push(
    `| top-1 命中 | ${s1}/${withKw.length} (${((s1 / withKw.length) * 100).toFixed(1)}%) | ${d1}/${difyEligible.length} (${((d1 / difyEligible.length) * 100).toFixed(1)}%) |`,
  );
  lines.push(
    `| top-3 命中 | ${s3}/${withKw.length} (${((s3 / withKw.length) * 100).toFixed(1)}%) | ${d3}/${difyEligible.length} (${((d3 / difyEligible.length) * 100).toFixed(1)}%) |`,
  );
  lines.push(`| MRR | ${sMrr.toFixed(3)} | ${dMrr.toFixed(3)} |`);
  lines.push("");
  lines.push(
    `> Dify 跳过 ${withKw.length - difyEligible.length} 条 query(poi / courses / fallback 在 Dify 无对应知识库)。`,
  );
  lines.push("");
  lines.push("## 3. 分类器路由准确率");
  lines.push("");
  lines.push(
    `- classifier \`primary\` 准确率:${clsCorrect}/${results.length} (${((clsCorrect / results.length) * 100).toFixed(1)}%)`,
  );
  lines.push("");
  lines.push("## 4. 各类目命中率");
  lines.push("");
  lines.push("| 类目 | n | Supabase @1 | Supabase @3 | Dify @1 | Dify @3 |");
  lines.push("|---|---|---|---|---|---|");
  const cats = Array.from(new Set(withKw.map((r) => r.expectedCategory)));
  for (const cat of cats) {
    const catResults = withKw.filter((r) => r.expectedCategory === cat);
    const catDify = catResults.filter((r) => !r.difySkipped);
    const s1c = catResults.filter((r) => r.supabaseHit1).length;
    const s3c = catResults.filter((r) => r.supabaseHit3).length;
    const d1c = catDify.filter((r) => r.difyHit1).length;
    const d3c = catDify.filter((r) => r.difyHit3).length;
    lines.push(
      `| ${cat} | ${catResults.length} | ${s1c}/${catResults.length} | ${s3c}/${catResults.length} | ${catDify.length === 0 ? "N/A" : `${d1c}/${catDify.length}`} | ${catDify.length === 0 ? "N/A" : `${d3c}/${catDify.length}`} |`,
    );
  }
  lines.push("");
  lines.push("## 5. 失败案例");
  lines.push("");
  lines.push(`### 5.1 Supabase 失败(${supabaseFails.length} 条,top-3 未命中)`);
  lines.push("");
  if (supabaseFails.length === 0) {
    lines.push("(无)");
  } else {
    for (const r of supabaseFails) {
      lines.push(
        `- **"${r.query}"** 期望 \`${r.expectedCategory}\`,分类 \`${r.classifierPrimary}\`${
          r.classifierPrimary !== r.expectedCategory ? " **[分类错误]**" : ""
        }`,
      );
      lines.push(
        `  - top1: \`${(r.supabaseHits[0]?.text ?? "(无结果)").slice(0, 240).replace(/\n/g, " ")}\``,
      );
    }
  }
  lines.push("");
  lines.push(`### 5.2 Dify 失败(${difyFails.length} 条,top-3 未命中)`);
  lines.push("");
  if (difyFails.length === 0) {
    lines.push("(无)");
  } else {
    for (const r of difyFails) {
      lines.push(`- **"${r.query}"** 期望 \`${r.expectedCategory}\``);
      lines.push(
        `  - top1: \`${(r.difyHits[0]?.text ?? "(无结果)").slice(0, 240).replace(/\n/g, " ")}\``,
      );
    }
  }
  lines.push("");
  lines.push("## 6. 跨类目干扰");
  lines.push("");
  lines.push("| query | 期望 secondary | classifier secondary | 命中? |");
  lines.push("|---|---|---|---|");
  for (const r of cross) {
    const ok = r.classifierSecondary === r.expectedSubsidiary;
    lines.push(
      `| ${r.query} | \`${r.expectedSubsidiary}\` | \`${r.classifierSecondary ?? "(无)"}\` | ${ok ? "✓" : "✗"} |`,
    );
  }
  lines.push("");
  lines.push("## 7. 后续改进建议");
  lines.push("");
  lines.push("(根据本次结果由人工补充)");
  lines.push("");

  const outPath = path.resolve(process.cwd(), "docs/eval-retrieval-results.md");
  fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
  console.log(`\n报告已写入: ${outPath}`);
}

main().catch((e) => {
  console.error("出错:", e);
  process.exit(1);
});
