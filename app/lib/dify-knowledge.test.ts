import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCourseFollowupQueries,
  buildRetrievalModel,
  buildKnowledgeCacheKey,
  extractRecord,
  extractRecordsFromResponse,
  extractFacultyNameQuery,
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

test("包含精确课程号的查询使用混合检索", () => {
  const model = buildRetrievalModel(
    {} as NodeJS.ProcessEnv,
    "查询 2026 春季 MATH3007.02 的课程信息",
  );
  assert.equal(model.search_method, "hybrid_search");
  assert.equal(model.reranking_enable, true);
  assert.equal(model.top_k, 10);
  assert.equal(
    buildRetrievalModel({} as NodeJS.ProcessEnv, "查询 001362.01 的课程信息")
      .search_method,
    "hybrid_search",
  );
});

test("教师姓名与成果查询使用混合检索并扩大候选", () => {
  const model = buildRetrievalModel(
    {} as NodeJS.ProcessEnv,
    "俞书宏教授的获奖和论文成果",
  );
  assert.equal(model.search_method, "hybrid_search");
  assert.equal(model.top_k, 10);
});

test("教师精确问法提取姓名，泛化找人问题保留原查询", () => {
  assert.equal(
    extractFacultyNameQuery("网络空间安全学院冯福利老师的职称和研究方向"),
    "冯福利",
  );
  assert.equal(extractFacultyNameQuery("潘建伟的论文成果"), "潘建伟");
  assert.equal(extractFacultyNameQuery("有哪些研究量子通信的老师"), undefined);
});

test("教师课程复合问法从评课卡片生成课程代码第二跳查询", () => {
  const chunks: KnowledgeChunk[] = [
    {
      datasetId: "courses",
      score: 0.9,
      content:
        "评课社区课程：概率论 — 刘党政\n授课教师：刘党政\n评课社区课程代码：MATH300702\n评课社区评分：9.4/10",
    },
    {
      datasetId: "courses",
      score: 0.8,
      content:
        "评课社区课程：概率论进阶 — 刘党政\n授课教师：刘党政\n评课社区课程代码：MATH301301",
    },
  ];
  assert.deepEqual(
    buildCourseFollowupQueries("刘党政老师教什么课，课程有多少学分？", chunks),
    ["MATH3007 刘党政 学分", "MATH3013 刘党政 学分"],
  );
  assert.deepEqual(buildCourseFollowupQueries("刘党政老师教什么课？", chunks), []);
});

test("已经召回教师对应结构化课程时不做第二跳", () => {
  const chunks: KnowledgeChunk[] = [
    {
      datasetId: "courses",
      score: 0.9,
      content: "课堂号：MATH3007.02\n授课教师：刘党政\n学分：3",
    },
  ];
  assert.deepEqual(
    buildCourseFollowupQueries("刘党政老师教什么课，课程有多少学分？", chunks),
    [],
  );
});

test("环境变量可以显式覆盖按查询选择的检索方式", () => {
  const model = buildRetrievalModel(
    {
      NODE_ENV: "test",
      DIFY_RETRIEVAL_SEARCH_METHOD: "semantic_search",
    } as NodeJS.ProcessEnv,
    "课堂号 MATH3007.02",
  );
  assert.equal(model.search_method, "semantic_search");
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

test("明确业务主题优先，不因申请和联系人扩散到通用库", () => {
  const routeMap = JSON.stringify({
    scholarships: ["scholarships"],
    policies: ["policies"],
    info: ["info"],
  });
  assert.deepEqual(
    routeDatasetIds(
      "雪迪龙奖学金的申请条件和联系人",
      ["scholarships", "policies", "info"],
      routeMap,
    ),
    ["scholarships"],
  );
});

test("课程号本身可以触发课程知识库路由", () => {
  const routeMap = JSON.stringify({
    courses: ["courses"],
    info: ["info"],
    policies: ["policies"],
    notices: ["notices"],
  });
  assert.deepEqual(
    routeDatasetIds(
      "MATH3007.02 刘党政的时间地点和评分",
      ["courses", "info", "policies", "notices"],
      routeMap,
    ),
    ["courses"],
  );
});

test("教师研究走教师库，单纯询问授课信息只走课程库", () => {
  const routeMap = JSON.stringify({
    faculty: ["faculty"],
    courses: ["courses"],
    info: ["faculty"],
    policies: ["policies"],
    notices: ["notices"],
  });
  assert.deepEqual(
    routeDatasetIds(
      "刘斌老师的研究方向和论文成果",
      ["faculty", "courses", "policies", "notices"],
      routeMap,
    ),
    ["faculty"],
  );
  assert.deepEqual(
    routeDatasetIds(
      "刘斌老师教什么课",
      ["faculty", "courses", "policies", "notices"],
      routeMap,
    ),
    ["courses"],
  );
  assert.deepEqual(
    routeDatasetIds(
      "刘斌老师教什么课，他的研究方向是什么",
      ["faculty", "courses", "policies", "notices"],
      routeMap,
    ),
    ["courses", "faculty"],
  );
  assert.deepEqual(
    routeDatasetIds(
      "量子力学由哪位教授授课，这位老师研究什么",
      ["faculty", "courses", "policies", "notices"],
      routeMap,
    ),
    ["courses", "faculty"],
  );
});

test("识别纯数字课堂号和校园自然表达", () => {
  const routeMap = JSON.stringify({
    courses: ["courses"],
    library: ["library"],
    info: ["info"],
    policies: ["policies"],
    notices: ["notices"],
  });
  const datasetIds = ["courses", "library", "info", "policies", "notices"];
  assert.deepEqual(routeDatasetIds("帮我查一下001362.01", datasetIds, routeMap), [
    "courses",
  ]);
  assert.deepEqual(routeDatasetIds("东区美食广场在哪里", datasetIds, routeMap), [
    "info",
  ]);
  assert.deepEqual(routeDatasetIds("本科生可以借多少本书", datasetIds, routeMap), [
    "library",
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
