/**
 * 学校资料录入脚本 —— 将文本转为向量并存入 Supabase campus_documents 表
 *
 * 用法:
 *   npx tsx scripts/feed_data.ts
 *
 * 依赖:
 *   - @ai-sdk/openai   → 对接硅基流动兼容 OpenAI 的 embedding API
 *   - ai              → Vercel AI SDK 的 embed 方法
 *   - @supabase/supabase-js → 存入 campus_documents 表
 *
 * 环境变量（自动从 .env.local 读取）:
 *   EMBEDDING_BASE_URL  - 硅基流动 API 地址
 *   EMBEDDING_API_KEY   - 硅基流动 API 密钥
 *   SUPABASE_URL        - Supabase 项目地址
 *   SUPABASE_ANON_KEY   - Supabase 匿名密钥
 */

import { createOpenAI } from "@ai-sdk/openai";
import { embed } from "ai";
import { createClient } from "@supabase/supabase-js";
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

// ===== 初始化硅基流动 embedding 客户端 =====
const embeddingClient = createOpenAI({
  baseURL: process.env.EMBEDDING_BASE_URL!,
  apiKey: process.env.EMBEDDING_API_KEY!,
});

/** 硅基流动免费的中文向量模型，1024 维 */
const EMBEDDING_MODEL = "BAAI/bge-m3";

// ===== 初始化 Supabase 客户端（写入需要 service_role 密钥） =====
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!,
);

// ===== 核心函数 =====

/**
 * 调用硅基流动 API 生成文本向量
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: embeddingClient.embedding(EMBEDDING_MODEL),
    value: text,
  });
  return embedding;
}

/**
 * 将文本及其向量存入 campus_documents 表
 */
async function insertDocument(content: string, title?: string): Promise<number> {
  console.log(`📝 文本: ${content.slice(0, 60)}${content.length > 60 ? "..." : ""}`);
  console.log("⏳ 正在生成向量...");

  const embedding = await generateEmbedding(content);
  console.log(`✅ 向量维度: ${embedding.length}`);

  console.log("⏳ 正在存入 Supabase...");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: Record<string, any> = { content, embedding };
  if (title) row.title = title;

  const { data, error } = await supabase
    .from("campus_documents")
    .insert(row)
    .select();

  if (error) {
    throw new Error(`插入失败: ${error.message}`);
  }

  const id = data[0].id as number;
  console.log(`✅ 已存入，ID: ${id}\n`);
  return id;
}

// ===== 测试 =====
async function main(): Promise<void> {
  console.log("🚀 学校资料录入脚本\n");
  console.log(`🔧 Embedding 模型: ${EMBEDDING_MODEL}`);
  console.log(`🔗 API 地址: ${process.env.EMBEDDING_BASE_URL}\n`);

  await insertDocument("参加校团委组织的“返家乡”“三下乡”可获得社会实践学分");
}

main().catch((e: unknown) => {
  console.error("❌ 运行出错:", e);
  process.exit(1);
});
