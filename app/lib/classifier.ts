/**
 * 问题分类器 —— 用 embedding 余弦相似度把用户问题路由到 7 类校园功能之一
 *
 * 设计:
 *   - 7 类预设描述,模块加载时并行 embed 并缓存
 *   - 用户问题 embed 一次后,与 7 个类目向量算余弦,选 top-1/top-2
 *   - top-1 ≥ 0.35 → primary;top-2 ≥ 0.42 且与 top-1 差距 ≤ 0.08 → secondary
 *   - 否则 fallback(走通用校园文档检索)
 *
 * 用于 app/api/chat/route.ts 的分类路由层。
 */

import { embed } from "ai";
import { embeddingClient, EMBEDDING_MODEL } from "./ai-clients";

export type Category =
  | "calendar"
  | "shuttle"
  | "notices"
  | "library"
  | "scholarships"
  | "poi"
  | "courses"
  | "fallback";

type NonFallback = Exclude<Category, "fallback">;

export interface ClassifyResult {
  primary: Category;
  secondary: Category | null;
  scores: Record<NonFallback, number>;
}

const CATEGORY_DESCRIPTIONS: Record<NonFallback, string> = {
  calendar:
    "中国科学技术大学校历、学期安排、开学放假时间、考试周、节假日、注册报到日程",
  shuttle:
    "科大校区之间通勤班车时刻表、发车时间、发车点、工作日班次、高新先研院专线",
  notices:
    "中国科学技术大学教务处通知、教学事务公告、选课、考试、毕业、学籍、报名通知、本科生实习管理、助教岗位、教室开放、毕业论文选题、课程安排",
  library:
    "中科大图书馆开放时间、各楼层服务窗口、阅览室、借还书、电话、校区分馆",
  scholarships:
    "中国科学技术大学奖学金、助学金、奖项评选、公示通知、申请截止日期、联系人邮箱、助学贷款、勤工助学岗位、资助育人、绿色通道",
  poi: "科大校园地点、教学楼、食堂、宿舍、办公地点、AED、出入口、报警点、校车点、地址电话、餐厅、楼层位置、在哪个校区、怎么走",
  courses: "中国科学技术大学课程、课程名、课程代码、学时学分、替代课、等效课程",
};

const CATEGORY_ORDER: NonFallback[] = [
  "calendar",
  "shuttle",
  "notices",
  "library",
  "scholarships",
  "poi",
  "courses",
];

const PRIMARY_THRESHOLD = 0.35;
const SECONDARY_THRESHOLD = 0.42;
const SECONDARY_GAP = 0.08;
// top-1 领先 top-2 不足此值时,认为是弱信号 → 降级 fallback。
// 防止"合肥明天天气"这类无关问题因为某类目偶发略高而被误判。
const PRIMARY_MIN_LEAD = 0.03;
// top-1 分数足够高(强信号)时直接接受,bypass MIN_LEAD。
// 修复"本科生选课什么时候开始"这种 top1=notices(0.505) 但 top2=shuttle(0.501) gap=0.004 被误降级 fallback 的案例。
const STRONG_THRESHOLD = 0.50;

// ===== 类目向量缓存(模块加载时并行 embed,fire-and-forget 预加载) =====

let categoryEmbeddingsCache: Promise<Record<NonFallback, number[]>> | null = null;

function buildCategoryEmbeddings(): Promise<Record<NonFallback, number[]>> {
  const entries = CATEGORY_ORDER.map(async (c) => {
    const { embedding } = await embed({
      model: embeddingClient.embedding(EMBEDDING_MODEL),
      value: CATEGORY_DESCRIPTIONS[c],
    });
    return [c, embedding] as const;
  });
  return Promise.all(entries).then((pairs) =>
    pairs.reduce(
      (acc, [c, v]) => {
        acc[c] = v;
        return acc;
      },
      {} as Record<NonFallback, number[]>,
    ),
  );
}

function getCategoryEmbeddings(): Promise<Record<NonFallback, number[]>> {
  if (!categoryEmbeddingsCache) {
    categoryEmbeddingsCache = buildCategoryEmbeddings();
  }
  return categoryEmbeddingsCache;
}

// 模块加载即预加载(不阻塞 import,首次请求通常命中缓存)
void getCategoryEmbeddings();

// ===== 余弦相似度(纯 TS,无依赖) =====

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ===== 主分类函数 =====

/**
 * 用已 embed 的问题向量做分类(chat route 只 embed 一次,向量复用)。
 */
export async function classifyWithEmbedding(
  queryEmbedding: number[],
): Promise<ClassifyResult> {
  const categoryEmbeddings = await getCategoryEmbeddings();

  const scores = CATEGORY_ORDER.reduce(
    (acc, c) => {
      acc[c] = cosineSimilarity(queryEmbedding, categoryEmbeddings[c]);
      return acc;
    },
    {} as Record<NonFallback, number>,
  );

  const ranked = CATEGORY_ORDER
    .map((c) => ({ category: c, score: scores[c] }))
    .sort((a, b) => b.score - a.score);

  const top1 = ranked[0];
  const top2 = ranked[1];

  let primary: Category = "fallback";
  if (top1 && top1.score >= PRIMARY_THRESHOLD) {
    // 强信号(top-1 ≥ 0.50)直接接受;否则要求对 top-2 领先 ≥ MIN_LEAD(或只有 1 个候选)
    const lead = top2 ? top1.score - top2.score : 1;
    if (top1.score >= STRONG_THRESHOLD || lead >= PRIMARY_MIN_LEAD) {
      primary = top1.category;
    }
  }

  let secondary: Category | null = null;
  if (
    primary !== "fallback" &&
    top2 &&
    top2.score >= SECONDARY_THRESHOLD &&
    top1.score - top2.score <= SECONDARY_GAP
  ) {
    secondary = top2.category;
  }

  return { primary, secondary, scores };
}

// ===== 课程替代查询意图检测(从 route.ts 迁过来) =====

/**
 * 检测问题是否与"课程替代"相关,命中时额外查 campus_substitute_pool。
 * 关键词覆盖:替代/代替/替换/换课/等效课程/学分互认 等。
 */
export function isCourseSubstituteQuery(q: string): boolean {
  return /替代|代替|替换|换课|等效课程|学分互认|能不能代替|可以替代|能替代|可替代/.test(
    q,
  );
}

/**
 * 从用户问题中抠出课程名(供 find_substitute_courses 文本检索)。
 * 支持两种语序:
 *   "X 能替代 什么课"   → 课程名 X 在关键词前
 *   "能替代 X 吗"       → 课程名 X 在关键词后
 */
export function extractCourseName(query: string): string {
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
