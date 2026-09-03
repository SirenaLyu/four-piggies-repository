import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRetrievalModel,
  buildKnowledgeCacheKey,
  extractRecord,
  extractRecordsFromResponse,
  filterChunksByDatasetThreshold,
  parseDatasetScoreThresholds,
  routeDatasetIds,
  selectContextChunks,
  type KnowledgeChunk,
} from "./dify-knowledge.ts";

test("从 record 顶层读取 Dify reranker 分数", () => {
  const chunk = extractRecord(
    { score: 0.87, segment: { content: "正确片段", score: 0.11 } },
    "dataset-a",
  );
  assert.deepEqual(chunk, {
    datasetId: "dataset-a",
    content: "正确片段",
    score: 0.87,
  });
});

test("兼容 data.records 响应包裹", () => {
  const records = [{ score: 0.5, segment: { content: "片段" } }];
  assert.equal(extractRecordsFromResponse({ data: { records } }), records);
  assert.equal(extractRecordsFromResponse({ records }), records);
});

test("跨库选择先保留每个库的 top-1，而不是比较跨库分数", () => {
  const make = (datasetId: string, content: string, score: number): KnowledgeChunk => ({
    datasetId,
    content,
    score,
  });
  const selected = selectContextChunks(
    [
      [make("a", "a-1", 0.99), make("a", "a-2", 0.98)],
      [make("b", "b-1", 0.01), make("b", "b-2", 0.005)],
      [make("c", "c-1", 0.5)],
    ],
    4,
  );
  assert.deepEqual(
    selected.map((chunk) => chunk.content),
    ["a-1", "b-1", "c-1", "a-2"],
  );
});

test("跨库轮转时去除重复内容", () => {
  const selected = selectContextChunks(
    [
      [{ datasetId: "a", content: "相同内容", score: 0.9 }],
      [
        { datasetId: "b", content: "相同内容", score: 0.8 },
        { datasetId: "b", content: "另一内容", score: 0.7 },
      ],
    ],
    2,
  );
  assert.deepEqual(selected.map((chunk) => chunk.content), ["相同内容", "另一内容"]);
});

test("默认使用历史评测验证过的 semantic reranker 参数", () => {
  const model = buildRetrievalModel({} as NodeJS.ProcessEnv);
  assert.equal(model.search_method, "semantic_search");
  assert.equal(model.reranking_enable, true);
  assert.equal(model.top_k, 5);
  assert.equal(model.score_threshold_enabled, false);
});

test("奖学金查询只路由到奖助学金数据集", () => {
  const datasetIds = [
    "058eb792-77df-4c98-8f40-1feabf5c10dc",
    "748dd072-a42c-4cfc-8df4-b0dc9432be50",
    "781772a0-fee6-4077-ae61-c4eb16448c37",
  ];
  assert.deepEqual(routeDatasetIds("雪迪龙奖学金联系人是谁", datasetIds), [
    "058eb792-77df-4c98-8f40-1feabf5c10dc",
  ]);
});

test("未命中主题时只回退到信息、政策与通知库", () => {
  const datasetIds = [
    "975e7edb-4979-4cfe-95e2-9cc2f782488d",
    "1e3922a5-c7a6-4307-a852-62921e2a843b",
    "ef053c5b-7d01-40e7-a2b6-cbce54ac261f",
    "76ca3310-ba82-4cd4-90d8-c3ed6fc1f3a8",
  ];
  assert.deepEqual(routeDatasetIds("学校这件事怎么办", datasetIds), [
    "975e7edb-4979-4cfe-95e2-9cc2f782488d",
    "ef053c5b-7d01-40e7-a2b6-cbce54ac261f",
    "76ca3310-ba82-4cd4-90d8-c3ed6fc1f3a8",
  ]);
});

test("食堂和宿舍问题只路由到校园信息库", () => {
  const datasetIds = [
    "975e7edb-4979-4cfe-95e2-9cc2f782488d",
    "ef053c5b-7d01-40e7-a2b6-cbce54ac261f",
    "76ca3310-ba82-4cd4-90d8-c3ed6fc1f3a8",
  ];
  assert.deepEqual(routeDatasetIds("东区有哪些食堂", datasetIds), [
    "975e7edb-4979-4cfe-95e2-9cc2f782488d",
  ]);
  assert.deepEqual(routeDatasetIds("宿舍校园卡怎么补办", datasetIds), [
    "975e7edb-4979-4cfe-95e2-9cc2f782488d",
  ]);
});

test("支持按数据集设置独立最低分数", () => {
  const configured = JSON.stringify({ "dataset-a": 0.6, "dataset-b": 0.2 });
  assert.deepEqual(parseDatasetScoreThresholds(configured), {
    "dataset-a": 0.6,
    "dataset-b": 0.2,
  });
  const chunks: KnowledgeChunk[] = [
    { datasetId: "dataset-a", content: "低相关", score: 0.59 },
    { datasetId: "dataset-a", content: "高相关", score: 0.61 },
  ];
  assert.deepEqual(
    filterChunksByDatasetThreshold(chunks, "dataset-a", configured).map(
      (chunk) => chunk.content,
    ),
    ["高相关"],
  );
});

test("知识库缓存键隔离数据集和检索配置", () => {
  const config = { baseUrl: "https://dify.example", datasetIds: ["a"] };
  const first = buildKnowledgeCacheKey("同一问题", config, {
    NODE_ENV: "test",
    DIFY_RETRIEVAL_TOP_K: "5",
  } as NodeJS.ProcessEnv);
  const changedDataset = buildKnowledgeCacheKey(
    "同一问题",
    { ...config, datasetIds: ["b"] },
    { NODE_ENV: "test", DIFY_RETRIEVAL_TOP_K: "5" } as NodeJS.ProcessEnv,
  );
  const changedModel = buildKnowledgeCacheKey("同一问题", config, {
    NODE_ENV: "test",
    DIFY_RETRIEVAL_TOP_K: "8",
  } as NodeJS.ProcessEnv);
  assert.notEqual(first, changedDataset);
  assert.notEqual(first, changedModel);
});
