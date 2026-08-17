import * as fs from "fs";
import * as path from "path";
const envText = fs.readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const k = trimmed.slice(0, eq).trim();
  let v = trimmed.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[k] = v;
}
const { embed } = await import("ai");
const { createOpenAI } = await import("@ai-sdk/openai");
const { classifyWithEmbedding } = await import("../app/lib/classifier.ts");
const emb = createOpenAI({ baseURL: process.env.EMBEDDING_BASE_URL, apiKey: process.env.EMBEDDING_API_KEY });
const queries = [
  "暑期公共教室开放吗",
  "本科生选课什么时候开始",
  "毕业论文选题怎么报",
  "助教岗位怎么申请",
  "图书馆在东校区吗",
  "正阳楼餐厅几点开饭",
];
for (const q of queries) {
  const { embedding } = await embed({ model: emb.embedding("BAAI/bge-m3"), value: q });
  const { primary, secondary, scores } = await classifyWithEmbedding(embedding, q);
  const top3 = Object.entries(scores).sort(([, a], [, b]) => b - a).slice(0, 3).map(([c, s]) => `${c}=${s.toFixed(3)}`).join("  ");
  console.log(`"${q}" → ${primary}${secondary ? "+" + secondary : ""}  top3: ${top3}`);
}
