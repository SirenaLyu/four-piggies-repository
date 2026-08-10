/**
 * 将 D:\ustc-data\ 下的爬取数据导入 Supabase 三张新表
 *
 * 流程:
 *   1. 读 D:\ustc-data\map-poi-all.json
 *      → 每条 POI 拼成一段文本 → bge-m3 向量化 → 插入 campus_pois
 *   2. 读 D:\ustc-data\catalog-substitute.json
 *      → 抽取所有去重课程 → 向量化 → 插入 campus_courses
 *      → 替代关系插入 campus_substitute_pool
 *
 * 用法:
 *   npx tsx scripts/feed_crawled_data.ts            # 全量
 *   npx tsx scripts/feed_crawled_data.ts --dry-run  # 不写库,只打印
 *   npx tsx scripts/feed_crawled_data.ts --only=pois   # 只跑 POI
 *   npx tsx scripts/feed_crawled_data.ts --only=courses # 只跑课程
 *
 * 前置:
 *   1. 已在 Supabase Dashboard 跑过 supabase/migrations/0001_campus_pois_courses.sql
 *   2. .env.local 配置好 EMBEDDING_API_KEY / EMBEDDING_BASE_URL / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
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

// ===== 客户端 =====
const embeddingClient = createOpenAI({
  baseURL: process.env.EMBEDDING_BASE_URL!,
  apiKey: process.env.EMBEDDING_API_KEY!,
});
const EMBEDDING_MODEL = "BAAI/bge-m3";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!,
);

// ===== 配置 =====
const DATA_DIR = "D:\\ustc-data";
const POI_FILE = path.join(DATA_DIR, "map-poi-all.json");
const SUBSTITUTES_FILE = path.join(DATA_DIR, "catalog-substitute.json");

// 并发控制:bge-m3 单条 embed,每秒约 5-10 条;Supabase insert 每批 100 条
const EMBED_CONCURRENCY = 5;
const INSERT_BATCH = 100;

// ===== 类型 =====
type Poi = {
  id: number;
  title: string;
  address?: string | null;
  poitype?: string | null;
  sortcode?: string | null;
  thumbs?: string | null;
  pano?: string | null;
  description?: string | null;
  telephone?: string | null;
  url?: string | null;
  keyword?: string | null;
  xiaoqu?: string | null;
  lat?: number | null;
  lng?: number | null;
  x?: number | null;
  y?: number | null;
  _category?: string;
  _sortcode?: string;
};

type Course = {
  id: number;
  cn: string;
  en?: string;
  code?: string;
  period?: number;
  credits?: number;
};

type SubstitutePool = {
  id: number;
  substituteCourses: Course[];
  originalCourses: Course[];
};

// ===== 工具函数 =====

/** 从 address 推断校区(xiaoqu 字段在原数据中普遍为 null) */
function inferXiaoqu(address: string | null | undefined): string | null {
  if (!address) return null;
  const m =
    /东校区|西校区|南校区|中校区|高新校区|北区|东区|西区|南区|中区|高新|将军路校区/.exec(
      address,
    );
  return m ? m[0] : null;
}

/** 将 POI 整条拼成一段中文文本(供 embedding) */
function poiToText(p: Poi): string {
  const parts: string[] = [];
  parts.push(p.title ?? "");
  if (p._category) parts.push(`分类:${p._category}`);
  const xq = p.xiaoqu || inferXiaoqu(p.address);
  if (xq) parts.push(`校区:${xq}`);
  if (p.address) parts.push(`地址:${p.address}`);
  if (p.telephone) parts.push(`电话:${p.telephone}`);
  if (p.description && p.description !== "暂无介绍！") parts.push(p.description);
  if (p.keyword) parts.push(`关键词:${p.keyword}`);
  return parts.filter(Boolean).join("。");
}

/** 将课程拼成一段文本(供 embedding) */
function courseToText(c: Course): string {
  const parts: string[] = [c.cn];
  if (c.en) parts.push(c.en);
  if (c.code) parts.push(`课程代码:${c.code}`);
  if (c.period) parts.push(`学时:${c.period}`);
  if (c.credits) parts.push(`学分:${c.credits}`);
  return parts.filter(Boolean).join("。");
}

/** 限速并发执行 async 任务 */
async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor++;
          if (i >= items.length) break;
          results[i] = await fn(items[i], i);
          done++;
          onProgress?.(done, items.length);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

// ===== 1. 导入 POI =====
async function feedPois(dryRun: boolean): Promise<void> {
  console.log("\n========== 导入 POI ==========");
  console.log(`读取: ${POI_FILE}`);
  const pois: Poi[] = JSON.parse(fs.readFileSync(POI_FILE, "utf-8"));
  console.log(`共 ${pois.length} 条 POI`);

  // 已存在的 id(用于跳过,避免重复 embedding)
  const existingIds = new Set<number>();
  if (!dryRun) {
    const { data: existing } = await supabase
      .from("campus_pois")
      .select("id");
    (existing as Array<{ id: number }> | null)?.forEach((r) =>
      existingIds.add(r.id),
    );
    console.log(`Supabase 中已有 ${existingIds.size} 条,将跳过`);
  }

  const toInsert = pois.filter((p) => !existingIds.has(p.id));
  console.log(`待向量化和插入: ${toInsert.length} 条`);

  if (toInsert.length === 0) {
    console.log("无新数据");
    return;
  }

  // 限速并发 embedding
  let embedded = 0;
  const startTime = Date.now();
  const embeddings = await mapLimit(
    toInsert,
    EMBED_CONCURRENCY,
    async (p) => {
      const text = poiToText(p);
      const { embedding } = await embed({
        model: embeddingClient.embedding(EMBEDDING_MODEL),
        value: text,
      });
      return embedding;
    },
    (done, total) => {
      embedded = done;
      if (done % 20 === 0 || done === total) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = (done / elapsed).toFixed(1);
        process.stdout.write(
          `\r  embedding ${done}/${total} (${rate}/s)   `,
        );
      }
    },
  );
  console.log(`\n  embedding 完成,平均 ${((embedded) / ((Date.now() - startTime) / 1000)).toFixed(1)} 条/s`);

  if (dryRun) {
    console.log("[dry-run] 跳过插入,示例文本:");
    console.log("  " + poiToText(toInsert[0]));
    return;
  }

  // 分批插入
  console.log(`分批插入 Supabase (batch=${INSERT_BATCH}) ...`);
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += INSERT_BATCH) {
    const batch = toInsert.slice(i, i + INSERT_BATCH);
    const rows = batch.map((p, j) => ({
      id: p.id,
      title: p.title,
      address: p.address ?? null,
      sortcode: p.sortcode ?? p._sortcode ?? null,
      category: p._category ?? null,
      poitype: p.poitype ?? null,
      telephone: p.telephone ?? null,
      url: p.url ?? null,
      description: p.description ?? null,
      keyword: p.keyword ?? null,
      xiaoqu: p.xiaoqu || inferXiaoqu(p.address),
      thumbs: p.thumbs ?? null,
      pano: p.pano ?? null,
      x: p.x ?? null,
      y: p.y ?? null,
      lat: p.lat ?? null,
      lng: p.lng ?? null,
      raw: p,
      embedding: embeddings[i + j],
    }));
    const { error } = await supabase.from("campus_pois").insert(rows);
    if (error) {
      console.error(`\n  批次 ${i} 插入失败:`, error.message);
      // 尝试单条插入以跳过坏数据
      for (const row of rows) {
        const { error: e2 } = await supabase.from("campus_pois").insert(row);
        if (e2) console.error("  单条插入失败 id=" + row.id + ":", e2.message);
      }
    }
    inserted += rows.length;
    process.stdout.write(`\r  插入 ${inserted}/${toInsert.length}   `);
  }
  console.log(`\n  POI 导入完成`);
}

// ===== 2. 导入课程 + 替代池 =====
async function feedCourses(dryRun: boolean): Promise<void> {
  console.log("\n========== 导入课程 + 替代池 ==========");
  console.log(`读取: ${SUBSTITUTES_FILE}`);
  const pool: SubstitutePool[] = JSON.parse(
    fs.readFileSync(SUBSTITUTES_FILE, "utf-8"),
  );
  console.log(`共 ${pool.length} 条替代池记录`);

  // 抽取所有去重课程
  const courseMap = new Map<number, Course>();
  for (const item of pool) {
    for (const c of item.substituteCourses) courseMap.set(c.id, c);
    for (const c of item.originalCourses) courseMap.set(c.id, c);
  }
  const allCourses = Array.from(courseMap.values());
  console.log(`去重后课程数: ${allCourses.length}`);

  // 标记每个课程是 substitute / original / both
  const roleMap = new Map<number, Set<"substitute" | "original">>();
  for (const item of pool) {
    for (const c of item.substituteCourses) {
      if (!roleMap.has(c.id)) roleMap.set(c.id, new Set());
      roleMap.get(c.id)!.add("substitute");
    }
    for (const c of item.originalCourses) {
      if (!roleMap.has(c.id)) roleMap.set(c.id, new Set());
      roleMap.get(c.id)!.add("original");
    }
  }

  // 已存在的课程 id
  const existingIds = new Set<number>();
  if (!dryRun) {
    const { data: existing } = await supabase
      .from("campus_courses")
      .select("id");
    (existing as Array<{ id: number }> | null)?.forEach((r) =>
      existingIds.add(r.id),
    );
    console.log(`Supabase 中已有 ${existingIds.size} 条课程,将跳过`);
  }

  const toInsert = allCourses.filter((c) => !existingIds.has(c.id));
  console.log(`待向量化和插入: ${toInsert.length} 条课程`);

  if (toInsert.length > 0) {
    let embedded = 0;
    const startTime = Date.now();
    const embeddings = await mapLimit(
      toInsert,
      EMBED_CONCURRENCY,
      async (c) => {
        const text = courseToText(c);
        const { embedding } = await embed({
          model: embeddingClient.embedding(EMBEDDING_MODEL),
          value: text,
        });
        return embedding;
      },
      (done, total) => {
        embedded = done;
        if (done % 20 === 0 || done === total) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = (done / elapsed).toFixed(1);
          process.stdout.write(
            `\r  embedding ${done}/${total} (${rate}/s)   `,
          );
        }
      },
    );
    console.log(`\n  embedding 完成,平均 ${(embedded / ((Date.now() - startTime) / 1000)).toFixed(1)} 条/s`);

    if (dryRun) {
      console.log("[dry-run] 跳过插入,示例文本:");
      console.log("  " + courseToText(toInsert[0]));
    } else {
      console.log(`分批插入 campus_courses (batch=${INSERT_BATCH}) ...`);
      let inserted = 0;
      for (let i = 0; i < toInsert.length; i += INSERT_BATCH) {
        const batch = toInsert.slice(i, i + INSERT_BATCH);
        const rows = batch.map((c, j) => ({
          id: c.id,
          cn: c.cn,
          en: c.en ?? null,
          code: c.code ?? null,
          period: c.period ?? null,
          credits: c.credits ?? null,
          role: Array.from(roleMap.get(c.id) ?? []).sort().join("|"),
          raw: c,
          embedding: embeddings[i + j],
        }));
        const { error } = await supabase.from("campus_courses").insert(rows);
        if (error) {
          console.error(`\n  批次 ${i} 插入失败:`, error.message);
          for (const row of rows) {
            const { error: e2 } = await supabase
              .from("campus_courses")
              .insert(row);
            if (e2) console.error("  单条插入失败 id=" + row.id + ":", e2.message);
          }
        }
        inserted += rows.length;
        process.stdout.write(`\r  插入 ${inserted}/${toInsert.length}   `);
      }
      console.log(`\n  课程导入完成`);
    }
  }

  // 替代池关系
  console.log("\n导入替代池关系 campus_substitute_pool ...");
  if (dryRun) {
    console.log("[dry-run] 跳过插入");
    return;
  }

  // 检查已有关系
  const { count: existingCount } = await supabase
    .from("campus_substitute_pool")
    .select("*", { count: "exact", head: true });
  console.log(`Supabase 中已有 ${existingCount ?? 0} 条关系`);

  // 构造所有 (substitute, original) 对
  const relations: Array<{
    pool_id: number;
    substitute_course_id: number;
    original_course_id: number;
    raw: unknown;
  }> = [];
  for (const item of pool) {
    for (const s of item.substituteCourses) {
      for (const o of item.originalCourses) {
        relations.push({
          pool_id: item.id,
          substitute_course_id: s.id,
          original_course_id: o.id,
          raw: { substitute: s, original: o },
        });
      }
    }
  }
  console.log(`待插入关系: ${relations.length} 条(笛卡尔积展开)`);

  let relInserted = 0;
  for (let i = 0; i < relations.length; i += INSERT_BATCH) {
    const batch = relations.slice(i, i + INSERT_BATCH);
    const { error } = await supabase
      .from("campus_substitute_pool")
      .insert(batch);
    if (error) {
      // 关系表唯一约束冲突 = 重复,可忽略
      if (!error.message.includes("duplicate")) {
        console.error(`\n  批次 ${i} 插入失败:`, error.message);
      }
    }
    relInserted += batch.length;
    if (i % (INSERT_BATCH * 5) === 0) {
      process.stdout.write(`\r  关系 ${relInserted}/${relations.length}   `);
    }
  }
  console.log(`\n  替代池关系导入完成`);
}

// ===== 主流程 =====
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const onlyArg = args.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice(7) : null;

  console.log("====================================================");
  console.log("USTC 爬取数据 → Supabase 导入脚本");
  console.log("====================================================");
  console.log(`数据目录: ${DATA_DIR}`);
  console.log(`Embedding: ${EMBEDDING_MODEL} @ ${process.env.EMBEDDING_BASE_URL}`);
  console.log(`Supabase:  ${process.env.SUPABASE_URL}`);
  console.log(`模式: ${dryRun ? "DRY-RUN(不写库)" : "实际写入"}`);
  if (only) console.log(`仅导入: ${only}`);
  console.log("");

  if (!fs.existsSync(POI_FILE)) {
    throw new Error(`找不到 ${POI_FILE},请先跑 scripts/crawl-ustc.ts`);
  }
  if (!fs.existsSync(SUBSTITUTES_FILE)) {
    throw new Error(`找不到 ${SUBSTITUTES_FILE},请先跑 scripts/crawl-ustc.ts`);
  }

  if (!only || only === "pois") await feedPois(dryRun);
  if (!only || only === "courses") await feedCourses(dryRun);

  console.log("\n✅ 全部完成");
}

main().catch((e: unknown) => {
  console.error("\n❌ 运行出错:", e);
  process.exit(1);
});
