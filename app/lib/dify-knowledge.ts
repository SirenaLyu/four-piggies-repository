// ============================================================================
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
//   DIFY_RETRIEVAL_TOP_K       （可选）覆盖 Dify 默认的 top_k
//   DIFY_RETRIEVAL_SCORE_THRESHOLD （可选）覆盖 Dify 默认的 score_threshold
// ============================================================================

/** 单次检索请求的超时时间（毫秒） */
const REQUEST_TIMEOUT_MS = 15_000;

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

/**
 * 从 Dify 返回的一条 record 中提取 content 与 score
 * Dify 新版结构为 record.segment.content / record.segment.score，
 * 旧版可能直接放在 record 上，这里做兼容处理
 */
function extractRecord(
  record: unknown,
  datasetId: string,
): KnowledgeChunk | null {
  if (!record || typeof record !== "object") return null;
  const raw = record as Record<string, unknown>;
  const segment = (raw.segment ?? raw) as Record<string, unknown>;

  const content =
    typeof segment.content === "string" ? segment.content.trim() : "";
  if (!content) return null;

  const score = typeof segment.score === "number" ? segment.score : 0;
  return { datasetId, content, score };
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
): Promise<KnowledgeChunk[]> {
  // 可选：通过环境变量覆盖 Dify 后台配置的检索参数
  const retrievalModel: Record<string, unknown> = {};
  const topK = process.env.DIFY_RETRIEVAL_TOP_K;
  const scoreThreshold = process.env.DIFY_RETRIEVAL_SCORE_THRESHOLD;
  if (topK && !Number.isNaN(Number(topK))) retrievalModel.top_k = Number(topK);
  if (scoreThreshold && !Number.isNaN(Number(scoreThreshold))) {
    retrievalModel.score_threshold = Number(scoreThreshold);
  }

  const body: Record<string, unknown> = { query };
  if (Object.keys(retrievalModel).length > 0) {
    body.retrieval_model = retrievalModel;
  }

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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `HTTP ${response.status}${errorText ? `：${errorText.slice(0, 200)}` : ""}（耗时 ${Date.now() - startedAt}ms）`,
    );
  }

  const data = (await response.json()) as { records?: unknown[] };
  const records = Array.isArray(data?.records) ? data.records : [];

  console.log(
    `[dify-knowledge] 知识库 ${datasetId} 请求耗时 ${Date.now() - startedAt}ms，返回 ${records.length} 条 record`,
  );

  return records
    .map((record) => extractRecord(record, datasetId))
    .filter((chunk): chunk is KnowledgeChunk => chunk !== null);
}

/**
 * 检索所有已配置的 Dify 知识库，并组装上下文
 * - 使用 Promise.allSettled 并发请求，单个知识库失败不影响整体
 * - 按 content 精确去重，按相似度分数降序排序
 * - 任何异常都在内部消化，绝不向调用方抛出（保证 Agent 主进程不崩溃）
 */
export async function retrieveKnowledgeContext(
  query: string,
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

  // 并发请求所有知识库
  const retrieveStartedAt = Date.now();
  const settled = await Promise.allSettled(
    datasetIds.map((datasetId) =>
      retrieveFromDataset(baseUrl, apiKey, datasetId, query),
    ),
  );
  console.log(
    `[dify-knowledge] ${datasetIds.length} 个知识库并发检索总耗时 ${Date.now() - retrieveStartedAt}ms`,
  );

  const chunks: KnowledgeChunk[] = [];
  const failedDatasets: string[] = [];

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      chunks.push(...result.value);
    } else {
      failedDatasets.push(datasetIds[index]);
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(
        `[dify-knowledge] 知识库 ${datasetIds[index]} 检索失败：${reason}`,
      );
    }
  });

  // 全部知识库都失败：返回友好提示，不抛异常
  if (chunks.length === 0) {
    const reason =
      failedDatasets.length > 0 ? `（${failedDatasets.length} 个知识库请求失败，请检查 Dify 服务状态与 API Key）` : "";
    return {
      ok: false,
      context: "",
      chunkCount: 0,
      error: `所有知识库均未返回内容${reason}`,
    };
  }

  // 按 content 去重，再按相似度分数从高到低排序
  const seen = new Set<string>();
  const uniqueChunks = chunks
    .filter((chunk) => {
      if (seen.has(chunk.content)) return false;
      seen.add(chunk.content);
      return true;
    })
    .sort((a, b) => b.score - a.score);

  // 拼接为送入大模型的上下文：带序号与相似度标注，便于模型筛选引用
  const context = uniqueChunks
    .map(
      (chunk, index) =>
        `【片段 ${index + 1}｜相似度 ${chunk.score.toFixed(3)}】\n${chunk.content}`,
    )
    .join("\n\n---\n\n");

  const error =
    failedDatasets.length > 0
      ? `警告：知识库 ${failedDatasets.join("、")} 检索失败，以下结果来自其余知识库`
      : undefined;

  return { ok: true, context, chunkCount: uniqueChunks.length, error };
}
