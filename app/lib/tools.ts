/**
 * AI SDK v7 tool 定义 —— LLM 自主决定调哪个/哪几个检索工具
 *
 * 9 个工具对应原 route.ts 的 searchX 函数:
 *   search_calendar       → match_calendar RPC
 *   search_shuttle        → match_shuttle RPC
 *   search_notices        → match_notices RPC
 *   search_library_hours  → match_library_hours RPC
 *   search_scholarships   → match_scholarships RPC
 *   search_pois           → match_pois RPC
 *   search_courses        → match_courses RPC + ilike 反查(课程代码)
 *   find_substitute_courses → find_substitute_courses RPC(文本模糊匹配)
 *   search_dify_fallback  → Dify 跨 5 库兜底(classifier 没路由到具体类目时用)
 *
 * 设计:
 *   - 工具返回**结构化 JSON**(不是字符串),让 LLM 看清字段名,自由组织回答格式
 *   - 工具内部自己 embed(query),不再依赖外层共享向量(因为 LLM 会用自然语言调工具,
 *     query 可能与原始用户问句不同)
 *   - 工具 description 写清楚"什么时候应该调我",覆盖原 prompts.ts 的类目路由意图
 *   - 空结果返回 { results: [], note: "..." } 而不是抛错,让 LLM 自己决定要不要再调别的工具
 */

import { createClient } from "@supabase/supabase-js";
import { embed, jsonSchema, tool } from "ai";
import { embeddingClient, EMBEDDING_MODEL } from "./ai-clients";
import { searchDifyAll } from "./dify";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
);

async function embedQuery(query: string): Promise<number[]> {
  const { embedding } = await embed({
    model: embeddingClient.embedding(EMBEDDING_MODEL),
    value: query,
  });
  return embedding;
}

// ===== 1. 校历 =====

export const searchCalendarTool = tool({
  description:
    "查询中国科学技术大学校历、学期安排、开学放假时间、考试周、注册报到日程、节假日。当用户问'什么时候开学''放假时间''考试周''学期安排'等校历问题时调用。",
  inputSchema: jsonSchema<{ query: string }>({
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "关于校历的具体问题,如 '2026 秋季什么时候开学'",
      },
    },
    required: ["query"],
  }),
  execute: async ({ query }) => {
    const embedding = await embedQuery(query);
    const { data, error } = await supabase.rpc("match_calendar", {
      query_embedding: embedding,
      match_threshold: 0.4,
      match_count: 8,
    });
    if (error) return { error: error.message, results: [] };
    return {
      count: data?.length ?? 0,
      results: (data ?? []).map((e: Record<string, unknown>) => ({
        event_title: e.event_title,
        academic_year: e.academic_year,
        semester: e.semester,
        start_date: e.start_date,
        end_date: e.end_date,
        source_url: e.source_url,
      })),
    };
  },
});

// ===== 2. 班车 =====

export const searchShuttleTool = tool({
  description:
    "查询中科大校区之间通勤班车时刻表、发车时间、发车点、工作日班次、高新/先研院专线。当用户问'班车''校车''去高新怎么坐车''几点发车'等问题时调用。",
  inputSchema: jsonSchema<{ query: string }>({
    type: "object",
    properties: {
      query: { type: "string", description: "关于班车时刻的具体问题" },
    },
    required: ["query"],
  }),
  execute: async ({ query }) => {
    const embedding = await embedQuery(query);
    const { data, error } = await supabase.rpc("match_shuttle", {
      query_embedding: embedding,
      match_threshold: 0.4,
      match_count: 10,
    });
    if (error) return { error: error.message, results: [] };
    return {
      count: data?.length ?? 0,
      results: (data ?? []).map((s: Record<string, unknown>) => ({
        route_name: s.route_name,
        direction: s.direction,
        departure: s.departure,
        arrival: s.arrival,
        depart_time: s.depart_time,
        arrive_time: s.arrive_time,
        weekday_only: s.weekday_only,
        period: s.period,
        note: s.note,
      })),
    };
  },
});

// ===== 3. 教务通知 =====

export const searchNoticesTool = tool({
  description:
    "查询中国科学技术大学教务处通知、教学事务公告、选课通知、考试通知、毕业论文选题、学籍管理、本科生实习管理、助教岗位申请、教室开放通知。当用户问'教务处''通知''选课''考试安排''毕业论文''助教岗位''教室开放'等通知类问题时调用。",
  inputSchema: jsonSchema<{ query: string }>({
    type: "object",
    properties: {
      query: { type: "string", description: "关于教务通知的具体问题" },
    },
    required: ["query"],
  }),
  execute: async ({ query }) => {
    const embedding = await embedQuery(query);
    const { data, error } = await supabase.rpc("match_notices", {
      query_embedding: embedding,
      match_threshold: 0.4,
      match_count: 5,
    });
    if (error) return { error: error.message, results: [] };
    return {
      count: data?.length ?? 0,
      results: (data ?? []).map((n: Record<string, unknown>) => ({
        title: n.title,
        publish_date: n.publish_date,
        author: n.author,
        category: n.category,
        body_preview: n.body_preview,
        url: n.url,
      })),
    };
  },
});

// ===== 4. 图书馆 =====

export const searchLibraryHoursTool = tool({
  description:
    "查询中科大图书馆开放时间、各分馆各楼层服务窗口、阅览室、借还书服务、咨询电话、校区分馆。当用户问'图书馆几点开门''图书馆开放时间''某分馆某楼层服务'等问题时调用。",
  inputSchema: jsonSchema<{ query: string }>({
    type: "object",
    properties: {
      query: { type: "string", description: "关于图书馆开放时间的具体问题" },
    },
    required: ["query"],
  }),
  execute: async ({ query }) => {
    const embedding = await embedQuery(query);
    const { data, error } = await supabase.rpc("match_library_hours", {
      query_embedding: embedding,
      match_threshold: 0.4,
      match_count: 8,
    });
    if (error) return { error: error.message, results: [] };
    return {
      count: data?.length ?? 0,
      results: (data ?? []).map((l: Record<string, unknown>) => ({
        branch: l.branch,
        floor: l.floor,
        service: l.service,
        weekday_hours: l.weekday_hours,
        weekend_hours: l.weekend_hours,
        phone: l.phone,
        source_url: l.source_url,
      })),
    };
  },
});

// ===== 5. 奖学金 =====

export const searchScholarshipsTool = tool({
  description:
    "查询中国科学技术大学奖学金、助学金、奖项评选公示、申请截止日期、联系人邮箱、助学贷款、勤工助学岗位、资助育人、绿色通道。当用户问'奖学金''助学金''助学贷款''勤工助学''公示'等问题时调用。",
  inputSchema: jsonSchema<{ query: string }>({
    type: "object",
    properties: {
      query: { type: "string", description: "关于奖助学金的具体问题" },
    },
    required: ["query"],
  }),
  execute: async ({ query }) => {
    const embedding = await embedQuery(query);
    const { data, error } = await supabase.rpc("match_scholarships", {
      query_embedding: embedding,
      match_threshold: 0.4,
      match_count: 5,
    });
    if (error) return { error: error.message, results: [] };
    return {
      count: data?.length ?? 0,
      results: (data ?? []).map((s: Record<string, unknown>) => ({
        title: s.title,
        publish_date: s.publish_date,
        publisher: s.publisher,
        category: s.category,
        body_preview: s.body_preview,
        url: s.url,
      })),
    };
  },
});

// ===== 6. POI 校园地点 =====

export const searchPoisTool = tool({
  description:
    "查询中科大校园地点、教学楼、食堂、餐厅、宿舍、办公地点、AED、出入口、报警点、校车点、楼层位置、在哪个校区、怎么走、地址电话。当用户问'某地点在哪''某食堂怎么走''某楼在哪个校区''某地点电话'等空间/地点类问题时调用。",
  inputSchema: jsonSchema<{ query: string }>({
    type: "object",
    properties: {
      query: { type: "string", description: "关于校园地点的具体问题" },
    },
    required: ["query"],
  }),
  execute: async ({ query }) => {
    const embedding = await embedQuery(query);
    const { data, error } = await supabase.rpc("match_pois", {
      query_embedding: embedding,
      match_threshold: 0.4,
      match_count: 6,
    });
    if (error) return { error: error.message, results: [] };
    return {
      count: data?.length ?? 0,
      results: (data ?? []).map((p: Record<string, unknown>) => ({
        title: p.title,
        category: p.category,
        xiaoqu: p.xiaoqu,
        address: p.address,
        telephone: p.telephone,
        description: p.description,
        url: p.url,
      })),
    };
  },
});

// ===== 7. 课程信息 =====

export const searchCoursesTool = tool({
  description:
    "查询中国科学技术大学课程信息、课程名、课程代码、学时学分、课程角色。当用户问'某课程代码是什么课''某课程的学分学时''某门课的信息'等问题时调用。若用户问'X 能替代什么课''能代替 X 吗'等课程替代问题,改用 find_substitute_courses 工具。",
  inputSchema: jsonSchema<{ query: string }>({
    type: "object",
    properties: {
      query: { type: "string", description: "关于课程的具体问题,可含课程代码(5-8 位数字)" },
    },
    required: ["query"],
  }),
  execute: async ({ query }) => {
    // 课程代码(5-8 位数字串)优先 ilike 反查
    const codeMatch = query.match(/\b(\d{5,8})\b/);
    let rows: Array<Record<string, unknown>> = [];
    if (codeMatch) {
      const code = codeMatch[1];
      const { data, error } = await supabase
        .from("campus_courses")
        .select("cn, en, code, period, credits, role")
        .ilike("code", `%${code}%`)
        .limit(5);
      if (!error && data) rows = data as Array<Record<string, unknown>>;
    }
    // ilike 无命中或没抠到代码 → 走 embedding 相似
    if (rows.length === 0) {
      const embedding = await embedQuery(query);
      const { data, error } = await supabase.rpc("match_courses", {
        query_embedding: embedding,
        match_threshold: 0.4,
        match_count: 5,
      });
      if (error) return { error: error.message, results: [] };
      rows = (data ?? []) as Array<Record<string, unknown>>;
    }
    return {
      count: rows.length,
      results: rows.map((c) => ({
        cn: c.cn,
        en: c.en,
        code: c.code,
        period: c.period,
        credits: c.credits,
        role: c.role,
      })),
    };
  },
});

// ===== 8. 课程替代关系 =====

export const findSubstituteCoursesTool = tool({
  description:
    "查询中科大课程替代关系:某课程能被哪些课替代、能否代替某门课、等效课程、学分互认。当用户问'X 能替代什么课''X 能代替 Y 吗''X 的等效课程''X 替换课'等课程替代问题时调用。input 的 course_text 必须是**被查询的课程名**(不含'替代/代替'等动词)。",
  inputSchema: jsonSchema<{ course_text: string }>({
    type: "object",
    properties: {
      course_text: {
        type: "string",
        description:
          "被查询的课程名,如 '量子力学A' 或 '数学分析B'。只传课程名,不要带'能替代什么课'等修饰词。",
      },
    },
    required: ["course_text"],
  }),
  execute: async ({ course_text }) => {
    if (!course_text) return { count: 0, results: [] };
    const { data, error } = await supabase.rpc("find_substitute_courses", {
      p_course_text: course_text,
    });
    if (error) return { error: error.message, results: [] };

    const byQuery = new Map<string, Array<{ substitute: string; original: string }>>();
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const key = `${r.query_course_cn}${r.query_course_code ? `(${r.query_course_code})` : ""}`;
      if (!byQuery.has(key)) byQuery.set(key, []);
      const sub = r.substitute_cn
        ? `${r.substitute_cn}${r.substitute_code ? `(${r.substitute_code})` : ""}`
        : null;
      const orig = r.original_cn
        ? `${r.original_cn}${r.original_code ? `(${r.original_code})` : ""}`
        : null;
      if (sub && orig) byQuery.get(key)!.push({ substitute: sub, original: orig });
    }

    return {
      count: byQuery.size,
      results: Array.from(byQuery.entries()).map(([k, v]) => ({
        query_course: k,
        substitutes: v.slice(0, 5),
      })),
    };
  },
});

// ===== 9. Dify 跨库兜底 =====

export const searchDifyFallbackTool = tool({
  description:
    "跨 5 个主题知识库(校历/班车/教务通知/图书馆/奖学金)并行检索兜底。**仅当用户问题无法明确归类到具体类目、或调用其他工具无结果时**调用此工具撒网式检索。优先尝试具体的 search_calendar / search_shuttle / search_notices / search_library_hours / search_scholarships / search_pois / search_courses 等工具,而不是先调用此工具。",
  inputSchema: jsonSchema<{ query: string }>({
    type: "object",
    properties: {
      query: { type: "string", description: "用户原始问题" },
    },
    required: ["query"],
  }),
  execute: async ({ query }) => {
    const text = await searchDifyAll(query);
    if (!text) return { count: 0, results: [], note: "Dify 5 库均无命中" };
    return {
      count: text.split("\n\n---\n\n").length,
      // Dify 返回的是 key: value 文本块,直接传给 LLM 解析
      raw_context: text,
      note: "Dify 返回 key: value 格式条目,每段以【类目名】前缀标注来源",
    };
  },
});

// ===== 10. 校历事件按日期精确查询(real-time) =====
//
// 与 search_calendar(向量相似查"什么时候开学")正交:这个工具是精确日期查询,
// 输入具体日期(YYYY-MM-DD),返回当天命中的校历事件(节假日/考试周/注册日/
// 调休补课)。让 LLM 能回答"下周二有课吗""2026-08-25 是节假日吗"这类基于
// 具体日期的问题,而不是只能做语义相似查询。

export const getCalendarEventsOnDateTool = tool({
  description:
    "查询某个具体日期(YYYY-MM-DD)当天命中的校历事件——节假日、考试周、开学注册、调休补课等。当用户问'某天有课吗''某天是节假日吗''下周二/这周五/8月25日 校历上是什么日子'等需要按具体日期判断的问题时调用。注意:这个工具不能告诉 LLM '某教室某时段是否空置'(课程表数据没有教室+时间字段),只能基于校历事件判断'该日是否节假日/调休/注册日'。",
  inputSchema: jsonSchema<{ date: string }>({
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "YYYY-MM-DD 格式的具体日期,如 '2026-08-25'。如果用户说'下周二'/'这周五',先解析成具体日期再传入。",
      },
    },
    required: ["date"],
  }),
  execute: async ({ date }) => {
    // 简单日期格式校验,防 LLM 传"下周二"未解析的字符串
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { error: `日期格式必须是 YYYY-MM-DD,收到 "${date}"`, results: [] };
    }
    const { data, error } = await supabase
      .from("campus_calendar")
      .select("event_title, start_date, end_date, semester, academic_year, source_url")
      .lte("start_date", date)
      .gte("end_date", date)
      .order("start_date");
    if (error) return { error: error.message, results: [] };

    // 过滤脏数据:爬虫偶发把纯数字/单字符当 event_title(如 "26"),这类无意义
    const cleaned = (data ?? []).filter(
      (e: Record<string, unknown>) =>
        typeof e.event_title === "string" && e.event_title.trim().length >= 2,
    );
    return {
      query_date: date,
      weekday: new Date(date + "T00:00:00").toLocaleDateString("zh-CN", { weekday: "long" }),
      count: cleaned.length,
      results: cleaned.map((e: Record<string, unknown>) => ({
        event_title: e.event_title,
        start_date: e.start_date,
        end_date: e.end_date,
        semester: e.semester,
        academic_year: e.academic_year,
        source_url: e.source_url,
      })),
      note: cleaned.length === 0 ? "该日不在校历任何事件范围内(可能是普通教学日)" : undefined,
    };
  },
});

// ===== 11. 按星期几精确过滤班车(real-time) =====
//
// 8/16 eval 里 Dify 失败的"周末有班车吗"——reranker 把"东区→西区 点对点"排到
// top1 而不是"周末班次"信息。这个工具按 weekday_only 字段精确过滤,根治该类问题。
//
// 数据现状(8/18 验证):campus_shuttle 29 条记录全部 weekday_only='true'(工作日班次),
// 没有周末班次数据。所以"周末有班车吗"会返回 0 条,LLM 据此明确回答"暂无周末班次"。

export const getShuttleOnDayTool = tool({
  description:
    "按星期几精确过滤班车班次。当用户问'周末有班车吗''周六去高新有什么班次''工作日班车时刻表'等需要按星期几过滤的问题时调用。input 的 weekday 必须是:周一/周二/周三/周四/周五/周六/周日/工作日/周末 之一。",
  inputSchema: jsonSchema<{ weekday: string }>({
    type: "object",
    properties: {
      weekday: {
        type: "string",
        description: "星期几,必须是:周一/周二/周三/周四/周五/周六/周日/工作日/周末 之一",
        enum: ["周一", "周二", "周三", "周四", "周五", "周六", "周日", "工作日", "周末"],
      },
    },
    required: ["weekday"],
  }),
  execute: async ({ weekday }) => {
    // weekday_only='true' 表示工作日班次,'false' 表示每日(含周末)班次
    // 周一~周五/工作日 → 两种都跑(工作日班次 + 每日班次)
    // 周六/周日/周末 → 只跑每日班次
    const isWeekend = weekday === "周六" || weekday === "周日" || weekday === "周末";

    let query = supabase
      .from("campus_shuttle")
      .select("route_name, direction, departure, arrival, depart_time, arrive_time, weekday_only, period, note")
      .order("depart_time");
    if (isWeekend) {
      query = query.eq("weekday_only", "false");
    } else {
      // 工作日:返回所有(目前数据全是 weekday_only='true')
      query = query.in("weekday_only", ["true", "false"]);
    }
    const { data, error } = await query;
    if (error) return { error: error.message, results: [] };

    return {
      query_weekday: weekday,
      is_weekend: isWeekend,
      count: data?.length ?? 0,
      results: (data ?? []).map((s: Record<string, unknown>) => ({
        route_name: s.route_name,
        direction: s.direction,
        departure: s.departure,
        arrival: s.arrival,
        depart_time: s.depart_time,
        arrive_time: s.arrive_time,
        weekday_only: s.weekday_only === "true" ? "工作日" : "每日含周末",
        period: s.period,
        note: s.note,
      })),
      note: (data?.length ?? 0) === 0 ? `当前数据库中${isWeekend ? "周末" : "工作日"}无对应班次记录` : undefined,
    };
  },
});

// ===== 工具集合 =====

export const campusTools = {
  search_calendar: searchCalendarTool,
  search_shuttle: searchShuttleTool,
  search_notices: searchNoticesTool,
  search_library_hours: searchLibraryHoursTool,
  search_scholarships: searchScholarshipsTool,
  search_pois: searchPoisTool,
  search_courses: searchCoursesTool,
  find_substitute_courses: findSubstituteCoursesTool,
  search_dify_fallback: searchDifyFallbackTool,
  get_calendar_events_on_date: getCalendarEventsOnDateTool,
  get_shuttle_on_day: getShuttleOnDayTool,
};
