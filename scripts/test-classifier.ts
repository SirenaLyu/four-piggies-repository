/**
 * 分类器探针测试 —— 验证 8 个典型 query 的 routing 是否正确
 *
 * 用法: npx tsx scripts/test-classifier.ts
 *
 * 不需要 Supabase,只测 classifier.ts 的 embedding + 余弦 + 阈值逻辑。
 */

import * as fs from "fs";
import * as path from "path";
import type { Category } from "../app/lib/classifier";

// 必须在 import classifier 之前加载 .env.local,
// 否则 classifier.ts 顶层 import ai-clients 时 process.env 还没就绪
function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnvFile(path.resolve(process.cwd(), ".env.local"));

// 延迟 require,确保 env 已就绪(tsx 用 CJS 输出,不支持顶层 await)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { embed } = require("ai");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createOpenAI } = require("@ai-sdk/openai");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { classifyWithEmbedding } = require("../app/lib/classifier");

const PROBES: Array<{ query: string; expected: Category; label: string }> = [
  { query: "2026 秋季什么时候开学", expected: "calendar", label: "校历" },
  { query: "去高新区的班车几点发车", expected: "shuttle", label: "班车" },
  { query: "最近的教务处通知讲什么", expected: "notices", label: "通知" },
  { query: "东区图书馆周六开门吗,几点关门", expected: "library", label: "图书馆" },
  { query: "雪迪龙奖学金的联系人是谁,邮箱多少", expected: "scholarships", label: "奖学金" },
  { query: "三食堂在哪个校区,电话多少", expected: "poi", label: "校园地点" },
  { query: "量子力学这门课的代码和学分", expected: "courses", label: "课程" },
  { query: "合肥明天天气怎么样", expected: "fallback", label: "fallback(无关问题)" },
];

async function main() {
  console.log("分类器探针测试\n");
  const embeddingClient = createOpenAI({
    baseURL: process.env.EMBEDDING_BASE_URL!,
    apiKey: process.env.EMBEDDING_API_KEY!,
  });
  const EMBEDDING_MODEL = "BAAI/bge-m3";

  let pass = 0;
  let fail = 0;
  for (const { query, expected, label } of PROBES) {
    const { embedding } = await embed({
      model: embeddingClient.embedding(EMBEDDING_MODEL),
      value: query,
    });
    const { primary, secondary, scores } = await classifyWithEmbedding(embedding);
    const topScores = Object.entries(scores)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([c, s]) => `${c}=${s.toFixed(3)}`)
      .join("  ");
    const ok = primary === expected;
    console.log(
      `[${ok ? "✓" : "✗"}] ${label}: "${query}"\n    → primary=${primary} (期望 ${expected})` +
        (secondary ? ` secondary=${secondary}` : "") +
        `\n    top3: ${topScores}`,
    );
    if (ok) pass++;
    else fail++;
  }
  console.log(`\n结果: ${pass}/${PROBES.length} 通过, ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("出错:", e);
  process.exit(1);
});
