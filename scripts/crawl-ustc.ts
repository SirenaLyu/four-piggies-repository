/**
 * 爬取 USTC 校园地图 + 课程替代数据 → D:\ustc-data\
 *
 * 数据源：
 *   1. https://map.ustc.edu.cn/japi/get_poi_by_sort_xq?sortcode=XXX
 *      按分类 sortcode 抓取所有 POI（建筑/食堂/宿舍/场馆等）
 *   2. https://catalog.ustc.edu.cn/api/teach/course-substitute-pool/list
 *      课程替代池数据
 *
 * 用法：npx tsx scripts/crawl-ustc.ts
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const OUTPUT_DIR = "D:\\ustc-data";

// ===== map.ustc.edu.cn 分类 sortcode 表（来自 webUI.js 解混淆 + 主页 HTML） =====
// 格式: [sortcode, 类别名, 备注]
const MAP_CATEGORIES: Array<[string, string, string]> = [
  // 校内建筑大类（l_lyjz 系列下属）
  ["010001", "食堂餐厅", "食物/食堂"],
  ["002006", "校友捐赠", ""],
  ["011001", "活动场地", "活动"],
  ["011002", "活动场地", "活动 hd"],
  ["010003", "AED", "急救设备"],
  ["010012", "报警点", "police"],
  ["010007", "出入口", "accesspoint"],
  ["010014", "充电桩", "charge"],
  ["006001", "校园招聘", "job/线下招聘"],
  ["010013", "校车", "schoolbus"],
  ["010015", "班车", "banche"],
  // 机构设置
  ["001001", "校部机关", "校部机关"],
  ["003001", "教学院系", "教学院系"],
  ["004001", "科研机构", "科研机构"],
  ["001002", "直属单位", "直属单位"],
  ["005999", "其他机构", ""],
  // 楼宇
  ["002001", "校内场馆", ""],
  ["002002", "教学科研", ""],
  ["002003", "学生宿舍", ""],
  ["002004", "行政办公", ""],
  ["002005", "家属住宅", ""],
  ["002007", "校友捐赠", ""],
  ["002999", "其他楼宇", ""],
];

// ===== 抓取单分类 POI =====
async function fetchPoiBySortcode(sortcode: string): Promise<unknown[]> {
  const url = `https://map.ustc.edu.cn/japi/get_poi_by_sort_xq?sortcode=${sortcode}&t=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      Referer: "https://map.ustc.edu.cn/",
      Accept: "application/json, text/plain, */*",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for sortcode ${sortcode}`);
  }
  const text = await res.text();
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// ===== 抓取课程替代池 =====
async function fetchSubstitutePool(): Promise<unknown> {
  const url = "https://catalog.ustc.edu.cn/api/teach/course-substitute-pool/list";
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      Referer: "https://catalog.ustc.edu.cn/query/substitute",
      Accept: "application/json, text/plain, */*",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for substitute pool`);
  }
  return await res.json();
}

// ===== POI 转 CSV =====
function poisToCsv(pois: Array<Record<string, unknown>>): string {
  if (pois.length === 0) return "";
  const cols = [
    "id",
    "title",
    "address",
    "sortcode",
    "poitype",
    "telephone",
    "url",
    "description",
    "keyword",
    "xiaoqu",
    "thumbs",
    "pano",
    "x",
    "y",
    "lat",
    "lng",
  ];
  const header = cols.join(",");
  const rows = pois.map((p) =>
    cols
      .map((c) => {
        const v = p[c];
        if (v === null || v === undefined) return "";
        const s = String(v).replace(/"/g, '""');
        return /[",\n\r]/.test(s) ? `"${s}"` : s;
      })
      .join(","),
  );
  return [header, ...rows].join("\n");
}

// ===== 课程替代池转 CSV =====
function substituteToCsv(data: unknown): string {
  if (!Array.isArray(data)) return "";
  const header =
    "pool_id,substitute_id,substitute_cn,substitute_en,substitute_code,substitute_period,substitute_credits,original_id,original_cn,original_en,original_code,original_period,original_credits";
  const rows: string[] = [];
  for (const item of data as Array<Record<string, unknown>>) {
    const poolId = item.id;
    const subs = (item.substituteCourses as Array<Record<string, unknown>>) ?? [];
    const origs = (item.originalCourses as Array<Record<string, unknown>>) ?? [];
    for (const s of subs) {
      for (const o of origs) {
        rows.push(
          [
            poolId,
            s.id,
            `"${String(s.cn ?? "").replace(/"/g, '""')}"`,
            `"${String(s.en ?? "").replace(/"/g, '""')}"`,
            s.code,
            s.period,
            s.credits,
            o.id,
            `"${String(o.cn ?? "").replace(/"/g, '""')}"`,
            `"${String(o.en ?? "").replace(/"/g, '""')}"`,
            o.code,
            o.period,
            o.credits,
          ].join(","),
        );
      }
    }
  }
  return [header, ...rows].join("\n");
}

// ===== 主流程 =====
async function main() {
  console.log(`输出目录: ${OUTPUT_DIR}`);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  // --- 1. 抓取 map.ustc.edu.cn POI 数据 ---
  console.log("\n[1/2] 抓取 map.ustc.edu.cn POI 数据");
  const allPois: Array<Record<string, unknown> & { _category: string; _sortcode: string }> = [];
  const byCategory: Record<string, unknown[]> = {};

  for (const [sortcode, name, note] of MAP_CATEGORIES) {
    try {
      console.log(`  · ${sortcode} ${name}${note ? ` (${note})` : ""} ...`);
      const pois = await fetchPoiBySortcode(sortcode);
      console.log(`    ${pois.length} 条`);
      byCategory[`${sortcode}_${name}`] = pois;
      for (const p of pois as Array<Record<string, unknown>>) {
        allPois.push({ ...p, _category: name, _sortcode: sortcode });
      }
      // 去重保存单分类 JSON
      const safeName = `${sortcode}_${name}`.replace(/[\\/:*?"<>|]/g, "_");
      await fs.writeFile(
        path.join(OUTPUT_DIR, `map-poi-${safeName}.json`),
        JSON.stringify(pois, null, 2),
        "utf-8",
      );
    } catch (err) {
      console.error(`    失败:`, (err as Error).message);
    }
    // 礼貌延时
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`  共抓取 ${allPois.length} 条 POI（含重复，因部分 POI 可能跨分类）`);
  // 按 id 去重
  const dedupMap = new Map<string, Record<string, unknown>>();
  for (const p of allPois) {
    const key = String(p.id);
    if (!dedupMap.has(key)) {
      dedupMap.set(key, p);
    } else {
      // 合并 category
      const existing = dedupMap.get(key)!;
      const existingCats = String(existing._category).split("|");
      if (!existingCats.includes(String(p._category))) {
        existing._category = [...existingCats, String(p._category)].join("|");
      }
    }
  }
  const uniquePois = Array.from(dedupMap.values());
  console.log(`  去重后 ${uniquePois.length} 条`);

  await fs.writeFile(
    path.join(OUTPUT_DIR, "map-poi-all.json"),
    JSON.stringify(uniquePois, null, 2),
    "utf-8",
  );
  await fs.writeFile(
    path.join(OUTPUT_DIR, "map-poi-all.csv"),
    "﻿" + poisToCsv(uniquePois),
    "utf-8",
  );

  // 分类汇总表
  const summary = Object.entries(byCategory).map(([k, v]) => ({
    category: k,
    count: v.length,
  }));
  await fs.writeFile(
    path.join(OUTPUT_DIR, "map-categories-summary.json"),
    JSON.stringify(summary, null, 2),
    "utf-8",
  );

  // --- 2. 抓取 catalog.ustc.edu.cn 课程替代池 ---
  console.log("\n[2/2] 抓取 catalog.ustc.edu.cn 课程替代池");
  try {
    const data = await fetchSubstitutePool();
    const arr = Array.isArray(data) ? data : [];
    console.log(`  ${arr.length} 条替代池记录`);
    await fs.writeFile(
      path.join(OUTPUT_DIR, "catalog-substitute.json"),
      JSON.stringify(data, null, 2),
      "utf-8",
    );
    await fs.writeFile(
      path.join(OUTPUT_DIR, "catalog-substitute.csv"),
      "﻿" + substituteToCsv(data),
      "utf-8",
    );
  } catch (err) {
    console.error("  失败:", (err as Error).message);
  }

  // --- 完成清单 ---
  console.log("\n=== 完成 ===");
  const files = await fs.readdir(OUTPUT_DIR);
  for (const f of files) {
    const stat = await fs.stat(path.join(OUTPUT_DIR, f));
    console.log(`  ${f}  (${(stat.size / 1024).toFixed(1)} KB)`);
  }
}

main().catch((err) => {
  console.error("爬取失败:", err);
  process.exit(1);
});
