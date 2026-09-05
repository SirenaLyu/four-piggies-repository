// ============================================================================
// 04 · 导入 Dify 知识库（创建数据集 + 批量按文本建文档）
// ----------------------------------------------------------------------------
// 用法：node 04-import-dify.mjs [--account 公众号名] [--dataset-id xxx] [--concurrency 2]
// 输入：output/index.json（由 03 脚本生成）
//
// 行为：
// - 每个公众号一个数据集：POST /v1/datasets（同名已存在则复用，不重复创建）
// - 每篇文章一个文档：POST /v1/datasets/{id}/document/create_by_text
// - 幂等：导入记录写入 dify-import-log.json，重复运行自动跳过已导入的文档
// - 完成后把新数据集 ID 追加到项目 .env.local 的 DATASET_IDS，智能体即可检索
//
// 依赖环境变量（自动读取项目根 .env.local）：
//   DIFY_BASE_URL            Dify 服务地址（如 http://114.214.241.106）
//   DIFY_KNOWLEDGE_API_KEY   Dify 知识库 API Key（dataset- 开头）
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { IMPORT_LOG, OUTPUT_DIR, loadEnvLocal, log, mapLimit, readJson, safeName, sleep, writeJson } from "./lib.mjs";

const args = process.argv.slice(2);
const accountArg = args.find((a) => a.startsWith("--account"))?.split("=")[1];
const datasetIdArg = args.find((a) => a.startsWith("--dataset-id"))?.split("=")[1];
const concurrencyArg = args.find((a) => a.startsWith("--concurrency"))?.split("=")[1];
const CONCURRENCY = concurrencyArg ? Number(concurrencyArg) : 2;

const env = loadEnvLocal();
const BASE_URL = (env.DIFY_BASE_URL || process.env.DIFY_BASE_URL || "").replace(/\/$/, "");
const API_KEY = env.DIFY_KNOWLEDGE_API_KEY || process.env.DIFY_KNOWLEDGE_API_KEY || "";

if (!BASE_URL || !API_KEY) {
  console.error("缺少 DIFY_BASE_URL 或 DIFY_KNOWLEDGE_API_KEY（请检查项目根 .env.local）");
  process.exit(1);
}

const IMPORTED_BY_URL = new Map(readJson(IMPORT_LOG, []));

/** 调 Dify API，统一处理错误 */
async function callDify(method, urlPath, body) {
  const res = await fetch(`${BASE_URL}/v1${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

/** 创建数据集；同名已存在时复用已有 ID */
async function ensureDataset(account) {
  const name = `公众号-${account}`;
  if (datasetIdArg) return { id: datasetIdArg, name, created: false };

  // 先查已有数据集，避免 409
  try {
    const list = await callDify("GET", `/datasets?page=1&limit=100`);
    const hit = (list?.data ?? []).find((d) => d.name === name);
    if (hit) {
      log("04", `数据集「${name}」已存在，复用 ID ${hit.id}`);
      return { id: hit.id, name, created: false };
    }
  } catch {
    // 查询失败不阻塞，直接尝试创建
  }

  const created = await callDify("POST", `/datasets`, {
    name,
    indexing_technique: "high_quality", // 与现有知识库保持一致
    permission: "only_me",
  });
  log("04", `创建数据集「${name}」→ ${created.id}`);
  return { id: created.id, name, created: true };
}

/** 导入单篇文档 */
async function importDocument(datasetId, article) {
  // 来自 03 流水线的文章：日期-标题命名；外部导入（扫描模式）：直接用原文件名
  const name = article.url
    ? `${article.date || "unknown"}-${safeName(article.title || "未命名")}.md`
    : path.basename(article.file);
  const resp = await callDify("POST", `/datasets/${datasetId}/document/create_by_text`, {
    name,
    text: fs.readFileSync(article.file, "utf8"),
    indexing_technique: "high_quality", // 本 Dify 版本必填（KnowledgeConfig 校验）
    process_rule: { mode: "automatic" },
    doc_form: "text_model",
    doc_language: "Chinese",
  });
  return { url: article.url, file: article.file, documentId: resp?.document?.id ?? "" };
}

/** 幂等标识：优先用原文链接，外部导入的 md 用文件路径 */
function articleKey(article) {
  return article.url || article.file;
}

/**
 * 扫描 output/ 目录下的全部 Markdown（按子目录名作为公众号名），
 * 用于直接导入外部工具（如 wechatDownload 等）导出的 md 文件，无需先跑 03。
 */
function scanMarkdownFiles() {
  const index = [];
  if (!fs.existsSync(OUTPUT_DIR)) return index;
  for (const entry of fs.readdirSync(OUTPUT_DIR)) {
    const dir = path.join(OUTPUT_DIR, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      index.push({ account: entry, title: path.basename(file, ".md"), date: "", url: "", file: path.join(dir, file) });
    }
  }
  return index;
}

async function main() {
  let index = readJson(path.join(OUTPUT_DIR, "index.json"), []);
  if (index.length === 0) {
    index = scanMarkdownFiles();
    if (index.length > 0) {
      log("04", `未找到 index.json，扫描 output/ 目录发现 ${index.length} 个 Markdown 文件，直接按目录名分组导入`);
    }
  }
  if (index.length === 0) {
    log("04", "output/index.json 为空且 output/ 下没有 Markdown 文件，请先运行 node 03-clean-export.mjs 或放入外部工具导出的 md");
    return;
  }

  // 按公众号分组
  const groups = new Map();
  for (const article of index) {
    const key = accountArg || article.account;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(article);
  }

  for (const [account, articles] of groups) {
    const { id: datasetId } = await ensureDataset(account);

    const pending = articles.filter((a) => !IMPORTED_BY_URL.has(articleKey(a)));
    if (pending.length === 0) {
      log("04", `「${account}」全部已导入（${articles.length} 篇），跳过`);
      continue;
    }
    log("04", `「${account}」待导入 ${pending.length} 篇 → 数据集 ${datasetId}（并发 ${CONCURRENCY}）`);

    let ok = 0;
    let fail = 0;
    await mapLimit(pending, CONCURRENCY, async (article, i) => {
      await sleep(300 * (i % 4)); // 轻微错峰，避免瞬时并发过高
      try {
        const result = await importDocument(datasetId, article);
        IMPORTED_BY_URL.set(articleKey(article), { ...result, account, importedAt: new Date().toISOString() });
        writeJson(IMPORT_LOG, [...IMPORTED_BY_URL.entries()]);
        ok++;
        log("04", `✓ ${article.title?.slice(0, 40) || article.url}`);
      } catch (err) {
        fail++;
        log("04", `✗ 导入失败：${err.message} — ${article.title?.slice(0, 40)}`);
      }
    });

    log("04", `「${account}」导入完成：成功 ${ok} / 失败 ${fail}`);
  }

  // 汇总数据集映射，提示更新 DATASET_IDS
  const datasetIds = new Set();
  for (const [account] of groups) {
    try {
      const { id } = await ensureDataset(account);
      datasetIds.add(id);
    } catch {
      /* 忽略 */
    }
  }
  log("04", "全部完成！请在项目根 .env.local 的 DATASET_IDS 中追加以下数据集 ID（逗号分隔）并重启 dev 服务：");
  log("04", [...datasetIds].join(","));
  log("04", "然后到 Dify 后台「知识库 → 该数据集 → 召回测试」验证检索效果。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
