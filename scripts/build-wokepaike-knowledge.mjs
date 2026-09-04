import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sourceRoot = path.resolve(
  process.argv[2] ?? "C:/Users/hlqa0/Desktop/wokepaike/data",
);
const outputRoot = path.resolve(
  process.argv[3] ?? "generated/wokepaike-knowledge",
);

const sourceFiles = [
  "courses_undergrad_2026spring.json",
  "courses_undergrad_2026summer.json",
  "courses_undergrad_fall2026.json",
  "program_courses_2025.json",
  "program_tree_compact.json",
  "icourse_ratings.json",
  "icourse_cards_cache.json",
  "substitute_clean.json",
].concat(
  fs.existsSync(path.join(sourceRoot, "icourse_rating_details.json"))
    ? ["icourse_rating_details.json"]
    : [],
);

const courseSources = [
  {
    file: "courses_undergrad_2026spring.json",
    termKey: "2026spring",
    label: "2026 春季学期",
    output: "wokepaike_courses_2026_spring.md",
  },
  {
    file: "courses_undergrad_2026summer.json",
    termKey: "2026summer",
    label: "2026 夏季学期",
    output: "wokepaike_courses_2026_summer.md",
  },
  {
    file: "courses_undergrad_fall2026.json",
    termKey: "2026autumn",
    label: "2026 秋季学期",
    output: "wokepaike_courses_2026_autumn.md",
  },
];

const readJson = (name) =>
  JSON.parse(fs.readFileSync(path.join(sourceRoot, name), "utf8"));

const clean = (value) => {
  if (value === null || value === undefined || value === "") return "未提供";
  return String(value)
    .replaceAll("_x000d_", "")
    .replace(/\r?\n/g, "；")
    .replace(/\s+/g, " ")
    .trim();
};

const sha256 = (buffer) =>
  crypto.createHash("sha256").update(buffer).digest("hex");

const writeDocument = (name, title, blocks, category, metadata = {}) => {
  const {
    sourceDescription = "蜗壳排课工具本地数据",
    ...documentMetadata
  } = metadata;
  const content = [
    `# ${title}`,
    "",
    `数据来源：${sourceDescription}。以下每个分隔块都是独立、可检索的事实记录。`,
    "",
    blocks.join("\n\n---\n\n"),
    "",
  ].join("\n");
  const target = path.join(outputRoot, name);
  fs.writeFileSync(target, content, "utf8");
  return {
    name,
    title,
    category,
    blockCount: blocks.length,
    bytes: Buffer.byteLength(content),
    sha256: sha256(Buffer.from(content)),
    ...documentMetadata,
  };
};

fs.mkdirSync(outputRoot, { recursive: true });
for (const entry of fs.readdirSync(outputRoot, { withFileTypes: true })) {
  if (entry.isFile() && /^wokepaike_.*\.(md|json)$/.test(entry.name)) {
    fs.rmSync(path.join(outputRoot, entry.name));
  }
}

const ratings = readJson("icourse_ratings.json");
const ratingDetails = fs.existsSync(
  path.join(sourceRoot, "icourse_rating_details.json"),
)
  ? readJson("icourse_rating_details.json")
  : {};
const legacyCatalogPath = path.join(outputRoot, "legacy-course-catalog.json");
const legacyCatalog = fs.existsSync(legacyCatalogPath)
  ? JSON.parse(fs.readFileSync(legacyCatalogPath, "utf8"))
  : { records: [] };
const normalizeCourseCode = (value) => String(value ?? "").trim().toUpperCase();
const baseCourseCode = (value) => normalizeCourseCode(value).replace(/\.\d+$/, "");
const legacyByCode = new Map(
  (legacyCatalog.records ?? []).map((record) => [
    normalizeCourseCode(record.code),
    record,
  ]),
);
const documents = [];
const currentCourseCodes = new Set();

for (const source of courseSources) {
  const courses = readJson(source.file);
  const blocks = courses.map((course) => {
    const courseCode = baseCourseCode(course["课堂号"]);
    currentCourseCodes.add(courseCode);
    const catalog = legacyByCode.get(courseCode);
    const rating = ratings[`${source.termKey}|${course["课堂号"]}`];
    const ratingDetail =
      ratingDetails[`${source.termKey}|${course["课堂号"]}`] ?? null;
    const ratingText =
      typeof rating === "number"
        ? `${rating}/10（已按课程代码与教师严格匹配）`
        : "暂无可靠匹配数据";
    return [
      `## ${source.label}课程：${clean(course["课程名"])}`,
      `学期：${source.label}`,
      `课堂号：${clean(course["课堂号"])}`,
      `课程名称：${clean(course["课程名"])}`,
      `课程英文名：${catalog ? clean(catalog.en) : "目录数据未提供"}`,
      `课程目录编号：${catalog ? clean(catalog.id) : "目录数据未提供"}`,
      `目录替代关系标记：${catalog ? clean(catalog.relation) : "目录数据未提供"}`,
      `开课单位：${clean(course["开课单位"])}`,
      `授课教师：${clean(course["授课教师"])}`,
      `时间地点：${clean(course["时间地点"])}`,
      `学分：${clean(course["学分"])}`,
      `学时：${clean(course["学时"])}`,
      `学历层次：${clean(course["学历层次"])}`,
      `课堂类型：${clean(course["课堂类型"])}`,
      `课程范畴分类：${clean(course["课程范畴分类"])}`,
      `课程类型：${clean(course["课程类型"])}`,
      `授课语言：${clean(course["授课语言"])}`,
      `考核方式：${clean(course["考核方式"])}`,
      `本研同堂：${course["本研同堂"] === "1" ? "是" : "否"}`,
      `选课人数：${clean(course["选课人数"])}`,
      `限选人数：${clean(course["限选人数"])}`,
      `上课班级：${clean(course["上课班级"])}`,
      `评课社区评分：${ratingText}`,
      `评课社区评价人数：${ratingDetail?.review_count ?? "暂无可靠匹配数据"}`,
      `课程难度：${ratingDetail?.difficulty ?? "暂无可靠匹配数据"}`,
      `作业多少：${ratingDetail?.workload ?? "暂无可靠匹配数据"}`,
      `给分好坏：${ratingDetail?.grading ?? "暂无可靠匹配数据"}`,
      `收获大小：${ratingDetail?.gain ?? "暂无可靠匹配数据"}`,
      `评课社区来源页面：${ratingDetail?.source_urls?.join("、") ?? "暂无可靠匹配数据"}`,
      `评分数据提取时间：${ratingDetail?.extracted_at ?? "未提供"}`,
      "评分说明：评分来自 icourse.club 聚合数据；无可靠匹配时不得推测评分。",
    ].join("\n");
  });
  documents.push(
    writeDocument(source.output, `${source.label}本科课程信息`, blocks, "courses", {
      sourceFile: source.file,
      termKey: source.termKey,
      sourceDescription:
        "蜗壳排课工具本地课程数据，并与 icourse.club 公开聚合评分按课程代码和教师严格匹配",
    }),
  );
}

const legacyOnlyCourses = (legacyCatalog.records ?? []).filter(
  (record) => !currentCourseCodes.has(normalizeCourseCode(record.code)),
);
if (legacyOnlyCourses.length > 0) {
  const blocks = legacyOnlyCourses.map((course) =>
    [
      `## 课程目录补充：${clean(course.cn)}`,
      `课程代码：${clean(course.code)}`,
      `课程名称：${clean(course.cn)}`,
      `课程英文名：${clean(course.en)}`,
      `课程目录编号：${clean(course.id)}`,
      `目录学时：${clean(course.period)}`,
      `目录学分：${clean(course.credits)}`,
      `目录替代关系标记：${clean(course.relation)}`,
      "数据边界：该课程未出现在当前同步的 2026 春、夏、秋开课表中；这不代表课程已经停开。学期安排、教师和上课时间必须以对应学期的开课信息为准。",
    ].join("\n"),
  );
  documents.push(
    writeDocument(
      "wokepaike_course_catalog_supplement.md",
      "课程目录补充信息（未出现在 2026 三学期开课表中的课程）",
      blocks,
      "courses",
      { sourceFile: "legacy-course-catalog.json", legacyOnly: true },
    ),
  );
}

const programTree = readJson("program_tree_compact.json");
const programCourses = readJson("program_courses_2025.json");
for (const [schoolIndex, school] of programTree.entries()) {
  const blocks = [];
  for (const major of school.m ?? []) {
    for (const plan of major.p ?? []) {
      const terms = programCourses[String(plan.i)] ?? {};
      const termNames = Object.keys(terms);
      blocks.push(
        [
          `## 培养方案概览：${plan.n}`,
          `学院：${school.n}`,
          `专业或项目：${major.n}`,
          `适用年级：${plan.g} 级`,
          `方案类型：${plan.t}`,
          `培养方案编号：${plan.i}`,
          `包含学期：${termNames.join("、") || "未提供"}`,
        ].join("\n"),
      );
      for (const termName of termNames) {
        const term = terms[termName] ?? {};
        const compulsory = Array.isArray(term.compulsory)
          ? term.compulsory.map(clean)
          : [];
        const elective = Array.isArray(term.elective)
          ? term.elective.map(clean)
          : [];
        blocks.push(
          [
            `## ${plan.g} 级${major.n}培养方案：${termName}`,
            `学院：${school.n}`,
            `专业或项目：${major.n}`,
            `培养方案名称：${plan.n}`,
            `方案类型：${plan.t}`,
            `培养方案编号：${plan.i}`,
            `学期：${termName}`,
            `必修课程（${compulsory.length} 门）：${compulsory.join("、") || "无"}`,
            `选修课程（${elective.length} 门）：${elective.join("、") || "无"}`,
            "说明：@PE@ 表示体育类课程占位符，不代表具体课程名称。",
          ].join("\n"),
        );
      }
    }
  }
  const number = String(schoolIndex + 1).padStart(2, "0");
  const maxBlocksPerDocument = 300;
  const partCount = Math.ceil(blocks.length / maxBlocksPerDocument);
  for (let offset = 0; offset < blocks.length; offset += maxBlocksPerDocument) {
    const part = Math.floor(offset / maxBlocksPerDocument) + 1;
    const suffix = partCount > 1 ? `_part_${String(part).padStart(2, "0")}` : "";
    const partLabel = partCount > 1 ? `（第 ${part}/${partCount} 部分）` : "";
    documents.push(
      writeDocument(
        `wokepaike_program_${number}${suffix}.md`,
        `${school.n}培养方案信息（2023—2026 级）${partLabel}`,
        blocks.slice(offset, offset + maxBlocksPerDocument),
        "programs",
        { school: school.n, part, partCount },
      ),
    );
  }
}

const substitutions = readJson("substitute_clean.json");
const substitutionBlocks = substitutions.map((entry) => {
  const sources = (entry.s ?? []).map(
    (course) => `${clean(course.n)}（课程代码 ${clean(course.c)}）`,
  );
  const alternatives = (entry.o ?? []).map(
    (course) => `${clean(course.n)}（课程代码 ${clean(course.c)}）`,
  );
  return [
    `## 课程替代关系：${sources.join("、")}`,
    `源课程：${sources.join("、")}`,
    `可替代课程：${alternatives.join("、")}`,
    "说明：该记录表示培养方案中的课程替代关系；具体认定仍以学校最新规定为准。",
  ].join("\n");
});
documents.push(
  writeDocument(
    "wokepaike_program_substitutions.md",
    "培养方案课程替代关系",
    substitutionBlocks,
    "programs",
    { sourceFile: "substitute_clean.json" },
  ),
);

const reviewCards = readJson("icourse_cards_cache.json");
const reviewChunkSize = 500;
for (let offset = 0; offset < reviewCards.length; offset += reviewChunkSize) {
  const slice = reviewCards.slice(offset, offset + reviewChunkSize);
  const blocks = slice.map((card) => {
    const score =
      typeof card.score === "number" ? `${card.score}/10` : "暂无评分";
    return [
      `## 评课社区课程：${clean(card.name)} — ${clean(card.teachers_raw)}`,
      `课程名称：${clean(card.name)}`,
      `授课教师：${clean(card.teachers_raw)}`,
      `评课社区评分：${score}`,
      `当前评分状态：${card.currently_rated === true ? "有公开聚合评分" : "暂无公开聚合评分"}`,
      `评价人数：${typeof card.review_count === "number" ? card.review_count : "未提供"}`,
      `课程难度：${clean(card.difficulty)}`,
      `作业多少：${clean(card.workload)}`,
      `给分好坏：${clean(card.grading)}`,
      `收获大小：${clean(card.gain)}`,
      `评课社区课程编号：${clean(card.id)}`,
      `评课社区课程代码：${clean(card.icourse_course_code)}`,
      `收录学期：${Array.isArray(card.semesters) ? card.semesters.map(clean).join("、") : "未提供"}`,
      `来源页面：${clean(card.source_url ?? `https://icourse.club/course/${encodeURIComponent(card.id)}/`)}`,
      `数据提取时间：${clean(card.extracted_at)}`,
      `课程目录检查时间：${clean(card.catalog_checked_at)}`,
      "数据边界：此数据仅含聚合评分和开课学期，不含学生文字评价；不得据此编造评价观点。",
    ].join("\n");
  });
  const number = String(offset / reviewChunkSize + 1).padStart(2, "0");
  documents.push(
    writeDocument(
      `wokepaike_reviews_${number}.md`,
      `评课社区课程评分汇总（第 ${offset + 1}—${offset + slice.length} 条）`,
      blocks,
      "reviews",
      {
        sourceRange: [offset + 1, offset + slice.length],
        sourceDescription:
          "icourse.club 公开课程聚合页；仅保留课程、教师、课程号、学期、聚合评分和评价维度，不含学生点评正文",
      },
    ),
  );
}

const sources = sourceFiles.map((name) => {
  const buffer = fs.readFileSync(path.join(sourceRoot, name));
  return { name, bytes: buffer.length, sha256: sha256(buffer) };
});
if (fs.existsSync(legacyCatalogPath)) {
  const buffer = fs.readFileSync(legacyCatalogPath);
  sources.push({
    name: "legacy-course-catalog.json",
    bytes: buffer.length,
    sha256: sha256(buffer),
  });
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceRoot,
  delimiter: "\\n\\n---\\n\\n",
  sourceFiles: sources,
  totals: {
    documents: documents.length,
    blocks: documents.reduce((total, document) => total + document.blockCount, 0),
    bytes: documents.reduce((total, document) => total + document.bytes, 0),
    byCategory: Object.fromEntries(
      ["courses", "programs", "reviews"].map((category) => [
        category,
        {
          documents: documents.filter((item) => item.category === category).length,
          blocks: documents
            .filter((item) => item.category === category)
            .reduce((total, item) => total + item.blockCount, 0),
        },
      ]),
    ),
  },
  documents,
};
fs.writeFileSync(
  path.join(outputRoot, "wokepaike_manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify(manifest.totals, null, 2));
