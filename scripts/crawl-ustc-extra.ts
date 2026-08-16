/**
 * 爬取 USTC 校园 AI 助手补充资料 → D:\ustc-data\
 *
 * 数据源：
 *   1. 校历   https://www.teach.ustc.edu.cn/calendar/{ID}.html  (HTML 表格解析)
 *   2. 通知   https://www.teach.ustc.edu.cn/notice/feed          (RSS feed)
 *   3. 图书馆 https://lib.ustc.edu.cn/本馆概况/日常开放时间/     (HTML 解析)
 *   4. 校车   手动录入(用户 2026-08-15 提供的暑期时刻表)
 *   5. 奖助学金/资助  https://stuhome.ustc.edu.cn/{column}/list.htm  (HTML 解析)
 *      栏目:2298 公示栏 / 2306 奖助学金 / 2305 助学贷款 / 2304 勤工助学
 *
 * 与 crawl-ustc.ts 独立,不污染 8/10 已验证的 POI/课程爬虫。
 * 用法：npx tsx scripts/crawl-ustc-extra.ts
 *      npx tsx scripts/crawl-ustc-extra.ts --only=calendar
 *      npx tsx scripts/crawl-ustc-extra.ts --only=notices,library
 *      npx tsx scripts/crawl-ustc-extra.ts --only=scholarships --scholarship-pages=4
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const OUTPUT_DIR = "D:\\ustc-data";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// ===== 通用工具 =====

/** CSV 单元格转义:复用 crawl-ustc.ts:117 的逻辑,抽成通用函数 */
function toCsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/"/g, '""');
  return /[",\n\r]/.test(s) ? `"${s}"` : s;
}

/** 写 JSON + CSV(带 BOM) */
async function writeJsonAndCsv<T>(
  name: string,
  rows: Array<T>,
  cols: Array<keyof T & string>,
): Promise<void> {
  await fs.writeFile(path.join(OUTPUT_DIR, `${name}.json`), JSON.stringify(rows, null, 2), "utf-8");
  const header = cols.join(",");
  const body = rows.map((r) => cols.map((c) => toCsvCell((r as Record<string, unknown>)[c])).join(",")).join("\n");
  const csv = body ? `${header}\n${body}` : header;
  await fs.writeFile(path.join(OUTPUT_DIR, `${name}.csv`), "﻿" + csv, "utf-8");
}

/** 礼貌延时 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** fetch HTML,带 UA + Referer */
async function fetchHtml(url: string, referer?: string): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
  if (referer) headers.Referer = referer;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

// ===== 1. 校历 =====

interface CalendarEvent {
  academic_year: string;
  semester: string;
  start_date: string;
  end_date: string;
  event_title: string;
  source_url: string;
}

/** 中文月名 → 数字:一→01,...,十二→12 */
const CN_MONTH_MAP: Record<string, string> = {
  一: "01", 二: "02", 三: "03", 四: "04", 五: "05", 六: "06",
  七: "07", 八: "08", 九: "09", 十: "10", 十一: "11", 十二: "12",
};

/**
 * 解析校历页面 html 表格。
 * 表格结构(<table class="res-wrap table3 calendar">):
 *   每行 = 一周(表头顺序 日/一/二/三/四/五/六);
 *   第一个 td 带 rowspan="N" 是中文月份("八");第二个 td 是教学周标签;
 *   之后 14 个 td 是 7 个 (日期, 事件) 对。
 *
 * 难点:同一行可能跨月(9 月第一行含 8/30, 8/31, 9/1, ..., 9/5),
 *      日期数字本身不能判断月份。
 * 方案:用累加法——从第一行 anchor 起按"上一行最后日期 + 1"推断,
 *      遇到日期数字 < 上一行最后日期 时自动进位到下月。
 *
 * 学期从 <caption> 提取,跨年推断:秋季学期 8-12 月用起始年,1-7 月用起始年+1。
 */
function parseCalendarHtml(html: string, sourceUrl: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  const capMatch = html.match(/<caption[^>]*>[\s\S]*?（([^）]*学期)）[\s\S]*?<\/caption>/);
  const semesterRaw = capMatch?.[1] ?? "";
  const semMatch = semesterRaw.match(/^(\d{4})年(.+?)学期$/);
  const startYear = semMatch ? parseInt(semMatch[1]) : 0;
  const academic_year = semMatch?.[1] ?? "";
  const semester = semMatch?.[2] ?? semesterRaw;

  const tbodyMatch = html.match(/<table class="res-wrap table3 calendar">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) return events;
  const tbody = tbodyMatch[1];

  const rows = tbody.split(/<tr>/).slice(1);

  let curDate: { y: number; m: number; d: number } | null = null;
  let pendingMonthFromRowspan: string | null = null;
  let currentMonth: number = 0;
  let currentYear: number = startYear;

  for (const row of rows) {
    const tdRegex = /<td([^>]*)>([\s\S]*?)<\/td>/g;
    const cells: Array<{ attrs: string; text: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = tdRegex.exec(row)) !== null) {
      cells.push({ attrs: m[1], text: m[2].replace(/<[^>]+>/g, "").trim() });
    }
    if (cells.length === 0) continue;

    let monthIdx = -1;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].attrs.includes("rowspan") && CN_MONTH_MAP[cells[i].text]) {
        monthIdx = i;
        pendingMonthFromRowspan = cells[i].text;
        break;
      }
    }

    let startIdx: number;
    if (monthIdx >= 0) startIdx = monthIdx + 2;
    else startIdx = 1;

    const pairs: Array<{ day: number; event: string }> = [];
    for (let i = startIdx; i + 1 < cells.length; i += 2) {
      const dayCell = cells[i].text;
      const eventCell = cells[i + 1].text;
      if (!/^\d{1,2}$/.test(dayCell)) continue;
      pairs.push({ day: parseInt(dayCell), event: eventCell });
    }
    if (pairs.length === 0) continue;

    if (curDate === null) {
      if (pendingMonthFromRowspan && CN_MONTH_MAP[pendingMonthFromRowspan]) {
        currentMonth = parseInt(CN_MONTH_MAP[pendingMonthFromRowspan]);
        currentYear = startYear;
        curDate = { y: currentYear, m: currentMonth, d: pairs[0].day };
      } else {
        continue;
      }
    }

    for (let i = 0; i < pairs.length; i++) {
      const { day, event } = pairs[i];
      if (i === 0 && curDate !== null) {
        if (day < curDate.d) {
          currentMonth += 1;
          if (currentMonth > 12) {
            currentMonth = 1;
            currentYear += 1;
          }
          curDate = { y: currentYear, m: currentMonth, d: day };
        } else if (day === curDate.d) {
          // 同一天(不应发生),不动
        } else {
          curDate = { y: currentYear, m: currentMonth, d: day };
        }
      } else {
        curDate = { y: currentYear, m: currentMonth, d: day };
        if (i > 0 && day < pairs[i - 1].day) {
          currentMonth += 1;
          if (currentMonth > 12) {
            currentMonth = 1;
            currentYear += 1;
          }
          curDate = { y: currentYear, m: currentMonth, d: day };
        }
      }

      if (!event) continue;
      const dateStr = `${curDate.y}-${String(curDate.m).padStart(2, "0")}-${String(curDate.d).padStart(2, "0")}`;
      events.push({
        academic_year,
        semester,
        start_date: dateStr,
        end_date: dateStr,
        event_title: event,
        source_url: sourceUrl,
      });
    }
  }

  return events;
}

/** 从校历页面提取 prev 链接(更早的学期) */
function findPrevCalendarUrl(html: string): string | null {
  const m = html.match(/<p class="prev"><a href="([^"]+)">/);
  return m?.[1] ?? null;
}

async function fetchCalendar(): Promise<CalendarEvent[]> {
  console.log("\n[1/5] 抓取校历 (teach.ustc.edu.cn/calendar)");
  const allEvents: CalendarEvent[] = [];
  // 从最新页面 20135(2026 秋季)开始,往前链式爬 4 个学期
  let url: string | null = "https://www.teach.ustc.edu.cn/calendar/20135.html";
  const MAX_SEMESTERS = 4;
  for (let i = 0; i < MAX_SEMESTERS && url; i++) {
    try {
      console.log(`  · ${url}`);
      const html = await fetchHtml(url, "https://www.teach.ustc.edu.cn/");
      const events = parseCalendarHtml(html, url);
      console.log(`    ${events.length} 个事件`);
      allEvents.push(...events);
      url = findPrevCalendarUrl(html);
    } catch (err) {
      console.error(`    失败:`, (err as Error).message);
      break;
    }
    await sleep(200);
  }
  return allEvents;
}

// ===== 2. 教务处通知 =====

interface Notice {
  title: string;
  url: string;
  publish_date: string;
  author: string;
  category: string;
  body_preview: string;
}

/** 从 RSS item 提取通知;body_preview 取 description 前 200 字 */
function parseNoticeRss(xml: string): Notice[] {
  const notices: Notice[] = [];
  const items = xml.split("<item>").slice(1);
  for (const item of items) {
    const title = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() ?? "";
    const url = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
    const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? "";
    const author = item.match(/<dc:creator><!\[CDATA\[([\s\S]*?)\]\]><\/dc:creator>/)?.[1]?.trim() ?? "";
    const category = item.match(/<category><!\[CDATA\[([\s\S]*?)\]\]><\/category>/)?.[1]?.trim() ?? "";
    const desc = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ?? "";
    // 去掉 HTML 标签 + 解码常见实体 + 截断 200 字
    const bodyPreview = desc
      .replace(/<[^>]+>/g, "")
      .replace(/&#8230;|&hellip;/g, "…")
      .replace(/"/g, '"')
      .replace(/&#39;|'/g, "'")
      .replace(/</g, "<")
      .replace(/>/g, ">")
      .replace(/&/g, "&")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    // pubDate "Fri, 31 Jul 2026 12:07:58 +0000" → "2026-07-31"
    const dateObj = new Date(pubDate);
    const publish_date = isNaN(dateObj.getTime()) ? pubDate : dateObj.toISOString().slice(0, 10);
    notices.push({ title, url, publish_date, author, category, body_preview: bodyPreview });
  }
  return notices;
}

async function fetchNotices(): Promise<Notice[]> {
  console.log("\n[2/5] 抓取教务处通知 (teach.ustc.edu.cn/notice/feed)");
  const url = "https://www.teach.ustc.edu.cn/notice/feed";
  try {
    const xml = await fetchHtml(url, "https://www.teach.ustc.edu.cn/");
    const notices = parseNoticeRss(xml);
    console.log(`  ${notices.length} 条通知`);
    return notices;
  } catch (err) {
    console.error(`  失败:`, (err as Error).message);
    return [];
  }
}

// ===== 3. 图书馆开放时间 =====

interface LibraryHour {
  branch: string;
  floor: string;
  service: string;
  weekday_hours: string;
  weekend_hours: string;
  phone: string;
  source_url: string;
}

/**
 * 解析图书馆"日常开放时间"页面。
 * 页面结构:1 个 <table> 含多个 <tbody>,每个 tbody 对应一个分馆(东/西/高新)。
 * 每个表格首行是表头(业务地点/周一至周五/周六至周日/联系电话),
 * 之后每行:<td rowspan=N>东 区</td> <td>1楼西</td> <td>业务内容</td> <td>8:00-12:00 14:00-18:00</td> <td>——</td> <td>电话</td>
 *   rowspan 月份 td 只在该区域第一行出现,后续行省略。
 *   时间列可能含两个时间段(上午+下午),用空格分隔;"——" 表示不开放。
 * 策略:逐表逐行解析,用 rowspan 保持 branch 状态,提取楼层/业务/时间/电话。
 */
function parseLibraryHtml(html: string, sourceUrl: string): LibraryHour[] {
  const hours: LibraryHour[] = [];

  // 去掉 script/style
  const cleaned = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");

  // 找所有 <table>...</table>
  const tables = cleaned.match(/<table[^>]*>[\s\S]*?<\/table>/g) ?? [];
  let currentBranch = "";

  for (const table of tables) {
    // 按 <tr...> 拆行(标签可能带属性)
    const rows = table.split(/<tr[^>]*>/).slice(1);
    for (const row of rows) {
      const tdRegex = /<td([^>]*)>([\s\S]*?)<\/td>/g;
      const cells: Array<{ attrs: string; html: string; text: string }> = [];
      let m: RegExpExecArray | null;
      while ((m = tdRegex.exec(row)) !== null) {
        const inner = m[2];
        const text = inner.replace(/<br\s*\/?>/g, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
        cells.push({ attrs: m[1], html: inner, text });
      }
      if (cells.length === 0) continue;

      // 跳过表头行(含"业务地点"或"周一至周五")
      if (cells.some((c) => c.text.includes("业务地点") || c.text.includes("周一至周五"))) continue;

      // 找 branch td(rowspan + 含"区"或"高新")
      for (const c of cells) {
        if (c.attrs.includes("rowspan")) {
          const t = c.text.replace(/\s/g, "");
          if (t.includes("东区") || t.includes("西区") || t.includes("南区") || t.includes("高新")) {
            currentBranch = t;
            break;
          }
        }
      }

      // 提取楼层/业务/时间/电话:假设顺序为 [branch?, floor, service, weekday_hours, weekend_hours, phone]
      // 移除 branch cell 后剩余 cells
      const dataCells = cells.filter((c) => !(c.attrs.includes("rowspan") && (c.text.includes("区") || c.text.includes("高新"))));
      if (dataCells.length < 2) continue;

      // 简化映射:第一个是 floor,第二个是 service,之后找含时间格式的列
      const floor = dataCells[0]?.text ?? "";
      const service = dataCells[1]?.text ?? "";
      let weekday_hours = "";
      let weekend_hours = "";
      let phone = "";
      for (const c of dataCells.slice(2)) {
        if (/\d{1,2}:\d{2}/.test(c.text) || c.text === "——") {
          if (!weekday_hours) weekday_hours = c.text;
          else if (!weekend_hours) weekend_hours = c.text;
        } else if (/^\d{6,}/.test(c.text.replace(/[^0-9]/g, "")) || /[0-9]{6,}/.test(c.text)) {
          if (!phone) phone = c.text;
        }
      }
      // 只有有时间或服务的行才记录
      if (!weekday_hours && !weekend_hours && !service) continue;
      hours.push({
        branch: currentBranch || "未分类",
        floor,
        service,
        weekday_hours,
        weekend_hours,
        phone,
        source_url: sourceUrl,
      });
    }
  }

  return hours;
}

async function fetchLibraryHours(): Promise<LibraryHour[]> {
  console.log("\n[3/5] 抓取图书馆开放时间 (lib.ustc.edu.cn/本馆概况/日常开放时间)");
  const url = "https://lib.ustc.edu.cn/%e6%9c%ac%e9%a6%86%e6%a6%82%e5%86%b5/%e6%97%a5%e5%b8%b8%e5%bc%80%e6%94%be%e6%97%b6%e9%97%b4/";
  try {
    const html = await fetchHtml(url, "https://lib.ustc.edu.cn/");
    const hours = parseLibraryHtml(html, url);
    console.log(`  ${hours.length} 条时间记录`);
    return hours;
  } catch (err) {
    console.error(`  失败:`, (err as Error).message);
    return [];
  }
}

// ===== 2. 校车时刻表(手动录入) =====

interface ShuttleTrip {
  route_name: string;
  direction: string;
  departure: string;
  arrival: string;
  depart_time: string;
  arrive_time: string;
  weekday_only: string;
  period: string;
  note: string;
  source: string;
}

/**
 * 校车数据来源:用户 2026-08-15 提供的暑期时刻表(2026-08-01 ~ 2026-08-29 工作日)
 * USTC 公开页面无结构化时刻表,此部分为人工录入。
 */
function buildShuttleData(): ShuttleTrip[] {
  const period = "2026-08-01~2026-08-29";
  const weekday_only = "true";
  const source = "manual:用户提供 2026-08-15";

  const trips: ShuttleTrip[] = [];

  // 主线 1:东区 → 西区 → 先研院 → 高新园区
  const mainLine1 = [
    ["07:30", "07:40", "08:20"],
    ["12:30", "12:40", "13:20"],
    ["18:00", "18:10", "18:50"],
    ["20:00", "20:10", "20:50"],
  ];
  for (const [d, w, g] of mainLine1) {
    trips.push({
      route_name: "主线1:东→西→先研院→高新",
      direction: "去程",
      departure: "东区",
      arrival: "高新园区",
      depart_time: d,
      arrive_time: g,
      weekday_only,
      period,
      note: `西区 ${w} 发车;先研院即停即走`,
      source,
    });
  }

  // 主线 2:高新园区 → 先研院 → 西区 → 东区
  const mainLine2 = [
    ["08:45", "08:50", "09:35"],
    ["13:30", "13:35", "14:20"],
    ["19:00", "19:05", "19:50"],
    ["21:00", "21:05", "21:50"],
  ];
  for (const [g, x, d] of mainLine2) {
    trips.push({
      route_name: "主线2:高新→先研院→西→东",
      direction: "返程",
      departure: "高新园区",
      arrival: "东区",
      depart_time: g,
      arrive_time: d,
      weekday_only,
      period,
      note: `先研院 ${x} 即停即走;西区即停即走`,
      source,
    });
  }

  // 点对点短途线
  const shortLines: Array<[string, string, string, string[]]> = [
    ["东区→南区", "东区", "南区", ["11:40", "17:10", "19:20"]],
    ["东区→西区", "东区", "西区", ["08:15", "11:30", "14:10", "17:00", "19:00"]],
    ["西区→东区", "西区", "东区", ["08:25", "11:40", "14:20", "17:10", "19:10"]],
    ["西区→南区", "西区", "南区", ["11:30", "17:00", "19:10"]],
    ["南区→东区", "南区", "东区", ["08:00", "14:10", "19:35"]],
    ["南区→西区", "南区", "西区", ["08:00", "14:10"]],
  ];
  for (const [name, dep, arr, times] of shortLines) {
    for (const t of times) {
      trips.push({
        route_name: name,
        direction: "点对点",
        departure: dep,
        arrival: arr,
        depart_time: t,
        arrive_time: "",
        weekday_only,
        period,
        note: "始发站满员即发,无固定到达时间",
        source,
      });
    }
  }

  return trips;
}

// ===== 5. 奖助学金/资助通知(学生工作部 stuhome.ustc.edu.cn) =====

interface ScholarshipNotice {
  title: string;
  url: string;
  publish_date: string;
  publisher: string;
  category: string;
  body_preview: string;
}

/** 学工部栏目:路径 → 中文名 */
const STUHOME_COLUMNS: Array<{ path: string; name: string; max_pages: number }> = [
  { path: "2298", name: "公示栏", max_pages: 6 }, // 含各类奖学金获奖名单公示
  { path: "2306", name: "奖助学金", max_pages: 3 }, // 奖助学金政策类通知
  { path: "2305", name: "助学贷款", max_pages: 3 },
  { path: "2304", name: "勤工助学", max_pages: 3 },
];

/** 从列表页提取 (title, url, publish_date) 三元组 */
function parseScholarshipListHtml(html: string): Array<{ title: string; url: string; publish_date: string }> {
  const items: Array<{ title: string; url: string; publish_date: string }> = [];
  // <li class="news ...">
  //   <span class="news_title"><a href='...' title='...'>...</a></span>
  //   <span class="news_meta">2026-06-04</span>
  // </li>
  const liRegex = /<li class="news[^"]*"[^>]*>[\s\S]*?<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = liRegex.exec(html)) !== null) {
    const li = m[0];
    const aMatch = li.match(/<a href='([^']+)'[^>]*title='([^']+)'/);
    const dateMatch = li.match(/<span class="news_meta">(\d{4}-\d{2}-\d{2})<\/span>/);
    if (!aMatch) continue;
    const url = aMatch[1].startsWith("http") ? aMatch[1] : `https://stuhome.ustc.edu.cn${aMatch[1]}`;
    items.push({
      title: aMatch[2].replace(/"/g, '"').replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">").trim(),
      url,
      publish_date: dateMatch?.[1] ?? "",
    });
  }
  return items;
}

/** 从详情页提取 publisher 与 body_preview(剥标签 + 截 800 字,覆盖公示期/联系人/邮箱/电话) */
function parseScholarshipDetailHtml(html: string): { publisher: string; body_preview: string } {
  const publisher = html.match(/<span class="arti_publisher">发布者：([^<]+)<\/span>/)?.[1]?.trim() ?? "";
  const bodyMatch = html.match(/<div class='wp_articlecontent'>([\s\S]*?)<\/div>/);
  let body_preview = "";
  if (bodyMatch) {
    body_preview = bodyMatch[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/"/g, '"')
      .replace(/&/g, "&")
      .replace(/</g, "<")
      .replace(/>/g, ">")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 800);
  }
  return { publisher, body_preview };
}

/**
 * 抓取学工部 4 个栏目的列表 + 详情。
 * @param maxPagesPerColumn 每个栏目最多抓几页(默认 3),用 --scholarship-pages 覆盖
 */
async function fetchScholarships(maxPagesPerColumn: number): Promise<ScholarshipNotice[]> {
  console.log(`\n[5/5] 抓取奖助学金/资助通知 (stuhome.ustc.edu.cn,每栏目 ${maxPagesPerColumn} 页)`);
  const all: ScholarshipNotice[] = [];
  const seenUrls = new Set<string>();

  for (const col of STUHOME_COLUMNS) {
    const pages = Math.min(maxPagesPerColumn, col.max_pages);
    console.log(`  · ${col.name} (/${col.path}/)  最多 ${pages} 页`);
    for (let p = 1; p <= pages; p++) {
      const listUrl = p === 1
        ? `https://stuhome.ustc.edu.cn/${col.path}/list.htm`
        : `https://stuhome.ustc.edu.cn/${col.path}/list${p}.htm`;
      try {
        const html = await fetchHtml(listUrl, "https://stuhome.ustc.edu.cn/");
        const items = parseScholarshipListHtml(html);
        if (items.length === 0) {
          console.log(`    p${p}: 0 条,停止本栏目`);
          break;
        }
        console.log(`    p${p}: ${items.length} 条`);
        for (const it of items) {
          if (seenUrls.has(it.url)) continue;
          seenUrls.add(it.url);
          all.push({
            title: it.title,
            url: it.url,
            publish_date: it.publish_date,
            publisher: "",
            category: col.name,
            body_preview: "",
          });
        }
      } catch (err) {
        console.error(`    p${p} 失败:`, (err as Error).message);
        break;
      }
      await sleep(200);
    }
  }

  console.log(`  列表汇总:${all.length} 条(去重后),开始抓详情...`);

  // 抓详情(publisher + body_preview)
  let done = 0;
  for (const row of all) {
    try {
      const html = await fetchHtml(row.url, "https://stuhome.ustc.edu.cn/");
      const { publisher, body_preview } = parseScholarshipDetailHtml(html);
      row.publisher = publisher;
      row.body_preview = body_preview;
    } catch (err) {
      console.error(`    详情失败 ${row.url}:`, (err as Error).message);
    }
    done++;
    if (done % 25 === 0) console.log(`    进度 ${done}/${all.length}`);
    await sleep(200);
  }

  return all;
}

// ===== 主流程 =====

async function main() {
  console.log(`输出目录: ${OUTPUT_DIR}`);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  // 解析 --only 参数
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const onlySet = onlyArg ? onlyArg.slice(7).split(",").map((s) => s.trim()) : null;
  const shouldRun = (name: string): boolean => !onlySet || onlySet.includes(name);

  // 解析 --scholarship-pages 参数(每栏目抓几页,默认 3)
  const scholarPagesArg = process.argv.find((a) => a.startsWith("--scholarship-pages="));
  const scholarshipPages = scholarPagesArg ? parseInt(scholarPagesArg.slice(20)) || 3 : 3;

  if (shouldRun("calendar")) {
    const rows = await fetchCalendar();
    await writeJsonAndCsv("calendar", rows, [
      "academic_year",
      "semester",
      "start_date",
      "end_date",
      "event_title",
      "source_url",
    ]);
  }

  if (shouldRun("notices")) {
    const rows = await fetchNotices();
    await writeJsonAndCsv("notices", rows, ["title", "url", "publish_date", "author", "category", "body_preview"]);
  }

  if (shouldRun("library")) {
    const rows = await fetchLibraryHours();
    await writeJsonAndCsv("library-hours", rows, [
      "branch",
      "floor",
      "service",
      "weekday_hours",
      "weekend_hours",
      "phone",
      "source_url",
    ]);
  }

  if (shouldRun("shuttle")) {
    const rows = buildShuttleData();
    console.log(`\n[4/5] 校车时刻表(手动录入): ${rows.length} 条`);
    await writeJsonAndCsv("shuttle", rows, [
      "route_name",
      "direction",
      "departure",
      "arrival",
      "depart_time",
      "arrive_time",
      "weekday_only",
      "period",
      "note",
      "source",
    ]);
  }

  if (shouldRun("scholarships")) {
    const rows = await fetchScholarships(scholarshipPages);
    await writeJsonAndCsv("scholarships", rows, [
      "title",
      "url",
      "publish_date",
      "publisher",
      "category",
      "body_preview",
    ]);
  }

  console.log("\n=== 完成 ===");
  const files = await fs.readdir(OUTPUT_DIR);
  for (const f of files) {
    if (
      f.startsWith("calendar") ||
      f.startsWith("notices") ||
      f.startsWith("library-hours") ||
      f.startsWith("shuttle") ||
      f.startsWith("scholarships")
    ) {
      const stat = await fs.stat(path.join(OUTPUT_DIR, f));
      console.log(`  ${f}  (${(stat.size / 1024).toFixed(1)} KB)`);
    }
  }
}

main().catch((err) => {
  console.error("爬取失败:", err);
  process.exit(1);
});
