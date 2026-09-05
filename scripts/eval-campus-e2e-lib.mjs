export const ROUTE_NAMES = [
  "scholarships",
  "library",
  "notices",
  "shuttle",
  "calendar",
  "courses",
  "faculty",
  "policies",
  "info",
];

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/g, " ")
    .trim();
}

export function claimMatchesText(text, claim) {
  const normalized = normalizedText(text);
  const all = claim.all ?? [];
  const any = claim.any ?? [];
  const none = claim.none ?? [];
  return (
    all.every((term) => normalized.includes(normalizedText(term))) &&
    (any.length === 0 || any.some((term) => normalized.includes(normalizedText(term)))) &&
    none.every((term) => !normalized.includes(normalizedText(term)))
  );
}

export function evaluateEvidence(records, claims, topK = 5) {
  const candidates = records.slice(0, topK);
  const claimResults = claims.map((claim, index) => {
    const hitIndex = candidates.findIndex((record) => claimMatchesText(record, claim));
    const combined = normalizedText(candidates.join("\n"));
    const missingAll = (claim.all ?? []).filter(
      (term) => !combined.includes(normalizedText(term)),
    );
    const matchedAny = (claim.any ?? []).filter((term) =>
      combined.includes(normalizedText(term)),
    );
    const forbiddenHits = (claim.none ?? []).filter((term) =>
      combined.includes(normalizedText(term)),
    );
    return {
      claim: claim.id ?? `claim-${index + 1}`,
      passed: hitIndex >= 0,
      hitRank: hitIndex >= 0 ? hitIndex + 1 : null,
      ...(hitIndex < 0
        ? {
            diagnostics: {
              missingAll,
              missingAny:
                (claim.any ?? []).length > 0 && matchedAny.length === 0
                  ? claim.any
                  : [],
              forbiddenHits,
              termsSplitAcrossRecords:
                missingAll.length === 0 &&
                ((claim.any ?? []).length === 0 || matchedAny.length > 0) &&
                forbiddenHits.length === 0,
            },
          }
        : {}),
    };
  });
  const ranks = claimResults
    .map((result) => result.hitRank)
    .filter((rank) => rank !== null);
  return {
    passed: claimResults.every((result) => result.passed),
    claimResults,
    hitAtK:
      claimResults.length === 0
        ? 0
        : claimResults.filter((result) => result.passed).length / claimResults.length,
    reciprocalRank:
      ranks.length === 0
        ? 0
        : ranks.reduce((sum, rank) => sum + 1 / rank, 0) / claimResults.length,
  };
}

export function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1),
  );
  return sorted[index];
}

export function summarizeMeasuredCases(results) {
  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const latencies = results
    .map((result) => result.latencyMs)
    .filter((value) => Number.isFinite(value));
  return {
    passed,
    total,
    accuracy: total === 0 ? 0 : passed / total,
    meanHitAtK:
      total === 0
        ? 0
        : results.reduce((sum, result) => sum + (result.hitAtK ?? 0), 0) / total,
    mrr:
      total === 0
        ? 0
        : results.reduce((sum, result) => sum + (result.reciprocalRank ?? 0), 0) /
          total,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
  };
}

export function parseUiMessageSse(payload) {
  const chunks = [];
  for (const event of String(payload).split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      chunks.push(JSON.parse(data));
    } catch {
      // The HTTP status and missing answer text will make a malformed stream fail.
    }
  }
  return {
    chunks,
    text: chunks
      .filter((chunk) => chunk?.type === "text-delta" && typeof chunk.delta === "string")
      .map((chunk) => chunk.delta)
      .join(""),
    tools: Array.from(
      new Set(
        chunks.flatMap((chunk) => {
          if (typeof chunk?.toolName === "string") return [chunk.toolName];
          return [];
        }),
      ),
    ),
  };
}

function assertStringArray(value, label, { allowEmpty = false } = {}) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`${label} 必须是${allowEmpty ? "" : "非空"}字符串数组`);
  }
}

function validateClaims(claims, label) {
  if (!Array.isArray(claims) || claims.length === 0) {
    throw new Error(`${label} 必须至少包含一条事实断言`);
  }
  for (const [index, claim] of claims.entries()) {
    if (!claim || typeof claim !== "object") {
      throw new Error(`${label}[${index}] 必须是对象`);
    }
    const fields = [claim.all, claim.any, claim.none].filter(Boolean);
    if (fields.length === 0) {
      throw new Error(`${label}[${index}] 至少需要 all、any 或 none`);
    }
    for (const [field, value] of Object.entries(claim)) {
      if (["all", "any", "none"].includes(field)) {
        assertStringArray(value, `${label}[${index}].${field}`, { allowEmpty: true });
      }
    }
  }
}

export function validateCorpus(corpus) {
  if (!corpus || typeof corpus !== "object" || !Array.isArray(corpus.cases)) {
    throw new Error("评测文件必须包含 cases 数组");
  }
  if (corpus.cases.length < 50) {
    throw new Error(`端到端评测至少需要 50 条案例，当前只有 ${corpus.cases.length} 条`);
  }
  const ids = new Set();
  for (const [index, item] of corpus.cases.entries()) {
    const label = `cases[${index}]`;
    if (typeof item.id !== "string" || !item.id.trim()) throw new Error(`${label}.id 无效`);
    if (ids.has(item.id)) throw new Error(`案例 ID 重复：${item.id}`);
    ids.add(item.id);
    if (typeof item.query !== "string" || item.query.trim().length < 2) {
      throw new Error(`${label}.query 无效`);
    }
    if (typeof item.category !== "string" || !item.category.trim()) {
      throw new Error(`${label}.category 无效`);
    }
    assertStringArray(item.expectedRoutes, `${label}.expectedRoutes`);
    for (const route of item.expectedRoutes) {
      if (!ROUTE_NAMES.includes(route)) throw new Error(`${label} 包含未知路由：${route}`);
    }
    if (item.retrieval) {
      validateClaims(item.retrieval.claims, `${label}.retrieval.claims`);
      if (
        item.retrieval.topK !== undefined &&
        (!Number.isInteger(item.retrieval.topK) || item.retrieval.topK < 1 || item.retrieval.topK > 24)
      ) {
        throw new Error(`${label}.retrieval.topK 必须在 1-24 之间`);
      }
      if (typeof item.retrieval.source !== "string" || !item.retrieval.source.trim()) {
        throw new Error(`${label}.retrieval.source 必须记录事实来源`);
      }
    }
    if (item.answer) validateClaims(item.answer.claims, `${label}.answer.claims`);
  }
  return corpus;
}

export function qualityGateFailures(summary, gates, prefix) {
  const failures = [];
  const checks = [
    ["accuracy", `${prefix}Accuracy`, ">="],
    ["meanHitAtK", `${prefix}MeanHitAtK`, ">="],
    ["mrr", `${prefix}Mrr`, ">="],
    ["p95LatencyMs", `${prefix}P95LatencyMs`, "<="],
  ];
  for (const [metric, gateName, comparison] of checks) {
    if (!(gateName in gates) || summary[metric] === null || summary[metric] === undefined) continue;
    const passed = comparison === ">="
      ? summary[metric] >= gates[gateName]
      : summary[metric] <= gates[gateName];
    if (!passed) failures.push(`${metric}=${summary[metric]} 未达到 ${gateName}=${gates[gateName]}`);
  }
  return failures;
}
