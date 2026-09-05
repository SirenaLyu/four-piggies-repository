// ============================================================================

import { TtlLruCache } from "./ttl-lru-cache.ts";
import { linksInSource, safeSourceUrl, sourceTextId, type AnswerSource } from "./sources.ts";
import { withTimeoutSignal } from "./abort-signals.ts";
import {
  errorMessage,
  logEvent,
  type TelemetryContext,
} from "./telemetry.ts";
// Dify 知识库检索模块
// ----------------------------------------------------------------------------
// 调用自建 Dify 的「知识库检索 API」（Dataset Retrieval API）：
//   POST {DIFY_BASE_URL}/v1/datasets/{DATASET_ID}/retrieve
// 支持通过环境变量 DATASET_IDS 配置多个知识库，
// 并发检索所有知识库后按相似度合并去重，组装成可送入大模型的上下文。
//
// 相关环境变量：
//   DIFY_BASE_URL              Dify 服务地址（如 http://111.111.111.111，结尾不带 /v1）
//   DIFY_KNOWLEDGE_API_KEY     Dify「知识库」API Key（注意不是应用 app-xxx Key）
//   DATASET_IDS                知识库 Dataset ID 列表，英文逗号分隔，如 "id1,id2,id3"
//   DIFY_RETRIEVAL_TOP_K       （可选）每库候选数，默认 5
//   DIFY_RETRIEVAL_SCORE_THRESHOLD （可选）设置后才启用统一阈值
//   DIFY_DATASET_SCORE_THRESHOLDS  （可选）按 Dataset ID 设置独立最低分数
//   DIFY_RERANKING_ENABLED     （可选）默认 true
//   DIFY_RERANKING_PROVIDER / DIFY_RERANKING_MODEL （可选）覆盖 reranker
// ============================================================================

/** 单次检索请求的超时时间（毫秒） */
const REQUEST_TIMEOUT_MS = 15_000;

/** 最终送入大模型的知识库片段数量上限（控制上下文长度、降低首字与总延迟） */
const MAX_CONTEXT_CHUNKS = 12;

type DatasetRoute =
  | "scholarships"
  | "library"
  | "notices"
  | "shuttle"
  | "calendar"
  | "courses"
  | "faculty"
  | "policies"
  | "info";

const EXACT_COURSE_QUERY_PATTERN =
  /(?:课堂号|课程号|课程代码)|\b(?:[A-Z]{2,}\d{3,}(?:\.\d+)?|\d{4,}\.\d{1,3}|\d{2,}[A-Z]\d{2,})\b/i;

const FACULTY_QUERY_PATTERN =
  /教师|老师|教授|副教授|研究员|导师|博导|硕导|研究方向|研究领域|科研成果|论文|专利|获奖|课题组|实验室负责人/;

export function extractFacultyNameQuery(query: string): string | undefined {
  const withoutLeadIn = query
    .replace(/中国科学技术大学|中国科大|中科大|科大/g, " ")
    .replace(/请问|请查|帮我查|查一下|介绍一下|我想了解|想了解/g, " ")
    .replace(
      /[\p{Script=Han}]{2,18}(?:学院|学部|实验室|研究中心|研究院|系)/gu,
      " ",
    );
  const matches = [
    ...withoutLeadIn.matchAll(
      /([\p{Script=Han}·]{2,4}?)\s*(?=(?:老师|教师|副教授|教授|研究员|导师|博导|硕导)|的?\s*(?:职称|研究方向|研究领域|科研成果|论文|专利|获奖|成果))/gu,
    ),
  ];
  const candidate = matches[0]?.[1];
  if (!candidate || /哪些|什么|研究|方向|成果|老师|教师|的|和|与|谁|哪|有/.test(candidate)) {
    return undefined;
  }
  return candidate;
}

const COURSE_STRUCTURED_FIELD_PATTERN =
  /学分|学时|时间|地点|教室|上课|评分|评价人数|选课人数|限选人数|考核/;

function courseCodeBase(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (normalized.includes(".")) return normalized.replace(/\.\d+$/, "");
  return normalized.replace(/\d{2}$/, "");
}

function courseRequestedFieldPatterns(query: string): RegExp[] {
  return [
    /学分/.test(query) && /学分：/,
    /学时/.test(query) && /学时：/,
    /时间|上课/.test(query) && /时间地点：/,
    /地点|教室|上课/.test(query) && /时间地点：/,
    /评分|评价/.test(query) && /评课社区评分：/,
    /人数/.test(query) && /(?:评价人数|选课人数|限选人数)：/,
    /考核/.test(query) && /考核方式：/,
  ].filter((pattern): pattern is RegExp => pattern instanceof RegExp);
}

function isCourseStructuredHit(
  teacherName: string,
  fieldPatterns: RegExp[],
  chunk: KnowledgeChunk,
): boolean {
  return (
    chunk.content.includes(`授课教师：${teacherName}`) &&
    fieldPatterns.every((pattern) => pattern.test(chunk.content))
  );
}

/**
 * “某老师教什么课、多少学分”需要先从评课卡片识别课程代码，再查开课表。
 * 返回的查询会作为同一课程库内的第二跳检索；没有明确姓名/结构化字段时不扩展。
 */
export function buildCourseFollowupQueries(
  query: string,
  chunks: KnowledgeChunk[],
): string[] {
  const teacherName = extractFacultyNameQuery(query);
  if (!teacherName || !COURSE_STRUCTURED_FIELD_PATTERN.test(query)) return [];
  const requestedFieldPatterns = courseRequestedFieldPatterns(query);
  if (
    chunks.some((chunk) =>
      isCourseStructuredHit(teacherName, requestedFieldPatterns, chunk),
    )
  ) {
    return [];
  }

  const requestedFields = [
    /学分/.test(query) && "学分",
    /学时/.test(query) && "学时",
    /时间|上课/.test(query) && "时间",
    /地点|教室|上课/.test(query) && "地点",
    /评分|评价/.test(query) && "评分",
    /人数/.test(query) && "人数",
    /考核/.test(query) && "考核",
  ].filter(Boolean);
  const codes = new Set<string>();
  for (const chunk of chunks) {
    if (!chunk.content.includes(teacherName)) continue;
    for (const match of chunk.content.matchAll(
      /评课社区课程代码：([A-Z0-9._-]{5,})/gi,
    )) {
      const base = courseCodeBase(match[1]);
      if (base.length >= 4) codes.add(base);
      if (codes.size >= 4) break;
    }
    if (codes.size >= 4) break;
  }
  return [...codes].map(
    (code) => `${code} ${teacherName} ${requestedFields.join(" ")}`.trim(),
  );
}

const KNOWN_DATASET_ROUTES: Record<DatasetRoute, string[]> = {
  scholarships: ["058eb792-77df-4c98-8f40-1feabf5c10dc"],
  library: ["748dd072-a42c-4cfc-8df4-b0dc9432be50"],
  notices: ["76ca3310-ba82-4cd4-90d8-c3ed6fc1f3a8"],
  shuttle: ["781772a0-fee6-4077-ae61-c4eb16448c37"],
  calendar: ["ab7400a3-b5c5-4f80-8d75-84be0cc4bb63"],
  info: ["975e7edb-4979-4cfe-95e2-9cc2f782488d"],
  courses: ["1e3922a5-c7a6-4307-a852-62921e2a843b"],
  faculty: ["975e7edb-4979-4cfe-95e2-9cc2f782488d"],
  policies: ["ef053c5b-7d01-40e7-a2b6-cbce54ac261f"],
};

const DATASET_ROUTE_KEYWORDS: Record<DatasetRoute, RegExp> = {
  scholarships: /奖学金|助学金|奖助|资助|助学贷款|评优|评奖|困难生/,
  library: /图书馆|借书|借.{0,4}本书|借阅|还书|续借|开馆|闭馆|馆藏|座位|数据库|文献/,
  notices: /通知|公告|公示|讲座|活动|新闻|最新|教务处动态/,
  shuttle: /班车|校车|发车|乘车|车次|东区.*西区|西区.*东区|高新区/,
  calendar: /校历|开学|放假|寒假|暑假|考试周|学期|注册时间|报到时间/,
  courses:
    /课程|选课|课表|学分|课程号|课堂号|课程代码|上课|授课|任课|教.{0,6}课|\b(?:[A-Z]{2,}\d{3,}(?:\.\d+)?|\d{4,}\.\d{1,3}|\d{2,}[A-Z]\d{2,})\b/i,
  faculty:
    /教师|老师|教授|副教授|研究员|导师|博导|硕导|研究方向|研究领域|科研成果|论文|专利|课题组|实验室负责人/,
  policies: /政策|规定|办法|制度|流程|申请|办理|手续|材料|指南|细则/,
  info: /地址|电话|联系方式|联系人|办公地点|办公室|部门|机构|校区|食堂|餐厅|美食广场|宿舍|校园卡|一卡通/,
};

const PRIMARY_DATASET_ROUTES: DatasetRoute[] = [
  "scholarships",
  "library",
  "shuttle",
  "calendar",
  "courses",
  "faculty",
];

const DATASET_ROUTE_LABELS: Record<DatasetRoute, string> = {
  scholarships: "奖助学金",
  library: "图书馆",
  notices: "通知公告",
  shuttle: "班车",
  calendar: "校历",
  courses: "课程",
  faculty: "教师信息",
  policies: "政策指南",
  info: "校园信息",
};

/** 检索结果缓存 TTL（毫秒）：同一问题短时间内直接复用结果，避免反复请求 Dify */
const RETRIEVAL_CACHE_TTL_MS = 5 * 60 * 1000;
const RETRIEVAL_CACHE_MAX_ENTRIES = 200;
const retrievalCache = new TtlLruCache<string, KnowledgeRetrievalResult>(
  RETRIEVAL_CACHE_MAX_ENTRIES,
  RETRIEVAL_CACHE_TTL_MS,
);

function normalizeQueryKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/** 从知识库检索到的文本片段 */
export interface KnowledgeChunk {
  /** 来自哪个知识库（Dataset ID） */
  datasetId: string;
  /** 文本段落内容 */
  content: string;
  /** 相似度分数（越高越相关） */
  score: number;
  documentTitle?: string;
  documentId?: string;
  segmentId?: string;
  sourceUrl?: string;
}

/** 检索结果：context 可直接作为工具返回值交给大模型 */
export interface KnowledgeRetrievalResult {
  /** 是否成功检索到内容 */
  ok: boolean;
  /** 拼接好的上下文字符串 */
  context: string;
  /** 去重后的片段数量 */
  chunkCount: number;
  /** 失败或部分失败时的提示信息 */
  error?: string;
  sources?: AnswerSource[];
}

/** 读取 Dify 知识库相关环境变量配置 */
export function getDifyKnowledgeConfig(): {
  baseUrl?: string;
  apiKey?: string;
  datasetIds: string[];
} {
  return {
    baseUrl: process.env.DIFY_BASE_URL?.trim() || undefined,
    apiKey: process.env.DIFY_KNOWLEDGE_API_KEY?.trim() || undefined,
    datasetIds: (process.env.DATASET_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  };
}

function parseDatasetRouteMap(
  value: string | undefined,
): Partial<Record<DatasetRoute, string[]>> {
  if (!value?.trim()) return {};
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    const parsed: Partial<Record<DatasetRoute, string[]>> = {};
    for (const route of Object.keys(KNOWN_DATASET_ROUTES) as DatasetRoute[]) {
      const ids = raw[route];
      if (!Array.isArray(ids)) continue;
      parsed[route] = ids
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean);
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[dify-knowledge] DIFY_DATASET_ROUTE_MAP 不是合法 JSON：${message}`);
    return {};
  }
}

function effectiveDatasetRoutes(
  configuredValue: string | undefined,
): Record<DatasetRoute, string[]> {
  const configured = parseDatasetRouteMap(configuredValue);
  return Object.fromEntries(
    (Object.keys(KNOWN_DATASET_ROUTES) as DatasetRoute[]).map((route) => [
      route,
      configured[route]?.length ? configured[route] : KNOWN_DATASET_ROUTES[route],
    ]),
  ) as Record<DatasetRoute, string[]>;
}

/**
 * 根据查询主题选择少量相关数据集，避免无条件把每个数据集的 top-1 都塞入上下文。
 * 未匹配到主题时，项目内置数据集回退到校园信息/政策/通知；自定义数据集则保持全查兼容。
 */
export function routeDatasetIds(
  query: string,
  datasetIds: string[],
  configuredValue: string | undefined = process.env.DIFY_DATASET_ROUTE_MAP,
): string[] {
  const allowed = new Set(datasetIds);
  const routes = effectiveDatasetRoutes(configuredValue);
  let matchedRoutes = (Object.keys(DATASET_ROUTE_KEYWORDS) as DatasetRoute[])
    .filter((route) => DATASET_ROUTE_KEYWORDS[route].test(query));
  // “授课教师/哪位老师上课”只需要课程库；同时询问研究、职称或成果时才并查教师库。
  if (
    matchedRoutes.includes("courses") &&
    matchedRoutes.includes("faculty") &&
    !/职称|导师资格|研究方向|研究领域|研究(?:什么|哪些|哪)|科研成果|论文|专利|获奖|课题组|实验室负责人/.test(query)
  ) {
    matchedRoutes = matchedRoutes.filter((route) => route !== "faculty");
  }

  const idsForRoutes = (routeNames: DatasetRoute[]) =>
    Array.from(
      new Set(
        routeNames.flatMap((route) => routes[route]).filter((id) => allowed.has(id)),
      ),
    );

  const primaryRoutes = matchedRoutes.filter((route) =>
    PRIMARY_DATASET_ROUTES.includes(route),
  );
  const matchedIds = idsForRoutes(
    primaryRoutes.length > 0 ? primaryRoutes : matchedRoutes,
  );
  if (matchedIds.length > 0) return matchedIds;

  const defaultIds = idsForRoutes(["info", "policies", "notices"]);
  return defaultIds.length > 0 ? defaultIds : datasetIds;
}

function datasetLabel(
  datasetId: string,
  configuredValue: string | undefined = process.env.DIFY_DATASET_ROUTE_MAP,
): string {
  const routes = effectiveDatasetRoutes(configuredValue);
  for (const route of Object.keys(routes) as DatasetRoute[]) {
    if (routes[route].includes(datasetId)) return DATASET_ROUTE_LABELS[route];
  }
  return datasetId;
}

/**
 * 从 Dify 返回的一条 record 中提取 content 与 score
 * 当前 Dify 结构通常是 record.segment.content + record.score；
 * 同时兼容分数位于 segment 内、内容直接位于 record 上的旧结构。
 */
export function extractRecord(
  record: unknown,
  datasetId: string,
): KnowledgeChunk | null {
  if (!record || typeof record !== "object") return null;
  const raw = record as Record<string, unknown>;
  const segment = (raw.segment ?? raw) as Record<string, unknown>;

  const content =
    typeof segment.content === "string" ? segment.content.trim() : "";
  if (!content) return null;

  const score =
    typeof raw.score === "number"
      ? raw.score
      : typeof segment.score === "number"
        ? segment.score
        : 0;
  const chunk: KnowledgeChunk = { datasetId, content, score };
  const document = (segment.document ?? raw.document) as Record<string, unknown> | undefined;
  if (typeof document?.name === "string") chunk.documentTitle = document.name.slice(0, 160);
  if (typeof document?.id === "string") chunk.documentId = document.id;
  if (typeof segment.id === "string") chunk.segmentId = segment.id;
  const sourceUrl = safeSourceUrl(document?.url);
  if (sourceUrl) chunk.sourceUrl = sourceUrl;
  return chunk;
}

/** 兼容 Dify 的 records 与 data.records 两种响应包裹。 */
export function extractRecordsFromResponse(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const raw = data as { records?: unknown; data?: { records?: unknown } };
  if (Array.isArray(raw.records)) return raw.records;
  return Array.isArray(raw.data?.records) ? raw.data.records : [];
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseDatasetScoreThresholds(
  value: string | undefined,
): Record<string, number> {
  if (!value?.trim()) return {};
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(raw).filter(
        (entry): entry is [string, number] =>
          Boolean(entry[0].trim()) &&
          typeof entry[1] === "number" &&
          Number.isFinite(entry[1]) &&
          entry[1] >= 0 &&
          entry[1] <= 1,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[dify-knowledge] DIFY_DATASET_SCORE_THRESHOLDS 不是合法 JSON：${message}`,
    );
    return {};
  }
}

export function filterChunksByDatasetThreshold(
  chunks: KnowledgeChunk[],
  datasetId: string,
  configuredValue: string | undefined =
    process.env.DIFY_DATASET_SCORE_THRESHOLDS,
): KnowledgeChunk[] {
  const threshold = parseDatasetScoreThresholds(configuredValue)[datasetId];
  return threshold === undefined
    ? chunks
    : chunks.filter((chunk) => chunk.score >= threshold);
}

/** 默认使用 semantic；课程号和教师姓名/成果类精确查询使用 hybrid 扩大候选。 */
export function buildRetrievalModel(
  env: NodeJS.ProcessEnv = process.env,
  query = "",
): Record<string, unknown> {
  const isExactLookupQuery =
    EXACT_COURSE_QUERY_PATTERN.test(query) || FACULTY_QUERY_PATTERN.test(query);
  const rerankingEnabled = env.DIFY_RERANKING_ENABLED?.trim().toLowerCase() !== "false";
  const threshold = Number(env.DIFY_RETRIEVAL_SCORE_THRESHOLD);
  const thresholdEnabled =
    Boolean(env.DIFY_RETRIEVAL_SCORE_THRESHOLD?.trim()) && Number.isFinite(threshold);
  const model: Record<string, unknown> = {
    search_method:
      env.DIFY_RETRIEVAL_SEARCH_METHOD?.trim() ||
      (isExactLookupQuery
        ? "hybrid_search"
        : "semantic_search"),
    reranking_enable: rerankingEnabled,
    top_k: Math.min(
      20,
      Math.floor(
        numberFromEnv(env.DIFY_RETRIEVAL_TOP_K, isExactLookupQuery ? 10 : 5),
      ),
    ),
    score_threshold_enabled: thresholdEnabled,
  };
  if (rerankingEnabled) {
    model.reranking_mode = "reranking_model";
    model.reranking_model = {
      reranking_provider_name:
        env.DIFY_RERANKING_PROVIDER?.trim() || "langgenius/siliconflow/siliconflow",
      reranking_model_name:
        env.DIFY_RERANKING_MODEL?.trim() || "BAAI/bge-reranker-v2-m3",
    };
  }
  if (thresholdEnabled) model.score_threshold = threshold;
  return model;
}

export function buildKnowledgeCacheKey(
  query: string,
  config: { baseUrl: string; datasetIds: string[] },
  env: NodeJS.ProcessEnv = process.env,
): string {
  return JSON.stringify({
    query: normalizeQueryKey(query),
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    datasetIds: [...config.datasetIds].sort(),
    routeMap: env.DIFY_DATASET_ROUTE_MAP?.trim() || "",
    retrievalModel: buildRetrievalModel(env, query),
    datasetThresholds: parseDatasetScoreThresholds(
      env.DIFY_DATASET_SCORE_THRESHOLDS,
    ),
    maxContextChunks: env.DIFY_MAX_CONTEXT_CHUNKS?.trim() || "",
  });
}

/**
 * 各库 reranker 分数不可直接比较，因此按 Dify 给出的库内顺序轮转选取。
 * 第一轮先保留每个有结果知识库的 top-1，再进入第二轮，避免某个高分库
 * 把其他库的正确候选全部挤出上下文。
 */
export function selectContextChunks(
  chunksByDataset: KnowledgeChunk[][],
  limit = MAX_CONTEXT_CHUNKS,
): KnowledgeChunk[] {
  const selected: KnowledgeChunk[] = [];
  const seen = new Set<string>();
  const cursors = chunksByDataset.map(() => 0);

  while (selected.length < limit) {
    let addedThisRound = false;
    for (let datasetIndex = 0; datasetIndex < chunksByDataset.length; datasetIndex++) {
      const chunks = chunksByDataset[datasetIndex];
      while (cursors[datasetIndex] < chunks.length) {
        const chunk = chunks[cursors[datasetIndex]++];
        if (seen.has(chunk.content)) continue;
        seen.add(chunk.content);
        selected.push(chunk);
        addedThisRound = true;
        break;
      }
      if (selected.length >= limit) break;
    }
    if (!addedThisRound) break;
  }
  return selected;
}

/**
 * 请求单个知识库的检索接口
 * 失败时抛出异常，由上层 Promise.allSettled 兜底，不影响其他知识库
 */
async function retrieveFromDataset(
  baseUrl: string,
  apiKey: string,
  datasetId: string,
  query: string,
  requestSignal?: AbortSignal,
  telemetry: TelemetryContext = {
    requestId: "background",
    scope: "knowledge",
  },
): Promise<KnowledgeChunk[]> {
  const exactFacultyName = KNOWN_DATASET_ROUTES.faculty.includes(datasetId)
    ? extractFacultyNameQuery(query)
    : undefined;
  const retrieveOnce = async (effectiveQuery: string): Promise<KnowledgeChunk[]> => {
    const body: Record<string, unknown> = {
      query: effectiveQuery,
      retrieval_model: buildRetrievalModel(process.env, effectiveQuery),
    };

    // 超时通过 AbortSignal 控制，避免请求挂死拖垮主进程
    const startedAt = Date.now();
    const response = await fetch(
      `${baseUrl}/v1/datasets/${datasetId}/retrieve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // 注意：Bearer 使用的是 Dify 知识库的 API Key
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: withTimeoutSignal(requestSignal, REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `HTTP ${response.status}${errorText ? `：${errorText.slice(0, 200)}` : ""}（耗时 ${Date.now() - startedAt}ms）`,
      );
    }

    const data = await response.json();
    const records = extractRecordsFromResponse(data);
    logEvent(telemetry, "knowledge.dataset_completed", {
      datasetId,
      durationMs: Date.now() - startedAt,
      recordCount: records.length,
      rewrittenQuery: effectiveQuery !== query,
      facultyNameQuery: Boolean(exactFacultyName),
    });
    const chunks = records
      .map((record) => extractRecord(record, datasetId))
      .filter((chunk): chunk is KnowledgeChunk => chunk !== null);
    const filtered = filterChunksByDatasetThreshold(chunks, datasetId);
    if (filtered.length !== chunks.length) {
      logEvent(telemetry, "knowledge.dataset_filtered", {
        datasetId,
        filteredCount: chunks.length - filtered.length,
      });
    }
    return filtered;
  };

  const primaryChunks = await retrieveOnce(exactFacultyName ?? query);
  if (!KNOWN_DATASET_ROUTES.courses.includes(datasetId)) return primaryChunks;

  const followupQueries = buildCourseFollowupQueries(query, primaryChunks);
  if (followupQueries.length === 0) return primaryChunks;
  const followups = await Promise.allSettled(followupQueries.map(retrieveOnce));
  const teacherName = extractFacultyNameQuery(query);
  const fieldPatterns = courseRequestedFieldPatterns(query);
  const followupChunks = followups.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  // 同一课程库、不同第二跳查询的分数不可直接比较；先把同时包含教师和所求字段的
  // 结构化开课记录前置，再保持各查询原有顺序。
  const rankedFollowupChunks = teacherName
    ? followupChunks
        .map((chunk, index) => ({
          chunk,
          index,
          structured: isCourseStructuredHit(teacherName, fieldPatterns, chunk),
        }))
        .sort(
          (left, right) =>
            Number(right.structured) - Number(left.structured) ||
            left.index - right.index,
        )
        .map(({ chunk }) => chunk)
    : followupChunks;
  const merged: KnowledgeChunk[] = [];
  const seen = new Set<string>();
  for (const chunk of [
    ...rankedFollowupChunks,
    ...primaryChunks,
  ]) {
    if (seen.has(chunk.content)) continue;
    seen.add(chunk.content);
    merged.push(chunk);
  }
  logEvent(telemetry, "knowledge.course_followup_completed", {
    datasetId,
    queryCount: followupQueries.length,
    resultCount: merged.length,
    failedCount: followups.filter((result) => result.status === "rejected").length,
  });
  return merged;
}

/**
 * 检索所有已配置的 Dify 知识库，并组装上下文
 * - 使用 Promise.allSettled 并发请求，单个知识库失败不影响整体
 * - 按 content 精确去重，并按知识库轮转保留候选（跨库分数不可比较）
 * - 任何异常都在内部消化，绝不向调用方抛出（保证 Agent 主进程不崩溃）
 */
export async function retrieveKnowledgeContext(
  query: string,
  requestSignal?: AbortSignal,
  telemetry: TelemetryContext = {
    requestId: "background",
    scope: "knowledge",
  },
): Promise<KnowledgeRetrievalResult> {
  const { baseUrl, apiKey, datasetIds } = getDifyKnowledgeConfig();

  if (!baseUrl || !apiKey || datasetIds.length === 0) {
    const missing = [
      !baseUrl && "DIFY_BASE_URL",
      !apiKey && "DIFY_KNOWLEDGE_API_KEY",
      datasetIds.length === 0 && "DATASET_IDS",
    ]
      .filter(Boolean)
      .join("、");
    return {
      ok: false,
      context: "",
      chunkCount: 0,
      error: `知识库服务未配置（缺少环境变量：${missing}）`,
    };
  }

  const cacheKey = buildKnowledgeCacheKey(query, { baseUrl, datasetIds });
  const cached = retrievalCache.get(cacheKey);
  if (cached) {
    logEvent(telemetry, "knowledge.cache_hit", {
      chunkCount: cached.chunkCount,
    });
    return cached;
  }

  const routedDatasetIds = routeDatasetIds(query, datasetIds);
  logEvent(telemetry, "knowledge.routed", {
    routedCount: routedDatasetIds.length,
    configuredCount: datasetIds.length,
    routes: routedDatasetIds.map((id) => datasetLabel(id)).join(","),
  });

  // 只并发请求与查询主题相关的知识库
  const retrieveStartedAt = Date.now();
  const settled = await Promise.allSettled(
    routedDatasetIds.map((datasetId) =>
      retrieveFromDataset(
        baseUrl,
        apiKey,
        datasetId,
        query,
        requestSignal,
        telemetry,
      ),
    ),
  );
  if (requestSignal?.aborted) {
    throw requestSignal.reason ?? new DOMException("请求已取消", "AbortError");
  }
  logEvent(telemetry, "knowledge.datasets_settled", {
    datasetCount: routedDatasetIds.length,
    durationMs: Date.now() - retrieveStartedAt,
  });

  const chunksByDataset: KnowledgeChunk[][] = [];
  const failedDatasets: string[] = [];

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      chunksByDataset.push(result.value);
    } else {
      failedDatasets.push(routedDatasetIds[index]);
      logEvent(
        telemetry,
        "knowledge.dataset_failed",
        {
          datasetId: routedDatasetIds[index],
          error: errorMessage(result.reason),
        },
        "error",
      );
    }
  });

  // 全部知识库都失败：返回友好提示，不抛异常
  if (chunksByDataset.every((chunks) => chunks.length === 0)) {
    const reason =
      failedDatasets.length > 0 ? `（${failedDatasets.length} 个知识库请求失败，请检查 Dify 服务状态与 API Key）` : "";
    const result: KnowledgeRetrievalResult = {
      ok: false,
      context: "",
      chunkCount: 0,
      error: `所有知识库均未返回内容${reason}`,
    };
    // 临时故障和空结果不缓存，避免 Dify 恢复后仍持续返回失败。
    return result;
  }

  const maxContextChunks = Math.min(
    24,
    Math.floor(numberFromEnv(process.env.DIFY_MAX_CONTEXT_CHUNKS, MAX_CONTEXT_CHUNKS)),
  );
  const uniqueChunks = selectContextChunks(chunksByDataset, maxContextChunks);

  // 拼接为送入大模型的上下文：带序号与相似度标注，便于模型筛选引用
  const context = uniqueChunks
    .map(
      (chunk, index) =>
        `【片段 ${index + 1}｜${datasetLabel(chunk.datasetId)}｜库内分数 ${chunk.score.toFixed(3)}】\n${chunk.content}`,
    )
    .join("\n\n---\n\n");

  const error =
    failedDatasets.length > 0
      ? `警告：知识库 ${failedDatasets.join("、")} 检索失败，以下结果来自其余知识库`
      : undefined;

  const result: KnowledgeRetrievalResult = {
    ok: true,
    context,
    chunkCount: uniqueChunks.length,
    sources: uniqueChunks.map((chunk, index) => ({
      id: `knowledge:${chunk.datasetId}:${chunk.documentId ?? "document"}:${chunk.segmentId ?? sourceTextId(chunk.content)}`,
      kind: "knowledge",
      title: chunk.documentTitle || `${datasetLabel(chunk.datasetId)} · 片段 ${index + 1}`,
      dataset: datasetLabel(chunk.datasetId),
      excerpt: chunk.content.slice(0, 2500),
      url: chunk.sourceUrl,
      links: linksInSource(chunk.content),
    })),
    error,
  };
  logEvent(telemetry, "knowledge.context_ready", {
    durationMs: Date.now() - retrieveStartedAt,
    chunkCount: uniqueChunks.length,
    failedDatasetCount: failedDatasets.length,
    contextChars: context.length,
  });
  retrievalCache.set(cacheKey, result);
  return result;
}
