/**
 * 检索路由编排 —— 分类路由 + 三层兜底检索链
 *
 * 检索链语义（每层失败自动降级到下一层）：
 *   1. Supabase：按分类器路由到 1-2 个类目的 match_* RPC
 *   2. Dify：Supabase 无命中时，单库兜底 / 跨 5 库撒网
 *   3. Tavily：Dify 也无命中时，搜索学校官网实时信息（未配置密钥则跳过）
 *
 * 被 app/api/chat/route.ts 调用，是检索层的唯一入口。
 */

import { embed } from "ai";
import { embeddingClient, EMBEDDING_MODEL } from "../ai-clients";
import {
  classifyWithEmbedding,
  isCourseSubstituteQuery,
  extractCourseName,
  type Category,
} from "../classifier";
import { searchDify, searchDifyAll, difySupports } from "./dify";
import { searchSchoolNews } from "./tavily";
import {
  searchCalendar,
  searchShuttle,
  searchNotices,
  searchLibraryHours,
  searchScholarships,
  searchPois,
  searchCourses,
  searchSubstitutes,
  searchDocuments,
} from "./supabase";
import type { RouteResult } from "./types";

/** 按类目分发到对应的 Supabase 检索函数 */
async function searchSupabaseByCategory(
  category: Category,
  embedding: number[],
  query: string,
): Promise<string> {
  switch (category) {
    case "calendar":
      return searchCalendar(embedding);
    case "shuttle":
      return searchShuttle(embedding);
    case "notices":
      return searchNotices(embedding);
    case "library":
      return searchLibraryHours(embedding);
    case "scholarships":
      return searchScholarships(embedding);
    case "poi":
      return searchPois(embedding);
    case "courses": {
      // courses 类目内若命中课程替代关键词，附加替代关系查询
      const courseText = await searchCourses(embedding, query);
      if (isCourseSubstituteQuery(query)) {
        const subText = await searchSubstitutes(extractCourseName(query));
        return [courseText, subText].filter(Boolean).join("\n\n===\n\n");
      }
      return courseText;
    }
    case "fallback":
      return searchDocuments(embedding);
  }
}

/** Dify 兜底：primary 在 5 类内查单库，否则跨 5 库撒网 */
async function searchDifyFallback(
  primary: Category,
  query: string,
): Promise<string> {
  if (difySupports(primary)) {
    return searchDify(primary, query);
  }
  if (primary === "fallback") {
    return searchDifyAll(query);
  }
  return "";
}

/**
 * 检索主入口：embed 一次 → 分类 → Supabase → Dify → Tavily。
 *
 * embedding 调用失败时（未配置密钥 / API 不可达），跳过 Supabase 层，
 * 直接走 Dify 文本检索 + Tavily 兜底，保证服务可用。
 *
 * @returns context 为空串表示三层都无命中，由 prompt 引导回复"暂无相关信息"
 */
export async function retrieveForQuery(userQuery: string): Promise<RouteResult> {
  // embed 失败时 primary 无法分类，按 fallback 处理（Dify 跨 5 库撒网）
  let primary: Category = "fallback";
  let secondary: Category | null = null;
  let embedding: number[] | null = null;

  try {
    const embedded = await embed({
      model: embeddingClient.embedding(EMBEDDING_MODEL),
      value: userQuery,
    });
    embedding = embedded.embedding;
    const classified = await classifyWithEmbedding(embedding, userQuery);
    primary = classified.primary;
    secondary = classified.secondary;
  } catch (err) {
    console.error(
      `[router] embedding/分类失败，降级到 Dify 检索: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 第 1 层：Supabase 按类目检索（多类目并行；embedding 失败时跳过）
  if (embedding) {
    const categories: Category[] = [primary, secondary].filter(
      (c): c is Category => c !== null && c !== "fallback",
    );
    if (categories.length === 0) categories.push("fallback");
    const parts = await Promise.all(
      categories.map((c) => searchSupabaseByCategory(c, embedding!, userQuery)),
    );
    const context = parts.filter(Boolean).join("\n\n===\n\n");
    if (context) return { context, primary, usedBackend: "supabase" };
  }

  // 第 2 层：Dify 兜底
  const difyContext = await searchDifyFallback(primary, userQuery);
  if (difyContext) return { context: difyContext, primary, usedBackend: "dify" };

  // 第 3 层：Tavily 官网搜索兜底（未配置密钥时返回 null，静默跳过）
  const tavilyContext = await searchSchoolNews(userQuery);
  if (tavilyContext) {
    return { context: tavilyContext, primary, usedBackend: "tavily" };
  }

  return { context: "", primary, usedBackend: "supabase" };
}
