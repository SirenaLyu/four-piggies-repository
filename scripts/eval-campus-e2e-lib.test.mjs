import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimMatchesText,
  evaluateEvidence,
  parseUiMessageSse,
  percentile,
  summarizeMeasuredCases,
  validateCorpus,
} from "./eval-campus-e2e-lib.mjs";

test("事实断言支持 all、any 和 none", () => {
  assert.equal(
    claimMatchesText("俞书宏是教授，研究纳米材料。", {
      all: ["俞书宏", "教授"],
      any: ["纳米材料", "量子通信"],
      none: ["副教授"],
    }),
    true,
  );
});

test("召回评测按独立事实计算 hit@k 与倒数排名", () => {
  const result = evaluateEvidence(
    ["无关", "潘建伟研究量子通信", "拥有多项量子专利"],
    [
      { id: "research", all: ["潘建伟", "量子通信"] },
      { id: "patent", all: ["量子", "专利"] },
    ],
    3,
  );
  assert.equal(result.passed, true);
  assert.equal(result.hitAtK, 1);
  assert.equal(result.reciprocalRank, (1 / 2 + 1 / 3) / 2);
});

test("失败断言报告缺失词而不保存原始答案", () => {
  const result = evaluateEvidence(
    ["数值分析由徐岩授课"],
    [{ all: ["数值分析", "徐岩", "9.6/10"] }],
    1,
  );
  assert.deepEqual(result.claimResults[0].diagnostics.missingAll, ["9.6/10"]);
  assert.equal("text" in result.claimResults[0], false);
});

test("延迟分位数使用 nearest-rank", () => {
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
  assert.equal(percentile([10, 20, 30, 40], 0.95), 40);
});

test("汇总输出准确率、MRR 和延迟", () => {
  assert.deepEqual(
    summarizeMeasuredCases([
      { passed: true, hitAtK: 1, reciprocalRank: 1, latencyMs: 100 },
      { passed: false, hitAtK: 0.5, reciprocalRank: 0.25, latencyMs: 300 },
    ]),
    {
      passed: 1,
      total: 2,
      accuracy: 0.5,
      meanHitAtK: 0.75,
      mrr: 0.625,
      p50LatencyMs: 100,
      p95LatencyMs: 300,
    },
  );
});

test("解析 AI SDK UI message SSE 文本与工具", () => {
  const parsed = parseUiMessageSse(
    'data: {"type":"text-delta","id":"a","delta":"你好"}\n\n' +
      'data: {"type":"tool-input-available","toolName":"web_search"}\n\n' +
      'data: {"type":"text-delta","id":"a","delta":"科大"}\n\n' +
      "data: [DONE]\n\n",
  );
  assert.equal(parsed.text, "你好科大");
  assert.deepEqual(parsed.tools, ["web_search"]);
});

test("语料校验拒绝规模不足的伪端到端评测", () => {
  assert.throws(() => validateCorpus({ cases: [] }), /至少需要 50 条/);
});
