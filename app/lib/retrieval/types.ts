/**
 * 检索域共享类型定义
 *
 * 检索层（lib/retrieval）各模块通过这里定义的类型通信，
 * 避免模块之间互相 import 造成耦合。
 */

import type { Category } from "../classifier";

/** 检索后端标识：上下文来自哪个数据源 */
export type RetrievalBackend = "supabase" | "dify" | "tavily";

/**
 * 检索路由的最终产物。
 *
 * context: 拼装好的检索上下文（可为空串，空串时由 prompt 引导回复"暂无相关信息"）
 * primary: 分类器给出的主类目（决定用哪套 prompt 模板）
 * usedBackend: 实际命中的数据源
 */
export interface RouteResult {
  context: string;
  primary: Category;
  usedBackend: RetrievalBackend;
}
