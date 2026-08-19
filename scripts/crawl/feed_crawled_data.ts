/**
 * 将 D:\ustc-data\ 下的爬取数据导入 Supabase 三张新表
 *
 * 流程:
 *   1. 读 D:\ustc-data\map-poi-all.json
 *      → 每条 POI 拼成一段文本 → bge-m3 向量化 → 插入 campus_pois
 *   2. 读 D:\ustc-data\catalog-substitute.json
 *      → 抽取所有去重课程 → 向量化 → 插入 campus_courses
 *      → 替代关系插入 campus_substitute_pool
 *   3-7. 读 8/15 新增的 5 个 CSV(校历/班车/通知/图书馆/奖学金)
 *      → 每行拼成一段文本 → 向量化 → 插入对应表(truncate-then-insert)
 *
 * 用法:
 *   npx tsx scripts/crawl/feed_crawled_data.ts            # 全量
 *   npx tsx scripts/crawl/feed_crawled_data.ts --dry-run  # 不写库,只打印
 *   npx tsx scripts/crawl/feed_crawled_data.ts --only=pois   # 只跑 POI
 *   npx tsx scripts/crawl/feed_crawled_data.ts --only=courses # 只跑课程
 *   npx tsx scripts/crawl/feed_crawled_data.ts --only=calendar,shuttle,notices,library,scholarships  # 只跑 5 类新数据
 *
 * 前置:
 *   1. 已在 Supabase Dashboard 跑过 supabase/migrations/0001_campus_pois_courses.sql
 *      和 0002_calendar_shuttle_notices_library_scholarships.sql(5 类新数据需要)
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

// 8/15 新增 5 类 CSV(由 scripts/crawl/crawl-ustc-extra.ts 产出)
const CALENDAR_CSV = path.join(DATA_DIR, "calendar.csv");
const SHUTTLE_CSV = path.join(DATA_DIR, "shuttle.csv");
const NOTICES_CSV = path.join(DATA_DIR, "notices.csv");
const LIBRARY_CSV = path.join(DATA_DIR, "library-hours.csv");
const SCHOLARSHIPS_CSV = path.join(DATA_DIR, "scholarships.csv");

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

// ===== 3-7. 导入 5 类 CSV(校历/班车/通知/图书馆/奖学金) =====

/**
 * 极简 CSV 解析:支持带引号字段(含逗号/换行/转义引号 "" ),strip BOM。
 * 这些 CSV 由 crawl-ustc-extra.ts 产出,字段简单,无需依赖外部库。
 */
function parseCsv(filePath: string): Array<Record<string, string>> {
  let content = fs.readFileSync(filePath, "utf-8");
  // strip BOM
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const rows: Array<Record<string, string>> = [];
  const fields: string[] = [];
  let cur = "";
  let inQuote = false;
  let row: string[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (inQuote) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuote = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(cur);
      cur = "";
      if (fields.length === 0) {
        // 第一行 = 表头
        fields.push(...row);
      } else if (row.some((f) => f !== "")) {
        // 跳过全空行
        const obj: Record<string, string> = {};
        for (let j = 0; j < fields.length; j++) {
          obj[fields[j]] = row[j] ?? "";
        }
        rows.push(obj);
      }
      row = [];
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  // 文件末尾最后一行(无换行结尾)
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    if (fields.length === 0) {
      fields.push(...row);
    } else if (row.some((f) => f !== "")) {
      const obj: Record<string, string> = {};
      for (let j = 0; j < fields.length; j++) {
        obj[fields[j]] = row[j] ?? "";
      }
      rows.push(obj);
    }
  }
  return rows;
}

/** 通用:embed 一批文本 + 分批插入,truncate 模式(每次重跑清空再灌) */
async function feedCsvTable(opts: {
  name: string;
  csvPath: string;
  table: string;
  toText: (r: Record<string, string>) => string;
  toRow: (r: Record<string, string>, embedding: number[]) => Record<string, unknown>;
  dryRun: boolean;
}): Promise<void> {
  const { name, csvPath, table, toText, toRow, dryRun } = opts;
  console.log(`\n========== 导入 ${name} ==========`);
  console.log(`读取: ${csvPath}`);
  if (!fs.existsSync(csvPath)) {
    console.log(`  文件不存在,跳过`);
    return;
  }
  const records = parseCsv(csvPath);
  console.log(`共 ${records.length} 行`);
  if (records.length === 0) return;

  // 限速并发 embedding
  let embedded = 0;
  const startTime = Date.now();
  const embeddings = await mapLimit(
    records,
    EMBED_CONCURRENCY,
    async (r) => {
      const text = toText(r);
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
        process.stdout.write(`\r  embedding ${done}/${total} (${rate}/s)   `);
      }
    },
  );
  console.log(`\n  embedding 完成,平均 ${(embedded / ((Date.now() - startTime) / 1000)).toFixed(1)} 条/s`);

  if (dryRun) {
    console.log("[dry-run] 跳过插入,示例文本:");
    console.log("  " + toText(records[0]));
    return;
  }

  // truncate-then-insert:这些表无自然主键,每次重跑清空再灌
  console.log(`清空 ${table} ...`);
  const { error: truncErr } = await supabase.from(table).delete().neq("id", -1);
  if (truncErr) {
    console.error(`  清空失败:`, truncErr.message);
    return;
  }

  console.log(`分批插入 ${table} (batch=${INSERT_BATCH}) ...`);
  let inserted = 0;
  for (let i = 0; i < records.length; i += INSERT_BATCH) {
    const batch = records.slice(i, i + INSERT_BATCH);
    const rows = batch.map((r, j) => toRow(r, embeddings[i + j]));
    const { error } = await supabase.from(table).insert(rows);
    if (error) {
      console.error(`\n  批次 ${i} 插入失败:`, error.message);
      for (const row of rows) {
        const { error: e2 } = await supabase.from(table).insert(row);
        if (e2) console.error("  单条插入失败:", e2.message);
      }
    }
    inserted += rows.length;
    process.stdout.write(`\r  插入 ${inserted}/${records.length}   `);
  }
  console.log(`\n  ${name} 导入完成`);
}

function calendarToText(r: Record<string, string>): string {
  return [
    r.event_title,
    r.academic_year ? `${r.academic_year}年` : "",
    r.semester ? `${r.semester}学期` : "",
    r.start_date ? `${r.start_date}~${r.end_date || r.start_date}` : "",
  ].filter(Boolean).join(" ");
}

function shuttleToText(r: Record<string, string>): string {
  return [
    r.route_name,
    r.direction,
    r.departure ? `${r.departure}到${r.arrival}` : "",
    r.depart_time ? `${r.depart_time}发车${r.arrive_time ? ` ${r.arrive_time}到` : ""}` : "",
    r.weekday_only === "true" ? "工作日" : "每日",
    r.period,
    r.note,
  ].filter(Boolean).join(" ");
}

function noticesToText(r: Record<string, string>): string {
  return [r.title, r.publish_date, r.author, r.category, r.body_preview].filter(Boolean).join(" ");
}

function libraryToText(r: Record<string, string>): string {
  return [
    r.branch ? `${r.branch}图书馆` : "",
    r.floor,
    r.service,
    r.weekday_hours ? `工作日${r.weekday_hours}` : "",
    r.weekend_hours ? `周末${r.weekend_hours}` : "",
    r.phone ? `电话${r.phone}` : "",
  ].filter(Boolean).join(" ");
}

function scholarshipsToText(r: Record<string, string>): string {
  return [r.title, r.publish_date, r.publisher, r.category, r.body_preview].filter(Boolean).join(" ");
}

async function feedCalendar(dryRun: boolean): Promise<void> {
  return feedCsvTable({
    name: "校历 (campus_calendar)",
    csvPath: CALENDAR_CSV,
    table: "campus_calendar",
    dryRun,
    toText: calendarToText,
    toRow: (r, embedding) => ({
      academic_year: r.academic_year || null,
      semester: r.semester || null,
      start_date: r.start_date || null,
      end_date: r.end_date || r.start_date || null,
      event_title: r.event_title,
      source_url: r.source_url || null,
      raw: r,
      embedding,
    }),
  });
}

async function feedShuttle(dryRun: boolean): Promise<void> {
  return feedCsvTable({
    name: "班车 (campus_shuttle)",
    csvPath: SHUTTLE_CSV,
    table: "campus_shuttle",
    dryRun,
    toText: shuttleToText,
    toRow: (r, embedding) => ({
      route_name: r.route_name,
      direction: r.direction || null,
      departure: r.departure || null,
      arrival: r.arrival || null,
      depart_time: r.depart_time || null,
      arrive_time: r.arrive_time || null,
      weekday_only: r.weekday_only || null,
      period: r.period || null,
      note: r.note || null,
      source: r.source || null,
      raw: r,
      embedding,
    }),
  });
}

async function feedNotices(dryRun: boolean): Promise<void> {
  return feedCsvTable({
    name: "教务通知 (campus_notices)",
    csvPath: NOTICES_CSV,
    table: "campus_notices",
    dryRun,
    toText: noticesToText,
    toRow: (r, embedding) => ({
      title: r.title,
      url: r.url || null,
      publish_date: r.publish_date || null,
      author: r.author || null,
      category: r.category || null,
      body_preview: r.body_preview || null,
      raw: r,
      embedding,
    }),
  });
}

async function feedLibrary(dryRun: boolean): Promise<void> {
  return feedCsvTable({
    name: "图书馆 (campus_library_hours)",
    csvPath: LIBRARY_CSV,
    table: "campus_library_hours",
    dryRun,
    toText: libraryToText,
    toRow: (r, embedding) => ({
      branch: r.branch,
      floor: r.floor || null,
      service: r.service || null,
      weekday_hours: r.weekday_hours || null,
      weekend_hours: r.weekend_hours || null,
      phone: r.phone || null,
      source_url: r.source_url || null,
      raw: r,
      embedding,
    }),
  });
}

async function feedScholarships(dryRun: boolean): Promise<void> {
  return feedCsvTable({
    name: "奖学金 (campus_scholarships)",
    csvPath: SCHOLARSHIPS_CSV,
    table: "campus_scholarships",
    dryRun,
    toText: scholarshipsToText,
    toRow: (r, embedding) => ({
      title: r.title,
      url: r.url || null,
      publish_date: r.publish_date || null,
      publisher: r.publisher || null,
      category: r.category || null,
      body_preview: r.body_preview || null,
      raw: r,
      embedding,
    }),
  });
}

// ===== 主流程 =====
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const onlyArg = args.find((a) => a.startsWith("--only="));
  // 支持 --only=a,b,c 逗号列表,也兼容旧的单值 --only=pois
  const onlySet = onlyArg
    ? new Set(onlyArg.slice(7).split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  const shouldRun = (name: string): boolean => !onlySet || onlySet.has(name);

  console.log("====================================================");
  console.log("USTC 爬取数据 → Supabase 导入脚本");
  console.log("====================================================");
  console.log(`数据目录: ${DATA_DIR}`);
  console.log(`Embedding: ${EMBEDDING_MODEL} @ ${process.env.EMBEDDING_BASE_URL}`);
  console.log(`Supabase:  ${process.env.SUPABASE_URL}`);
  console.log(`模式: ${dryRun ? "DRY-RUN(不写库)" : "实际写入"}`);
  if (onlySet) console.log(`仅导入: ${Array.from(onlySet).join(", ")}`);
  console.log("");

  // 旧的 8/10 数据(pois/courses)文件存在性检查,只在跑这两个时校验
  if (shouldRun("pois") && !fs.existsSync(POI_FILE)) {
    throw new Error(`找不到 ${POI_FILE},请先跑 scripts/crawl/crawl-ustc.ts`);
  }
  if (shouldRun("courses") && !fs.existsSync(SUBSTITUTES_FILE)) {
    throw new Error(`找不到 ${SUBSTITUTES_FILE},请先跑 scripts/crawl/crawl-ustc.ts`);
  }

  if (shouldRun("pois")) await feedPois(dryRun);
  if (shouldRun("courses")) await feedCourses(dryRun);
  if (shouldRun("calendar")) await feedCalendar(dryRun);
  if (shouldRun("shuttle")) await feedShuttle(dryRun);
  if (shouldRun("notices")) await feedNotices(dryRun);
  if (shouldRun("library")) await feedLibrary(dryRun);
  if (shouldRun("scholarships")) await feedScholarships(dryRun);

  console.log("\n✅ 全部完成");
}

main().catch((e: unknown) => {
  console.error("\n❌ 运行出错:", e);
  process.exit(1);
});
