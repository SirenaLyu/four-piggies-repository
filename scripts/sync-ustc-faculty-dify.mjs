import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ACHIEVEMENT_CATEGORIES,
  decodeEntities,
  parseAchievementPage,
  parseFacultyProfile,
  teacherRecordToMarkdown,
} from "./ustc-faculty-lib.mjs";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());

const FACULTY_ORIGIN = "https://faculty.ustc.edu.cn";
const DIRECTORY_ENDPOINT = `${FACULTY_ORIGIN}/system/resource/tsites/advancesearch.jsp`;
const DEFAULT_DATASET_ID = "975e7edb-4979-4cfe-95e2-9cc2f782488d";
const DOCUMENT_PREFIX = "ustc-faculty-";

function parseArgs(argv) {
  const args = {
    outputDir: "generated/ustc-faculty",
    envFile: ".env.local",
    upload: false,
    refresh: false,
    retryFailed: false,
    profileLimit: 0,
    achievementLimit: 200,
    concurrency: 4,
    maxAchievementItems: 5,
    reuseGenerated: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const nextNumber = (name) => {
      const parsed = Number(argv[++index]);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} 必须是非负整数`);
      return parsed;
    };
    if (value === "--upload") args.upload = true;
    else if (value === "--refresh") args.refresh = true;
    else if (value === "--retry-failed") args.retryFailed = true;
    else if (value === "--reuse-generated") args.reuseGenerated = true;
    else if (value === "--output-dir") args.outputDir = argv[++index];
    else if (value === "--env-file") args.envFile = argv[++index];
    else if (value === "--profile-limit") args.profileLimit = nextNumber(value);
    else if (value === "--achievement-limit") args.achievementLimit = nextNumber(value);
    else if (value === "--concurrency") args.concurrency = nextNumber(value);
    else if (value === "--max-achievement-items") args.maxAchievementItems = nextNumber(value);
    else if (value === "--help" || value === "-h") {
      console.log([
        "用法: node scripts/sync-ustc-faculty-dify.mjs [选项]",
        "",
        "  --upload                    上传到校园信息知识库；省略时只生成本地资料",
        "  --refresh                   原位更新已存在的教师文档；默认只补缺失文档",
        "  --retry-failed              只重试 Dify 中 error/paused 的教师文档",
        "  --reuse-generated           跳过官网采集，直接复用现有 manifest 续传",
        "  --profile-limit <n>         只扩展前 n 个教师主页；0 表示全部（默认）",
        "  --achievement-limit <n>     按主页访问量扩展前 n 位教师的成果首屏（默认 200）",
        "  --concurrency <n>           官网并发请求数（默认 4，最高 8）",
        "  --max-achievement-items <n> 每类成果最多保留条数（默认 5）",
        "  --output-dir <path>         生成物目录（默认 generated/ustc-faculty）",
        "  --env-file <path>           Dify 环境变量文件（默认 .env.local）",
      ].join("\n"));
      process.exit(0);
    } else throw new Error(`未知参数: ${value}`);
  }
  if (args.concurrency < 1 || args.concurrency > 8) {
    throw new Error("--concurrency 必须在 1 到 8 之间");
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
          "User-Agent": "USTC-Campus-Knowledge-Sync/1.0 (+public faculty data)",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 1_000);
    }
  }
  throw lastError;
}

async function readEnvFile(filePath) {
  const text = await readFile(filePath, "utf8");
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

function clean(value) {
  return decodeEntities(String(value ?? ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTeacher(raw) {
  let rawUrl = String(raw.url ?? "").trim();
  if (/^[\w.-]+\.ustc\.edu\.cn(?:\/|$)/i.test(rawUrl)) rawUrl = `https://${rawUrl}`;
  const parsedUrl = new URL(rawUrl, FACULTY_ORIGIN);
  if (parsedUrl.hostname === "faculty.ustc.edu.cn") parsedUrl.protocol = "https:";
  const url = parsedUrl.toString();
  return {
    sourceId: String(raw.a),
    name: clean(raw.showName || raw.teacherName || raw.name),
    ename: clean(raw.ename),
    college: clean(raw.collegeName || raw.unit),
    unit: clean(raw.unit),
    title: clean(raw.prorank),
    tutorQualifications: [clean(raw.doctorTutor), clean(raw.gtutor)].filter(Boolean),
    clickTimes: Number(raw.clickTimes) || 0,
    url,
  };
}

function isOfficialUstcUrl(value) {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === "ustc.edu.cn" || hostname.endsWith(".ustc.edu.cn");
}

function directoryUrl(pageIndex) {
  const query = new URLSearchParams({
    collegeid: "",
    disciplineid: "0",
    enrollid: "0",
    pageindex: String(pageIndex),
    pagesize: "100",
    rankid: "",
    degreeid: "0",
    honorid: "",
    pinyin: "",
    profilelen: "100",
    teacherName: "",
    searchDirection: "",
    viewmode: "8",
    viewid: "1066239",
    siteOwner: "2006639312",
    viewUniqueId: "1066239",
    showlang: "zh_CN",
    ispreview: "false",
    basenum: "0",
    ellipsis: "...",
    alignright: "false",
    productType: "0",
    tutorType: "",
  });
  return `${DIRECTORY_ENDPOINT}?${query}`;
}

async function fetchDirectory(concurrency) {
  const first = JSON.parse(await fetchText(directoryUrl(1)));
  const remainingPageNumbers = Array.from(
    { length: Math.max(0, first.totalpage - 1) },
    (_, index) => index + 2,
  );
  const remainingPages = await mapLimit(
    remainingPageNumbers,
    Math.min(concurrency, 4),
    async (page) => JSON.parse(await fetchText(directoryUrl(page))),
  );
  const pages = [first, ...remainingPages];
  const byId = new Map();
  for (const raw of pages.flatMap((page) => page.teacherData ?? [])) {
    const teacher = normalizeTeacher(raw);
    if (teacher.name && teacher.url) byId.set(teacher.sourceId || teacher.url, teacher);
  }
  const teachers = [...byId.values()];
  if (teachers.length < first.totalnum * 0.98) {
    throw new Error(`教师目录仅取得 ${teachers.length}/${first.totalnum} 条，拒绝生成不完整快照`);
  }
  return { total: first.totalnum, teachers };
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
      await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function fetchCached(url, cacheDir, cacheName) {
  const cachePath = path.join(cacheDir, cacheName);
  try {
    return await readFile(cachePath, "utf8");
  } catch {
    const html = await fetchText(url);
    await writeFile(cachePath, html, "utf8");
    return html;
  }
}

async function enrichProfiles(teachers, args, outputDir) {
  const cacheDir = path.join(outputDir, ".cache", "profiles");
  await mkdir(cacheDir, { recursive: true });
  const targets = args.profileLimit > 0 ? teachers.slice(0, args.profileLimit) : teachers;
  let completed = 0;
  const failures = [];
  await mapLimit(targets, args.concurrency, async (teacher) => {
    try {
      if (!isOfficialUstcUrl(teacher.url)) {
        throw new Error("教师目录链接指向非 ustc.edu.cn 站点，未读取扩展信息");
      }
      const html = await fetchCached(teacher.url, cacheDir, `${teacher.sourceId}.html`);
      teacher.profile = parseFacultyProfile(html, teacher.url);
      teacher.profileFetchFailed = false;
    } catch (error) {
      failures.push({ name: teacher.name, url: teacher.url, error: String(error?.message ?? error) });
      teacher.profile = { researchDirections: [], achievementPages: {} };
      teacher.profileFetchFailed = true;
    }
    completed += 1;
    if (completed % 100 === 0 || completed === targets.length) {
      console.log(JSON.stringify({ event: "profiles", completed, total: targets.length, failures: failures.length }));
    }
  });
  return failures;
}

async function enrichAchievements(teachers, args, outputDir) {
  const cacheDir = path.join(outputDir, ".cache", "achievements");
  await mkdir(cacheDir, { recursive: true });
  const targets = teachers
    .filter((teacher) => Object.keys(teacher.profile?.achievementPages ?? {}).length > 0)
    .sort((left, right) => right.clickTimes - left.clickTimes)
    .slice(0, args.achievementLimit);
  const failures = [];
  let completed = 0;
  await mapLimit(targets, Math.min(args.concurrency, 3), async (teacher) => {
    teacher.achievements = {};
    for (const [key, url] of Object.entries(teacher.profile.achievementPages)) {
      try {
        const cacheKey = createHash("sha256").update(url).digest("hex").slice(0, 16);
        const html = await fetchCached(url, cacheDir, `${cacheKey}.html`);
        const result = parseAchievementPage(
          html,
          ACHIEVEMENT_CATEGORIES[key].label,
          args.maxAchievementItems,
        );
        if (result.total > 0 || result.items.length > 0) teacher.achievements[key] = result;
      } catch (error) {
        failures.push({ name: teacher.name, category: key, url, error: String(error?.message ?? error) });
      }
    }
    completed += 1;
    if (completed % 25 === 0 || completed === targets.length) {
      console.log(JSON.stringify({ event: "achievements", completed, total: targets.length, failures: failures.length }));
    }
  });
  return { failures, enriched: targets.length };
}

function safeFilePart(value) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

async function buildDocuments(teachers, outputDir, sourceMeta) {
  const originalGroups = new Map();
  for (const teacher of teachers) {
    const key = teacher.college || "未标注学院";
    if (!originalGroups.has(key)) originalGroups.set(key, []);
    originalGroups.get(key).push(teacher);
  }
  const byCollege = new Map();
  for (const [college, group] of originalGroups) {
    const key = group.length >= 20 ? college : "其他学院与机构";
    if (!byCollege.has(key)) byCollege.set(key, []);
    byCollege.get(key).push(...group);
  }
  const documents = [];
  const colleges = [...byCollege.keys()].sort((a, b) => a.localeCompare(b, "zh-CN"));
  for (const college of colleges) {
    const collegeTeachers = byCollege.get(college).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    for (let offset = 0; offset < collegeTeachers.length; offset += 200) {
      const batch = collegeTeachers.slice(offset, offset + 200);
      const part = Math.floor(offset / 200) + 1;
      const name = `${DOCUMENT_PREFIX}${safeFilePart(college)}-${String(part).padStart(2, "0")}.md`;
      const header = [
        `# 中国科学技术大学教师信息：${college}${collegeTeachers.length > 200 ? `（第 ${part} 部分）` : ""}`,
        "",
        `数据来源：中国科学技术大学教师个人主页（${FACULTY_ORIGIN}/）。`,
        `目录采集时间：${sourceMeta.generatedAt}`,
        "说明：字段由教师本人维护的官方主页公开内容整理；未填写不代表不存在。成果条目仅为对应栏目首屏的代表性条目，完整信息以原主页为准。",
        "",
      ].join("\n");
      const content = `${header}\n${batch.map(teacherRecordToMarkdown).join("\n\n---\n\n")}\n`;
      await writeFile(path.join(outputDir, name), content, "utf8");
      documents.push({ name, college, teacherCount: batch.length, bytes: Buffer.byteLength(content) });
    }
  }
  return documents;
}

async function difyRequest(baseUrl, apiKey, endpoint, init = {}) {
  const method = init.method ?? "GET";
  const attempts = method === "GET" ? 4 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}${endpoint}`, {
        ...init,
        headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(120_000),
      });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 1000) }; }
      if (response.ok) return data;
      const error = new Error(`Dify API ${response.status}: ${data.message ?? data.code ?? "未知错误"}`);
      if (method !== "GET" || (response.status < 500 && response.status !== 429)) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (method !== "GET") throw error;
    }
    if (attempt < attempts) {
      const delayMs = attempt * 2_000;
      console.warn(JSON.stringify({ event: "dify-read-retry", endpoint, attempt, delayMs, error: String(lastError?.message ?? lastError) }));
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function listDocuments(baseUrl, apiKey, datasetId) {
  const documents = [];
  for (let page = 1; ; page += 1) {
    const result = await difyRequest(baseUrl, apiKey, `/v1/datasets/${datasetId}/documents?page=${page}&limit=100`);
    documents.push(...(result.data ?? []));
    if (!result.has_more) return documents;
  }
}

function compactDocument(document) {
  return {
    id: document.id,
    name: document.name,
    indexing_status: document.indexing_status,
    word_count: document.word_count,
    segments_count: document.segments_count,
    error: document.error ?? null,
  };
}

async function writeDifyDocument(baseUrl, apiKey, datasetId, document, outputDir, existingId) {
  const bytes = await readFile(path.join(outputDir, document.name));
  const data = {
    ...(existingId ? { name: document.name } : {}),
    indexing_technique: "high_quality",
    doc_form: "text_model",
    doc_language: "Chinese",
    process_rule: {
      mode: "custom",
      rules: {
        pre_processing_rules: [
          { id: "remove_extra_spaces", enabled: false },
          { id: "remove_urls_emails", enabled: false },
        ],
        segmentation: { separator: "\n\n---\n\n", max_tokens: 1024, chunk_overlap: 80 },
      },
    },
  };
  const form = new FormData();
  form.append("data", JSON.stringify(data));
  form.append("file", new Blob([bytes], { type: "text/markdown" }), document.name);
  const endpoint = existingId
    ? `/v1/datasets/${datasetId}/documents/${existingId}/update-by-file`
    : `/v1/datasets/${datasetId}/document/create-by-file`;
  return difyRequest(baseUrl, apiKey, endpoint, { method: "POST", body: form });
}

async function waitForDocument(baseUrl, apiKey, datasetId, documentId, name) {
  const deadline = Date.now() + 20 * 60_000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const document = await difyRequest(baseUrl, apiKey, `/v1/datasets/${datasetId}/documents/${documentId}`);
    if (document.indexing_status !== lastStatus) {
      console.log(JSON.stringify({ event: "indexing", name, status: document.indexing_status, error: document.error ?? null }));
      lastStatus = document.indexing_status;
    }
    if (document.indexing_status === "completed") return document;
    if (["error", "paused"].includes(document.indexing_status)) {
      throw new Error(`${name} 索引失败：${document.error ?? document.indexing_status}`);
    }
    await sleep(5_000);
  }
  throw new Error(`${name} 在 20 分钟内未完成索引`);
}

async function syncToDify(args, outputDir, manifest) {
  const fileEnv = await readEnvFile(args.envFile);
  const baseUrl = process.env.DIFY_BASE_URL || fileEnv.DIFY_BASE_URL;
  const apiKey = process.env.DIFY_KNOWLEDGE_API_KEY || fileEnv.DIFY_KNOWLEDGE_API_KEY;
  const datasetId = process.env.USTC_FACULTY_DIFY_DATASET_ID || fileEnv.USTC_FACULTY_DIFY_DATASET_ID || DEFAULT_DATASET_ID;
  if (!baseUrl || !apiKey) throw new Error("缺少 DIFY_BASE_URL 或 DIFY_KNOWLEDGE_API_KEY");

  const before = await listDocuments(baseUrl, apiKey, datasetId);
  await writeFile(path.join(outputDir, "remote-before.json"), `${JSON.stringify({ capturedAt: new Date().toISOString(), datasetId, documents: before.map(compactDocument) }, null, 2)}\n`);
  const existingByName = new Map(before.map((document) => [document.name, document]));
  const refreshProgressPath = path.join(outputDir, "refresh-progress.json");
  let refreshCompletedNames = new Set();
  if (args.refresh) {
    try {
      const progress = JSON.parse(await readFile(refreshProgressPath, "utf8"));
      if (progress.manifestGeneratedAt === manifest.generatedAt) {
        refreshCompletedNames = new Set(progress.completedNames ?? []);
      }
    } catch {
      // A new manifest or the first refresh starts with an empty checkpoint.
    }
  }
  const missing = manifest.documents.filter((document) => !existingByName.has(document.name));
  const refresh = manifest.documents.filter((document) => {
    const existing = existingByName.get(document.name);
    if (!existing) return false;
    if (args.retryFailed && ["error", "paused"].includes(existing.indexing_status)) return true;
    return args.refresh && !refreshCompletedNames.has(document.name);
  });
  console.log(JSON.stringify({ event: "dify-plan", datasetId, expected: manifest.documents.length, missing: missing.length, refresh: refresh.length, unmanaged: before.filter((document) => !document.name.startsWith(DOCUMENT_PREFIX)).length }));

  const results = [];
  for (const [index, document] of [...refresh, ...missing].entries()) {
    let existing = existingByName.get(document.name);
    const recreatingFailed = Boolean(
      args.retryFailed && existing && ["error", "paused"].includes(existing.indexing_status),
    );
    if (recreatingFailed) {
      await difyRequest(
        baseUrl,
        apiKey,
        `/v1/datasets/${datasetId}/documents/${existing.id}`,
        { method: "DELETE" },
      );
      console.log(JSON.stringify({ event: "removed-failed", name: document.name, id: existing.id }));
      existing = undefined;
    }
    const result = await writeDifyDocument(baseUrl, apiKey, datasetId, document, outputDir, existing?.id);
    const documentId = result.document?.id ?? existing?.id;
    if (!documentId) throw new Error(`${document.name} 上传响应缺少文档 ID`);
    console.log(JSON.stringify({ event: existing ? "updated" : "uploaded", progress: `${index + 1}/${refresh.length + missing.length}`, name: document.name, id: documentId }));
    try {
      await waitForDocument(baseUrl, apiKey, datasetId, documentId, document.name);
      if (args.refresh) {
        refreshCompletedNames.add(document.name);
        await writeFile(
          refreshProgressPath,
          `${JSON.stringify({ manifestGeneratedAt: manifest.generatedAt, completedNames: [...refreshCompletedNames].sort() }, null, 2)}\n`,
        );
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "indexing-failed", name: document.name, id: documentId, error: String(error?.message ?? error) }));
      results.push({ name: document.name, id: documentId, action: "indexing-failed" });
      continue;
    }
    results.push({
      name: document.name,
      id: documentId,
      action: recreatingFailed ? "recreate-failed" : existing ? "update" : "create",
    });
  }

  const after = await listDocuments(baseUrl, apiKey, datasetId);
  const managedNames = new Set(manifest.documents.map((document) => document.name));
  const managed = after.filter((document) => managedNames.has(document.name));
  const summary = {
    event: "finished",
    datasetId,
    expected: manifest.documents.length,
    completed: managed.filter((document) => document.indexing_status === "completed").length,
    failed: managed.filter((document) => ["error", "paused"].includes(document.indexing_status)).map(compactDocument),
    obsoleteManaged: after.filter((document) => document.name.startsWith(DOCUMENT_PREFIX) && !managedNames.has(document.name)).map(compactDocument),
    results,
  };
  await writeFile(path.join(outputDir, "remote-after.json"), `${JSON.stringify({ capturedAt: new Date().toISOString(), datasetId, documents: after.map(compactDocument) }, null, 2)}\n`);
  await writeFile(path.join(outputDir, "sync-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
  if (summary.completed !== manifest.documents.length || summary.failed.length > 0) process.exitCode = 2;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(args.outputDir);
  await mkdir(outputDir, { recursive: true });
  if (args.reuseGenerated) {
    const manifest = JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8"));
    console.log(JSON.stringify({ event: "reuse-generated", outputDir, teacherCount: manifest.teacherCount, documents: manifest.documents.length }));
    if (args.upload) await syncToDify(args, outputDir, manifest);
    else console.log("未使用 --upload，未写入 Dify。");
    return;
  }
  console.log(JSON.stringify({ event: "directory", source: DIRECTORY_ENDPOINT }));
  const directory = await fetchDirectory(args.concurrency);
  const teachers = directory.teachers.sort((left, right) =>
    left.college.localeCompare(right.college, "zh-CN") || left.name.localeCompare(right.name, "zh-CN"),
  );
  const profileFailures = await enrichProfiles(teachers, args, outputDir);
  const achievementResult = args.achievementLimit > 0
    ? await enrichAchievements(teachers, args, outputDir)
    : { failures: [], enriched: 0 };
  const generatedAt = new Date().toISOString();
  const documents = await buildDocuments(teachers, outputDir, { generatedAt });
  const manifest = {
    generatedAt,
    source: {
      name: "中国科学技术大学教师个人主页",
      origin: FACULTY_ORIGIN,
      directoryEndpoint: DIRECTORY_ENDPOINT,
    },
    directoryReported: directory.total,
    teacherCount: teachers.length,
    profileEnriched: teachers.filter((teacher) => teacher.profile && !teacher.profileFetchFailed).length,
    researchDirectionCoverage: teachers.filter((teacher) => teacher.profile?.researchDirections?.length > 0).length,
    achievementEnriched: achievementResult.enriched,
    profileFailures,
    achievementFailures: achievementResult.failures,
    documents,
  };
  await writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(outputDir, "teachers.json"), `${JSON.stringify(teachers, null, 2)}\n`);
  console.log(JSON.stringify({ event: "generated", outputDir, teacherCount: manifest.teacherCount, profileEnriched: manifest.profileEnriched, researchDirectionCoverage: manifest.researchDirectionCoverage, achievementEnriched: manifest.achievementEnriched, documents: documents.length, profileFailures: profileFailures.length, achievementFailures: achievementResult.failures.length }));
  if (args.upload) await syncToDify(args, outputDir, manifest);
  else console.log("未使用 --upload，未写入 Dify。");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
