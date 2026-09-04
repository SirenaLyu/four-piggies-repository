import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  buildRetrievalModel,
  getDifyKnowledgeConfig,
  routeDatasetIds,
} from "../app/lib/dify-knowledge.ts";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());

const live = process.argv.includes("--live");
const casesPath = path.resolve("evals/retrieval-cases.json");
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const routeNames = [
  "scholarships",
  "library",
  "notices",
  "shuttle",
  "calendar",
  "courses",
  "policies",
  "info",
];
const syntheticRouteMap = Object.fromEntries(
  routeNames.map((route) => [route, [`eval-${route}`]]),
);
const syntheticDatasetIds = Object.values(syntheticRouteMap).flat();

const routingResults = cases.map((item) => {
  const actual = routeDatasetIds(
    item.query,
    syntheticDatasetIds,
    JSON.stringify(syntheticRouteMap),
  ).map((id) => id.replace(/^eval-/, ""));
  const expected = [...item.expectedRoutes].sort();
  const actualSorted = [...actual].sort();
  return {
    id: item.id,
    passed: JSON.stringify(actualSorted) === JSON.stringify(expected),
    expected,
    actual: actualSorted,
  };
});

const routingFailed = routingResults.filter((result) => !result.passed);
console.log(
  JSON.stringify({
    suite: "routing",
    passed: routingResults.length - routingFailed.length,
    total: routingResults.length,
    failures: routingFailed,
  }),
);

if (!live) {
  if (routingFailed.length > 0) process.exitCode = 1;
  process.exit();
}

const { baseUrl, apiKey, datasetIds } = getDifyKnowledgeConfig();
if (!baseUrl || !apiKey || datasetIds.length === 0) {
  throw new Error("实时评测需要 DIFY_BASE_URL、DIFY_KNOWLEDGE_API_KEY 和 DATASET_IDS");
}

const liveCases = cases.filter(
  (item) => Array.isArray(item.liveExpectedAll) && item.liveExpectedAll.length > 0,
);
const liveResults = [];
for (const item of liveCases) {
  const routedIds = routeDatasetIds(item.query, datasetIds);
  const startedAt = Date.now();
  const records = [];
  for (const datasetId of routedIds) {
    const response = await fetch(`${baseUrl}/v1/datasets/${datasetId}/retrieve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: item.query,
        retrieval_model: buildRetrievalModel(process.env, item.query),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`${item.id} 的 Dify 检索失败：HTTP ${response.status}`);
    }
    const body = await response.json();
    records.push(...(body.records ?? body.data?.records ?? []));
  }
  const contents = records.map((record) => record.segment?.content ?? record.content ?? "");
  const matchedRank = contents.findIndex((content) =>
    item.liveExpectedAll.every((expected) => content.includes(expected)),
  );
  liveResults.push({
    id: item.id,
    passed: matchedRank >= 0,
    hitRank: matchedRank >= 0 ? matchedRank + 1 : null,
    records: records.length,
    latencyMs: Date.now() - startedAt,
  });
}

const liveFailed = liveResults.filter((result) => !result.passed);
console.log(
  JSON.stringify({
    suite: "live-retrieval",
    passed: liveResults.length - liveFailed.length,
    total: liveResults.length,
    results: liveResults,
  }),
);
if (routingFailed.length > 0 || liveFailed.length > 0) process.exitCode = 1;
