import fs from "node:fs";
import path from "node:path";

const args = new Map(
  process.argv.slice(2).map((value) => {
    const index = value.indexOf("=");
    return index === -1
      ? [value.replace(/^--/, ""), "true"]
      : [value.slice(0, index).replace(/^--/, ""), value.slice(index + 1)];
  }),
);

const targetId = args.get("target");
if (!targetId) {
  throw new Error("缺少 --target=<CDP target id>");
}

const sourceRoot = path.resolve(
  args.get("source") ?? "C:/Users/hlqa0/Desktop/wokepaike/data",
);
const outputRoot = path.resolve(
  args.get("output") ?? "generated/icourse-refresh/source",
);
const proxyBase = args.get("proxy") ?? "http://127.0.0.1:3456";
const batchSize = Math.max(1, Math.min(4, Number(args.get("batch-size") ?? 2)));
const delayMs = Math.max(250, Number(args.get("delay-ms") ?? 500));
const extractedAt = new Date().toISOString();

const requiredSourceFiles = [
  "courses_undergrad_2026spring.json",
  "courses_undergrad_2026summer.json",
  "courses_undergrad_fall2026.json",
  "program_courses_2025.json",
  "program_tree_compact.json",
  "icourse_ratings.json",
  "icourse_cards_cache.json",
  "substitute_clean.json",
];

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copySourceSnapshot() {
  fs.mkdirSync(outputRoot, { recursive: true });
  const snapshotRoot = path.join(outputRoot, "snapshots");
  fs.mkdirSync(snapshotRoot, { recursive: true });
  for (const name of requiredSourceFiles) {
    const source = path.join(sourceRoot, name);
    if (!fs.existsSync(source)) throw new Error(`缺少源文件：${source}`);
    fs.copyFileSync(source, path.join(outputRoot, name));
    if (name.startsWith("icourse_")) {
      fs.copyFileSync(source, path.join(snapshotRoot, `${name}.before`));
    }
  }
}

async function evaluate(expression) {
  const response = await fetch(
    `${proxyBase}/eval?target=${encodeURIComponent(targetId)}`,
    {
      method: "POST",
      body: expression,
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!response.ok) {
    throw new Error(`CDP proxy HTTP ${response.status}: ${await response.text()}`);
  }
  const result = await response.json();
  if (result.error) throw new Error(`CDP evaluate 失败：${result.error}`);
  return result.value;
}

async function evaluateJson(expression, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const value = await evaluate(expression);
      return typeof value === "string" ? JSON.parse(value) : value;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(attempt * 1_000);
    }
  }
  throw lastError;
}

function listPageExpression(pages) {
  return `(async()=>JSON.stringify(await Promise.all(${JSON.stringify(pages)}.map(async page=>{
    const response=await fetch('/course/?page='+page,{credentials:'include',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('course page '+page+' HTTP '+response.status);
    const documentValue=new DOMParser().parseFromString(await response.text(),'text/html');
    const totalMatch=documentValue.body.innerText.match(/共\\s*(\\d+)\\s*门课/);
    const links=Array.from(documentValue.querySelectorAll('a.px16[href^="/course/"]'));
    return {
      page,
      total:totalMatch?Number(totalMatch[1]):null,
      cards:links.map(link=>{
        const row=link.closest('div.row');
        const title=link.textContent.trim();
        const titleMatch=title.match(/^(.*)（([^）]+)）$/)||title.match(/^(.*)\\(([^)]+)\\)$/);
        const ratingText=row.querySelector('.rl-pd-sm.h4')?.textContent.trim()||'';
        const score=/^\\d+(?:\\.\\d+)?$/.test(ratingText)?Number(ratingText):null;
        const countText=row.querySelector('.text-muted.px12')?.textContent||'';
        const countMatch=countText.match(/(\\d+)\\s*人评价/);
        const dimensions={};
        for(const item of row.querySelectorAll('ul li')){
          const parts=item.textContent.trim().split('：');
          if(parts.length>=2)dimensions[parts[0]]=parts.slice(1).join('：');
        }
        const idMatch=link.pathname.match(/\\/course\\/(\\d+)\\//);
        return {
          id:idMatch?Number(idMatch[1]):null,
          name:(titleMatch?.[1]||title).trim(),
          teachers_raw:(titleMatch?.[2]||'').trim(),
          score,
          review_count:countMatch?Number(countMatch[1]):0,
          latest_semester:(row.querySelector('span.small.text-muted')?.textContent||'').replace(/\\.\\.\\./g,'').trim()||null,
          difficulty:dimensions['课程难度']||null,
          workload:dimensions['作业多少']||null,
          grading:dimensions['给分好坏']||null,
          gain:dimensions['收获大小']||null,
          source_url:new URL(link.getAttribute('href'),location.origin).href
        };
      }).filter(card=>card.id)
    };
  }))))()`;
}

function detailPageExpression(ids) {
  return `(async()=>JSON.stringify(await Promise.all(${JSON.stringify(ids)}.map(async id=>{
    const response=await fetch('/course/'+id+'/',{credentials:'include',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('course detail '+id+' HTTP '+response.status);
    const documentValue=new DOMParser().parseFromString(await response.text(),'text/html');
    const text=documentValue.body.innerText;
    const codeMatch=text.match(/课程号：\\s*([A-Za-z0-9._-]+)/);
    const semesters=Array.from(new Set(text.match(/20\\d{2}[春夏秋冬]/g)||[])).sort();
    return {id,icourse_course_code:codeMatch?.[1]||null,semesters};
  }))))()`;
}

function normalizeTeachers(value) {
  return String(value ?? "")
    .split(/[,，、/\\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .sort()
    .join("|");
}

function baseCourseCode(value) {
  return String(value ?? "").trim().toUpperCase().replace(/\.\d+$/, "");
}

function buildRatingMaps(cards) {
  const codeIndex = new Map();
  for (const card of cards) {
    if (
      card.currently_rated !== true ||
      typeof card.score !== "number" ||
      !card.icourse_course_code
    ) {
      continue;
    }
    const code = String(card.icourse_course_code).trim().toUpperCase();
    const entries = codeIndex.get(code) ?? [];
    entries.push(card);
    codeIndex.set(code, entries);
  }

  const terms = [
    ["2026spring", "courses_undergrad_2026spring.json"],
    ["2026summer", "courses_undergrad_2026summer.json"],
    ["2026autumn", "courses_undergrad_fall2026.json"],
  ];
  const ratings = {};
  const details = {};
  const stats = { total: 0, matched: 0, unmatched: 0, multiCard: 0 };

  for (const [termKey, fileName] of terms) {
    const courses = readJson(path.join(outputRoot, fileName));
    for (const course of courses) {
      stats.total += 1;
      const key = `${termKey}|${course["课堂号"]}`;
      const baseCode = baseCourseCode(course["课堂号"]);
      const teacherKey = normalizeTeachers(course["授课教师"]);
      const matches = [];
      for (const [icourseCode, candidates] of codeIndex) {
        if (!icourseCode.startsWith(baseCode)) continue;
        for (const candidate of candidates) {
          if (normalizeTeachers(candidate.teachers_raw) === teacherKey) {
            matches.push(candidate);
          }
        }
      }

      if (matches.length === 0) {
        ratings[key] = null;
        stats.unmatched += 1;
        continue;
      }

      const score =
        matches.reduce((total, card) => total + card.score, 0) / matches.length;
      const representative = [...matches].sort(
        (left, right) => (right.review_count ?? 0) - (left.review_count ?? 0),
      )[0];
      ratings[key] = Math.round(score * 100) / 100;
      details[key] = {
        score: ratings[key],
        review_count: matches.reduce(
          (total, card) => total + (card.review_count ?? 0),
          0,
        ),
        difficulty: representative.difficulty ?? null,
        workload: representative.workload ?? null,
        grading: representative.grading ?? null,
        gain: representative.gain ?? null,
        latest_semester: representative.latest_semester ?? null,
        source_urls: matches.map((card) => card.source_url),
        matched_card_ids: matches.map((card) => card.id),
        extracted_at: extractedAt,
      };
      stats.matched += 1;
      if (matches.length > 1) stats.multiCard += 1;
    }
  }
  return { ratings, details, stats };
}

copySourceSnapshot();

const cardsPath = path.join(outputRoot, "icourse_cards_cache.json");
const existingCards = readJson(cardsPath);
const existingIds = new Set(existingCards.map((card) => Number(card.id)));
const cardsById = new Map(
  existingCards.map((card) => [
    Number(card.id),
    {
      ...card,
      score: null,
      review_count: 0,
      difficulty: null,
      workload: null,
      grading: null,
      gain: null,
      currently_rated: false,
      catalog_checked_at: extractedAt,
    },
  ]),
);

const checkpointPath = path.join(outputRoot, "icourse_live_rated_checkpoint.json");
const checkpoint = fs.existsSync(checkpointPath)
  ? readJson(checkpointPath)
  : null;
const liveRatedById = new Map(
  (checkpoint?.cards ?? []).map((card) => [Number(card.id), card]),
);
let page = checkpoint?.nextPage ?? 1;
let totalCourses = checkpoint?.totalCourses ?? null;
let ratedPages = checkpoint?.ratedPages ?? 0;
let liveRatedCount = liveRatedById.size;
let reachedUnrated = false;

while (!reachedUnrated) {
  const pages = Array.from({ length: batchSize }, (_, index) => page + index);
  const results = await evaluateJson(listPageExpression(pages));
  for (const result of results) {
    totalCourses ??= result.total;
    const ratedCards = result.cards.filter((card) => typeof card.score === "number");
    for (const card of ratedCards) {
      liveRatedById.set(card.id, card);
      const previous = cardsById.get(card.id) ?? {};
      const semesters = new Set(previous.semesters ?? []);
      if (/^20\d{2}[春夏秋冬]$/.test(card.latest_semester ?? "")) {
        semesters.add(card.latest_semester);
      }
      cardsById.set(card.id, {
        ...previous,
        ...card,
        semesters: [...semesters].sort(),
        currently_rated: true,
        extracted_at: extractedAt,
        catalog_checked_at: extractedAt,
      });
    }
    liveRatedCount = liveRatedById.size;
    if (ratedCards.length === 0) {
      reachedUnrated = true;
      break;
    }
    ratedPages = result.page;
  }
  if (ratedPages % 20 < batchSize) {
    console.log(
      JSON.stringify({
        event: "course-list",
        ratedPages,
        liveRatedCount,
        totalCourses,
      }),
    );
  }
  page += batchSize;
  if (ratedPages % 10 < batchSize || reachedUnrated) {
    writeJson(checkpointPath, {
      savedAt: new Date().toISOString(),
      nextPage: page,
      totalCourses,
      ratedPages,
      cards: [...liveRatedById.values()],
    });
  }
  await sleep(delayMs);
}

const detailIds = [...cardsById.values()]
  .filter(
    (card) =>
      card.currently_rated === true &&
      (!card.icourse_course_code || !Array.isArray(card.semesters)),
  )
  .map((card) => card.id);

for (let offset = 0; offset < detailIds.length; offset += batchSize) {
  const ids = detailIds.slice(offset, offset + batchSize);
  const details = await evaluateJson(detailPageExpression(ids));
  for (const detail of details) {
    const current = cardsById.get(detail.id);
    if (!current) continue;
    cardsById.set(detail.id, { ...current, ...detail });
  }
  if (offset % 40 < batchSize) {
    console.log(
      JSON.stringify({
        event: "course-details",
        completed: Math.min(offset + batchSize, detailIds.length),
        total: detailIds.length,
      }),
    );
  }
  await sleep(delayMs);
}

const cards = [...cardsById.values()].sort((left, right) => left.id - right.id);
writeJson(cardsPath, cards);

const { ratings, details, stats } = buildRatingMaps(cards);
writeJson(path.join(outputRoot, "icourse_ratings.json"), ratings);
writeJson(path.join(outputRoot, "icourse_rating_details.json"), details);

const summary = {
  extractedAt,
  source: "https://icourse.club/",
  scope: "课程聚合信息与评分维度，不含学生点评正文",
  totalCourses,
  ratedPages,
  liveRatedCards: liveRatedCount,
  cachedCardsBefore: existingCards.length,
  cachedCardsAfter: cards.length,
  newRatedCards: cards.filter(
    (card) => card.currently_rated === true && !existingIds.has(card.id),
  ).length,
  detailPagesFetched: detailIds.length,
  ratingMatches: stats,
};
writeJson(path.join(outputRoot, "icourse_refresh_summary.json"), summary);
console.log(JSON.stringify({ event: "finished", ...summary }, null, 2));
