// ============================================================================

import { TtlLruCache } from "./ttl-lru-cache.ts";
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
  | "policies"
  | "info";

const EXACT_COURSE_QUERY_PATTERN =
  /(?:课堂号|课程号|课程代码)|\b(?:[A-Z]{2,}\d{3,}(?:\.\d+)?|\d{2,}[A-Z]\d{2,})\b/i;

const KNOWN_DATASET_ROUTES: Record<DatasetRoute, string[]> = {
  scholarships: ["058eb792-77df-4c98-8f40-1feabf5c10dc"],
  library: ["748dd072-a42c-4cfc-8df4-b0dc9432be50"],
  notices: ["76ca3310-ba82-4cd4-90d8-c3ed6fc1f3a8"],
  shuttle: ["781772a0-fee6-4077-ae61-c4eb16448c37"],
  calendar: ["ab7400a3-b5c5-4f80-8d75-84be0cc4bb63"],
  info: ["975e7edb-4979-4cfe-95e2-9cc2f782488d"],
  courses: ["1e3922a5-c7a6-4307-a852-62921e2a843b"],
  policies: ["ef053c5b-7d01-40e7-a2b6-cbce54ac261f"],
};

const DATASET_ROUTE_KEYWORDS: Record<DatasetRoute, RegExp> = {
  scholarships: /奖学金|助学金|奖助|资助|助学贷款|评优|评奖|困难生/,
  library: /图书馆|借书|还书|续借|开馆|闭馆|馆藏|座位|数据库|文献/,
  notices: /通知|公告|公示|讲座|活动|新闻|最新|教务处动态/,
  shuttle: /班车|校车|发车|乘车|车次|东区.*西区|西区.*东区|高新区/,
  calendar: /校历|开学|放假|寒假|暑假|考试周|学期|注册时间|报到时间/,
  courses:
    /课程|选课|课表|学分|课程号|课堂号|课程代码|上课|教师|老师|\b(?:[A-Z]{2,}\d{3,}(?:\.\d+)?|\d{2,}[A-Z]\d{2,})\b/i,
  policies: /政策|规定|办法|制度|流程|申请|办理|手续|材料|指南|细则/,
  info: /地址|电话|联系方式|联系人|办公地点|办公室|部门|机构|校区|食堂|餐厅|宿舍|校园卡|一卡通/,
};

const PRIMARY_DATASET_ROUTES: DatasetRoute[] = [
  "scholarships",
  "library",
  "shuttle",
  "calendar",
  "courses",
];

const DATASET_ROUTE_LABELS: Record<DatasetRoute, string> = {
  scholarships: "奖助学金",
  library: "图书馆",
  notices: "通知公告",
  shuttle: "班车",
  calendar: "校历",
  courses: "课程",
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
  const matchedRoutes = (Object.keys(DATASET_ROUTE_KEYWORDS) as DatasetRoute[])
    .filter((route) => DATASET_ROUTE_KEYWORDS[route].test(query));

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
  return { datasetId, content, score };
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

/** 使用项目历史评测验证过的 semantic + reranker + top_k=5 默认参数。 */
export function buildRetrievalModel(
  env: NodeJS.ProcessEnv = process.env,
  query = "",
): Record<string, unknown> {
  const isExactCourseQuery = EXACT_COURSE_QUERY_PATTERN.test(query);
  const rerankingEnabled = env.DIFY_RERANKING_ENABLED?.trim().toLowerCase() !== "false";
  const threshold = Number(env.DIFY_RETRIEVAL_SCORE_THRESHOLD);
  const thresholdEnabled =
    Boolean(env.DIFY_RETRIEVAL_SCORE_THRESHOLD?.trim()) && Number.isFinite(threshold);
  const model: Record<string, unknown> = {
    search_method:
      env.DIFY_RETRIEVAL_SEARCH_METHOD?.trim() ||
      (isExactCourseQuery
        ? "hybrid_search"
        : "semantic_search"),
    reranking_enable: rerankingEnabled,
    top_k: Math.min(
      20,
      Math.floor(
        numberFromEnv(env.DIFY_RETRIEVAL_TOP_K, isExactCourseQuery ? 10 : 5),
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
  const body: Record<string, unknown> = {
    query,
    retrieval_model: buildRetrievalModel(process.env, query),
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
