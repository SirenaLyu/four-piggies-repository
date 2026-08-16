/**
 * Dify 知识库检索客户端 —— 用于 Supabase pgvector 检索为空时的 fallback。
 *
 * 5 个主题库(8/16 建库 + 上传 CSV,见 docs/dify-retrieval-experiment.md):
 *   - 校历 ab7400a3-b5c5-4f80-8d75-84be0cc4bb63
 *   - 班车 781772a0-fee6-4077-ae61-c4eb16448c37
 *   - 教务通知 76ca3310-ba82-4cd4-90d8-c3ed6fc1f3a8
 *   - 图书馆 748dd072-a42c-4cfc-8df4-b0dc9432be50
 *   - 奖学金 058eb792-77df-4c98-8f40-1feabf5c10dc
 *
 * 推荐配置(8/16 实验得出):semantic_search + bge-reranker-v2-m3 + top_k=5 + 无阈值
 */

import type { Category } from "./classifier";

const DIFY_BASE = "http://114.214.241.106/v1";
const DIFY_API_KEY = process.env.DIFY_API_KEY ?? "dataset-tGSTzWOdMMWOLXnAMyEIT8ff";

const DATASET_IDS: Record<Exclude<Category, "fallback" | "courses" | "poi">, string> = {
  calendar: "ab7400a3-b5c5-4f80-8d75-84be0cc4bb63",
  shuttle: "781772a0-fee6-4077-ae61-c4eb16448c37",
  notices: "76ca3310-ba82-4cd4-90d8-c3ed6fc1f3a8",
  library: "748dd072-a42c-4cfc-8df4-b0dc9432be50",
  scholarships: "058eb792-77df-4c98-8f40-1feabf5c10dc",
};

export function difySupports(category: Category): category is keyof typeof DATASET_IDS {
  return category in DATASET_IDS;
}

interface DifyRecord {
  segment?: { content?: string };
  content?: string;
  score?: number;
}

interface DifyResponse {
  records?: DifyRecord[];
  data?: { records?: DifyRecord[] };
  message?: string;
}

/**
 * 调 Dify retrieve API,返回拼接好的上下文文本(每个 chunk 一段,空行分隔)。
 * 失败时返回空串,让上层走"暂无相关信息"路径。
 */
export async function searchDify(
  category: keyof typeof DATASET_IDS,
  query: string,
  topK = 5,
): Promise<string> {
  const datasetId = DATASET_IDS[category];
  const body = {
    query,
    retrieval_model: {
      search_method: "semantic_search",
      reranking_enable: true,
      reranking_mode: "reranking_model",
      reranking_model: {
        reranking_provider_name: "langgenius/siliconflow/siliconflow",
        reranking_model_name: "BAAI/bge-reranker-v2-m3",
      },
      top_k: topK,
      score_threshold_enabled: false,
    },
  };

  try {
    const res = await fetch(`${DIFY_BASE}/datasets/${datasetId}/retrieve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DIFY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[dify] HTTP ${res.status} for ${category}: ${await res.text()}`);
      return "";
    }
    const json = (await res.json()) as DifyResponse;
    if (json.message) {
      console.error(`[dify] API error for ${category}: ${json.message}`);
      return "";
    }
    const records = json.records ?? json.data?.records ?? [];
    return records
      .map((r) => r.segment?.content ?? r.content ?? "")
      .filter(Boolean)
      .join("\n\n---\n\n");
  } catch (err) {
    console.error(`[dify] fetch failed for ${category}:`, (err as Error).message);
    return "";
  }
}

/**
 * 并行查 Dify 5 个主题库,合并每个库的 top-2 结果(共最多 10 条)。
 * 用于 fallback 类目 —— 因为分类器没路由到具体类目,只能跨库撒网。
 * 失败库返回空,其他库照常返回。
 */
export async function searchDifyAll(query: string, topKPerDataset = 2): Promise<string> {
  const categories = Object.keys(DATASET_IDS) as Array<keyof typeof DATASET_IDS>;
  const results = await Promise.all(
    categories.map(async (c) => {
      const text = await searchDify(c, query, topKPerDataset);
      return text ? `【${c}】\n${text}` : "";
    }),
  );
  return results.filter(Boolean).join("\n\n===\n\n");
}
