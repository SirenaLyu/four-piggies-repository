/**
 * 文本转向量脚本 —— 将文字转为向量，结果可直接粘贴到 Supabase Table Editor
 *
 * ── 使用方法 ──
 *   npx tsx 脚本/embed-text.ts "你好，中国科学技术大学"
 *   echo "你好，中国科学技术大学" | npx tsx 脚本/embed-text.ts
 *
 * ── 在 Supabase 中使用 ──
 *   1. 运行脚本，复制终端输出的数组（形如 [0.013,0.014,...]）
 *   2. 打开 Supabase → Table Editor → 目标表
 *   3. 在 vector 列粘贴该数组即可
 *
 * ── 环境变量（自动从 .env.local 读取）──
 *   EMBEDDING_BASE_URL  - API 地址（默认复用 OPENAI_BASE_URL）
 *   EMBEDDING_API_KEY   - API 密钥（默认复用 OPENAI_API_KEY）
 *   EMBEDDING_MODEL     - 模型名（默认 BAAI/bge-large-zh-v1.5，中文语义效果最佳）
 *
 * ── 当前配置 ──
 *   使用 SiliconFlow（硅基流动）API，模型 BAAI/bge-large-zh-v1.5，输出 1024 维向量
 */

import * as fs from "fs";
import * as path from "path";

// ===== 加载 .env.local =====
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
    // 去除首尾引号
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

// Embedding 专用配置（未设置则回退到通用 OPENAI_* 变量）
const BASE_URL = (
  process.env.EMBEDDING_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  "https://api.openai.com/v1"
).replace(/\/+$/, "");
const API_KEY = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || "";
const MODEL = process.env.EMBEDDING_MODEL || "BAAI/bge-large-zh-v1.5";

// ===== 读取标准输入 =====
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.resume();
  });
}

// ===== 主逻辑 =====
async function main(): Promise<void> {
  // 1. 获取输入文本
  let text = process.argv.slice(2).join(" ").trim();
  if (!text) {
    text = await readStdin();
  }

  if (!text) {
    console.error("❌ 请提供要转换的文本");
    console.error("");
    console.error("用法：");
    console.error('  npx tsx 脚本/embed-text.ts "你的文本内容"');
    console.error('  echo "你的文本内容" | npx tsx 脚本/embed-text.ts');
    process.exit(1);
  }

  // 2. 调用 Embedding API
  console.error(`🔧 模型: ${MODEL}`);
  console.error(`📝 文本: ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`);
  console.error("⏳ 正在生成向量...\n");

  const resp = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, input: text }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    console.error(`❌ API 错误 (${resp.status}): ${errBody}`);
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json();
  const vec: number[] = json.data?.[0]?.embedding;

  if (!vec || vec.length === 0) {
    console.error("❌ 返回数据中没有 embedding 向量");
    process.exit(1);
  }

  // 3. 输出 pgvector 兼容数组（保留 8 位小数，末尾去零以精简）
  const vecStr = `[${vec.map((v) => Number(v.toFixed(8))).join(",")}]`;
  console.log(vecStr);

  console.error(`\n✅ 成功！向量维度: ${vec.length}`);
  console.error("📋 上方数组可直接粘贴到 Supabase Table Editor 的 vector 列");
}

main().catch((e: unknown) => {
  console.error("❌ 运行出错:", e);
  process.exit(1);
});
