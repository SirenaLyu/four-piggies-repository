import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import {
  ROUTE_NAMES,
  evaluateEvidence,
  parseUiMessageSse,
  qualityGateFailures,
  summarizeMeasuredCases,
  validateCorpus,
} from "./eval-campus-e2e-lib.mjs";
import {
  retrieveKnowledgeContext,
  routeDatasetIds,
} from "../app/lib/dify-knowledge.ts";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());

function valueArg(name) {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const runRetrieval = process.argv.includes("--retrieval") || process.argv.includes("--all");
const runAnswers = process.argv.includes("--answer") || process.argv.includes("--all");
const strict = process.argv.includes("--strict");
const includeAnswerText = process.argv.includes("--include-answer-text");
const categoryFilter = valueArg("--category");
const caseFilter = valueArg("--case");
const limit = Number(valueArg("--limit") ?? 0);
const corpusPath = path.resolve(valueArg("--corpus") ?? "evals/campus-e2e-cases.json");
const corpus = validateCorpus(JSON.parse(await fs.readFile(corpusPath, "utf8")));
let cases = corpus.cases.filter(
  (item) =>
    (!categoryFilter || item.category === categoryFilter) &&
    (!caseFilter || item.id === caseFilter),
);
if (Number.isInteger(limit) && limit > 0) cases = cases.slice(0, limit);
if (cases.length === 0) throw new Error("筛选后没有可运行的评测案例");

const syntheticRouteMap = Object.fromEntries(
  ROUTE_NAMES.map((route) => [route, [`eval-${route}`]]),
);
const syntheticDatasetIds = Object.values(syntheticRouteMap).flat();
const routingResults = cases.map((item) => {
  const actual = routeDatasetIds(
    item.query,
    syntheticDatasetIds,
    JSON.stringify(syntheticRouteMap),
  )
    .map((id) => id.replace(/^eval-/, ""))
    .sort();
  const expected = [...item.expectedRoutes].sort();
  return {
    id: item.id,
    category: item.category,
    passed: JSON.stringify(actual) === JSON.stringify(expected),
    expected,
    actual,
  };
});

function groupedAccuracy(results) {
  const grouped = new Map();
  for (const result of results) {
    const current = grouped.get(result.category) ?? { passed: 0, total: 0 };
    current.total += 1;
    if (result.passed) current.passed += 1;
    grouped.set(result.category, current);
  }
  return Object.fromEntries(
    [...grouped.entries()].map(([category, value]) => [
      category,
      { ...value, accuracy: value.passed / value.total },
    ]),
  );
}

const routePassed = routingResults.filter((result) => result.passed).length;
const report = {
  generatedAt: new Date().toISOString(),
  corpus: path.relative(process.cwd(), corpusPath),
  corpusVersion: corpus.version,
  selectedCases: cases.length,
  routing: {
    passed: routePassed,
    total: routingResults.length,
    accuracy: routePassed / routingResults.length,
    byCategory: groupedAccuracy(routingResults),
    failures: routingResults.filter((result) => !result.passed),
  },
};

function contextRecords(context) {
  return String(context ?? "")
    .split(/\n\n---\n\n/g)
    .map((chunk) => chunk.replace(/^【片段[^】]*】\n/, "").trim())
    .filter(Boolean);
}

if (runRetrieval) {
  const retrievalCases = cases.filter((item) => item.retrieval);
  if (retrievalCases.length === 0) throw new Error("筛选后没有带召回事实断言的案例");
  const results = [];
  for (const item of retrievalCases) {
    const startedAt = Date.now();
    const response = await retrieveKnowledgeContext(
      item.query,
      AbortSignal.timeout(Number(process.env.E2E_RETRIEVAL_TIMEOUT_MS ?? 30_000)),
    );
    const records = response.ok ? contextRecords(response.context) : [];
    const evidence = evaluateEvidence(
      records,
      item.retrieval.claims,
      item.retrieval.topK ?? 5,
    );
    results.push({
      id: item.id,
      category: item.category,
      ...evidence,
      records: records.length,
      latencyMs: Date.now() - startedAt,
      error: response.error,
    });
  }
  report.retrieval = {
    ...summarizeMeasuredCases(results),
    byCategory: groupedAccuracy(results),
    results,
  };
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`端到端评测账号登录失败：HTTP ${response.status} ${await response.text()}`);
  }
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("端到端评测登录响应没有会话 Cookie");
  return cookie;
}

async function runAnswerCase(baseUrl, cookie, item) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      cookie,
      "x-request-id": `e2e-${item.id}`.slice(0, 128),
    },
    body: JSON.stringify({
      id: `e2e-${item.id}-${Date.now()}`,
      messages: [
        {
          id: `question-${item.id}`,
          role: "user",
          parts: [{ type: "text", text: item.query }],
        },
      ],
      capabilities: item.capabilities ?? {
        knowledgeBase: true,
        webSearch: false,
        agent: false,
      },
      userProfile: {},
    }),
    signal: AbortSignal.timeout(Number(process.env.E2E_ANSWER_TIMEOUT_MS ?? 120_000)),
  });
  const payload = await response.text();
  const parsed = parseUiMessageSse(payload);
  const evidence = evaluateEvidence(
    [parsed.text],
    item.answer.claims,
    1,
  );
  return {
    id: item.id,
    category: item.category,
    ...evidence,
    status: response.status,
    answerChars: parsed.text.length,
    ...(includeAnswerText ? { answerText: parsed.text } : {}),
    sourceDisclosed: /知识库|官网|官方|来源|网页|联网/.test(parsed.text),
    tools: parsed.tools,
    latencyMs: Date.now() - startedAt,
    error: response.ok && parsed.text ? undefined : payload.slice(0, 300),
  };
}

if (runAnswers) {
  const baseUrl = (process.env.E2E_BASE_URL ?? valueArg("--base-url") ?? "")
    .replace(/\/+$/, "");
  const username = process.env.E2E_USERNAME;
  const password = process.env.E2E_PASSWORD;
  if (!baseUrl || !username || !password) {
    throw new Error(
      "最终回答评测需要 E2E_BASE_URL、E2E_USERNAME、E2E_PASSWORD，并要求目标应用已运行",
    );
  }
  const answerCases = cases.filter((item) => item.answer);
  if (answerCases.length === 0) throw new Error("筛选后没有带最终回答断言的案例");
  const cookie = await login(baseUrl, username, password);
  const results = [];
  for (const item of answerCases) results.push(await runAnswerCase(baseUrl, cookie, item));
  const summary = summarizeMeasuredCases(results);
  report.answer = {
    ...summary,
    sourceDisclosureRate:
      results.filter((result) => result.sourceDisclosed).length / results.length,
    byCategory: groupedAccuracy(results),
    results,
  };
}

const gateFailures = [];
if (report.routing.accuracy < (corpus.qualityGates?.routingAccuracy ?? 1)) {
  gateFailures.push(
    `routingAccuracy=${report.routing.accuracy} 未达到 ${corpus.qualityGates?.routingAccuracy ?? 1}`,
  );
}
if (report.retrieval) {
  gateFailures.push(
    ...qualityGateFailures(report.retrieval, corpus.qualityGates ?? {}, "retrieval"),
  );
}
if (report.answer) {
  gateFailures.push(
    ...qualityGateFailures(report.answer, corpus.qualityGates ?? {}, "answer"),
  );
  const sourceGate = corpus.qualityGates?.answerSourceDisclosureRate;
  if (sourceGate !== undefined && report.answer.sourceDisclosureRate < sourceGate) {
    gateFailures.push(
      `answerSourceDisclosureRate=${report.answer.sourceDisclosureRate} 未达到 ${sourceGate}`,
    );
  }
}
report.qualityGate = { passed: gateFailures.length === 0, failures: gateFailures };

const outputPath = valueArg("--out");
if (outputPath) {
  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(report, null, 2));

if (routingResults.some((result) => !result.passed) || (strict && gateFailures.length > 0)) {
  process.exitCode = 1;
}
