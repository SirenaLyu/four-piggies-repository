import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ACCOUNT_NAME = "科大基建";
const ACCOUNT_USERNAME = "gh_390f41ff9360";
const DATASET_NAME = "公众号-科大基建";
const DEFAULT_URLS_FILE = path.join("scripts", "keda-jijian-urls.txt");
const DEFAULT_OUTPUT_DIR = path.join("data", "keda-jijian");

function parseArgs(argv) {
  const args = {
    envFile: ".env.local",
    urlsFile: DEFAULT_URLS_FILE,
    outputDir: DEFAULT_OUTPUT_DIR,
    upload: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--upload") {
      args.upload = true;
    } else if (value === "--env-file") {
      args.envFile = argv[++index];
    } else if (value === "--urls-file") {
      args.urlsFile = argv[++index];
    } else if (value === "--output-dir") {
      args.outputDir = argv[++index];
    } else if (value === "--help" || value === "-h") {
      console.log(
        [
          "用法: node scripts/sync-wechat-keda-jijian.mjs [选项]",
          "",
          "  --urls-file <path>   公众号文章链接清单",
          "  --output-dir <path>  Markdown 和抓取清单输出目录",
          "  --env-file <path>    含 DIFY_BASE_URL、DIFY_KNOWLEDGE_API_KEY 的环境文件",
          "  --upload             创建/复用 Dify 数据集并增量上传；省略时仅抓取",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${value}`);
    }
  }

  return args;
}

function decodeEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    middot: "·",
    nbsp: " ",
    quot: '"',
    rdquo: "”",
    rsquo: "’",
  };

  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function decodeJsString(value) {
  return value.replace(
    /\\x([0-9a-f]{2})|\\u([0-9a-f]{4})|\\([\\'"nrtbfv])/gi,
    (match, hex, unicode, escaped) => {
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
      if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
      const escapes = {
        "\\": "\\",
        "'": "'",
        '"': '"',
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        v: "\v",
      };
      return escapes[escaped] ?? match;
    },
  );
}

function stripHtml(html) {
  return decodeEntities(
    html
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<(script|style|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(p|section|div|li|h[1-6]|tr|blockquote)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " "),
  )
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function matchFirst(html, patterns, fieldName) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeEntities(match[1]);
  }
  throw new Error(`文章缺少 ${fieldName}`);
}

function normalizeArticleUrl(sourceUrl) {
  const canonicalUrl = new URL(sourceUrl);
  canonicalUrl.protocol = "https:";
  canonicalUrl.hash = "";

  if (/^\/s\/[A-Za-z0-9_-]+$/.test(canonicalUrl.pathname)) {
    canonicalUrl.search = "";
  } else if (canonicalUrl.pathname === "/s") {
    const stableParams = ["__biz", "mid", "idx", "sn", "chksm"];
    const values = stableParams
      .map((key) => [key, canonicalUrl.searchParams.get(key)])
      .filter(([, value]) => value);
    canonicalUrl.search = "";
    for (const [key, value] of values) canonicalUrl.searchParams.set(key, value);
  }

  return canonicalUrl.toString();
}

function extractPreviousArticleUrl(html) {
  const match = html.match(/pre_article_link:\s*'([^']+)'/i);
  if (!match) return null;
  const decoded = decodeEntities(decodeJsString(match[1]));
  if (!decoded.includes("mp.weixin.qq.com/s")) return null;
  return normalizeArticleUrl(decoded);
}

function parseArticle(html, sourceUrl) {
  const title = matchFirst(
    html,
    [
      /<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i,
      /var msg_title = ['"]([^'"]+)['"]/i,
    ],
    "标题",
  );
  const nickname = matchFirst(
    html,
    [/var nickname = htmlDecode\(["']([^"']+)["']\)/i],
    "公众号名称",
  );
  const username = matchFirst(
    html,
    [/var user_name = ["']([^"']+)["']/i],
    "公众号 ID",
  );
  const timestamp = Number(
    matchFirst(html, [/var create_time = ["'](\d+)["']/i], "发布时间"),
  );
  const contentMatch = html.match(
    /content_noencode:\s*'((?:\\.|[^'])*)'/s,
  );
  if (!contentMatch) throw new Error("文章缺少可解析的正文");

  if (nickname !== ACCOUNT_NAME || username !== ACCOUNT_USERNAME) {
    throw new Error(
      `账号校验失败，期望 ${ACCOUNT_NAME}/${ACCOUNT_USERNAME}，实际 ${nickname}/${username}`,
    );
  }

  const body = stripHtml(decodeJsString(contentMatch[1]));
  if (body.length < 100) throw new Error(`正文过短（${body.length} 字符）`);

  const publishedAt = new Date(timestamp * 1000);
  const publishedDate = publishedAt.toISOString().slice(0, 10);
  const canonicalUrl = normalizeArticleUrl(sourceUrl);
  const sourceHash = createHash("sha256")
    .update(canonicalUrl)
    .digest("hex")
    .slice(0, 12);

  return {
    accountName: nickname,
    accountUsername: username,
    body,
    publishedAt: publishedAt.toISOString(),
    publishedDate,
    sourceHash,
    sourceUrl: canonicalUrl,
    title,
  };
}

function safeFileName(value) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 100);
}

function articleToMarkdown(article) {
  return [
    `# ${article.title}`,
    "",
    `公众号：${article.accountName}`,
    `公众号 ID：${article.accountUsername}`,
    `发布日期：${article.publishedDate}`,
    `原文链接：${article.sourceUrl}`,
    `来源标识：${article.sourceHash}`,
    "",
    "## 正文",
    "",
    article.body,
    "",
  ].join("\n");
}

async function loadUrls(filePath) {
  const text = await readFile(filePath, "utf8");
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    ),
  ];
}

async function fetchArticle(url) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "mp.weixin.qq.com") {
    throw new Error(`不支持的文章地址: ${url}`);
  }

  const userAgents = [
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Mobile MicroMessenger/8.0.49",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile MicroMessenger/8.0.49",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  ];
  let lastError;

  for (let attempt = 0; attempt < userAgents.length; attempt += 1) {
    try {
      const attemptUrl = new URL(parsedUrl);
      attemptUrl.searchParams.set("nwr_flag", "1");
      attemptUrl.searchParams.set("sync_attempt", String(attempt + 1));
      const response = await fetch(attemptUrl, {
        headers: { "User-Agent": userAgents[attempt] },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (!html.includes('property="og:title"') || !html.includes("var nickname")) {
        throw new Error("微信返回了验证页而不是文章正文");
      }
      return html;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < userAgents.length) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
      }
    }
  }

  throw new Error(
    `抓取失败: ${url}（${lastError instanceof Error ? lastError.message : "未知错误"}）`,
  );
}

async function fetchArticleWithCache(url, outputDir) {
  const cacheDir = path.join(outputDir, ".cache");
  const cacheKey = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const cachePath = path.join(cacheDir, `${cacheKey}.html`);

  try {
    const html = await fetchArticle(url);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath, html, "utf8");
    return html;
  } catch (networkError) {
    try {
      const cachedHtml = await readFile(cachePath, "utf8");
      console.warn(`微信暂时限流，使用已核验缓存: ${url}`);
      return cachedHtml;
    } catch {
      throw networkError;
    }
  }
}

async function readEnvFile(filePath) {
  const text = await readFile(filePath, "utf8");
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

async function difyRequest(baseUrl, apiKey, endpoint, options = {}) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!response.ok) {
    throw new Error(
      `Dify API ${response.status}: ${data.message ?? data.code ?? "未知错误"}`,
    );
  }
  return data;
}

async function findOrCreateDataset(baseUrl, apiKey) {
  const listing = await difyRequest(baseUrl, apiKey, "/v1/datasets?page=1&limit=100");
  const matches = (listing.data ?? []).filter((dataset) => dataset.name === DATASET_NAME);
  if (matches.length > 1) throw new Error(`发现多个同名知识库: ${DATASET_NAME}`);
  if (matches.length === 1) return matches[0];

  return difyRequest(baseUrl, apiKey, "/v1/datasets", {
    method: "POST",
    body: JSON.stringify({
      name: DATASET_NAME,
      description:
        "中国科学技术大学“科大基建”微信公众号公开文章，包含校园维修、缴费、基建服务与使用指南。",
      permission: "all_team_members",
      indexing_technique: "high_quality",
      provider: "vendor",
      embedding_model: "BAAI/bge-m3",
      embedding_model_provider: "langgenius/siliconflow/siliconflow",
    }),
  });
}

function documentIdentity(name) {
  return name.replace(/-[0-9a-f]{12}$/i, "").replace(/\s+/g, " ").trim();
}

async function listDocumentNames(baseUrl, apiKey, datasetId) {
  const names = new Set();
  let page = 1;
  while (true) {
    const listing = await difyRequest(
      baseUrl,
      apiKey,
      `/v1/datasets/${datasetId}/documents?page=${page}&limit=100`,
    );
    for (const document of listing.data ?? []) names.add(document.name);
    if (!listing.has_more) break;
    page += 1;
  }
  return names;
}

async function uploadArticles(baseUrl, apiKey, articles) {
  const dataset = await findOrCreateDataset(baseUrl, apiKey);
  const existingNames = await listDocumentNames(baseUrl, apiKey, dataset.id);
  const existingIdentities = new Set([...existingNames].map(documentIdentity));
  let uploaded = 0;
  let skipped = 0;

  for (const article of articles) {
    const normalizedTitle = article.title.replace(/\s+/g, " ").trim();
    const name = `微信-${article.accountName}-${article.publishedDate}-${normalizedTitle}-${article.sourceHash}`;
    const identity = documentIdentity(name);
    if (existingNames.has(name) || existingIdentities.has(identity)) {
      console.log(`跳过已存在文档: ${name}`);
      skipped += 1;
      continue;
    }
    await difyRequest(baseUrl, apiKey, `/v1/datasets/${dataset.id}/document/create-by-text`, {
      method: "POST",
      body: JSON.stringify({
        name,
        text: articleToMarkdown(article),
        indexing_technique: "high_quality",
        process_rule: { mode: "automatic" },
        doc_form: "text_model",
        doc_language: "Chinese",
      }),
    });
    console.log(`已上传: ${name}`);
    existingNames.add(name);
    existingIdentities.add(identity);
    uploaded += 1;
  }

  return { datasetId: dataset.id, uploaded, skipped };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const urls = await loadUrls(args.urlsFile);
  if (urls.length === 0) throw new Error("链接清单为空");
  await mkdir(args.outputDir, { recursive: true });

  const articles = [];
  const failures = [];
  const queue = [...urls];
  const seenUrls = new Set();
  while (queue.length > 0) {
    const url = normalizeArticleUrl(queue.shift());
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    console.log(`抓取: ${url}`);
    let html;
    let article;
    try {
      html = await fetchArticleWithCache(url, args.outputDir);
      article = parseArticle(html, url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ url, message });
      console.warn(message);
      continue;
    }
    const fileName = `${article.publishedDate}-${safeFileName(article.title)}-${article.sourceHash}.md`;
    await writeFile(path.join(args.outputDir, fileName), articleToMarkdown(article), "utf8");
    articles.push(article);
    console.log(`已核验: ${article.title}（${article.body.length} 字符）`);

    const previousUrl = extractPreviousArticleUrl(html);
    if (previousUrl && !seenUrls.has(previousUrl)) {
      console.log(`发现上一篇: ${previousUrl}`);
      queue.push(previousUrl);
    }
  }

  await writeFile(
    path.join(args.outputDir, "discovered-urls.txt"),
    `${articles.map((article) => article.sourceUrl).join("\n")}\n`,
    "utf8",
  );

  await writeFile(
    path.join(args.outputDir, "failed-urls.json"),
    `${JSON.stringify(failures, null, 2)}\n`,
    "utf8",
  );

  await writeFile(
    path.join(args.outputDir, "manifest.json"),
    `${JSON.stringify(articles.map(({ body, ...article }) => ({ ...article, characterCount: body.length })), null, 2)}\n`,
    "utf8",
  );

  if (!args.upload) {
    console.log(`抓取完成，共 ${articles.length} 篇；未使用 --upload，因此没有写入 Dify。`);
    return;
  }

  const env = await readEnvFile(args.envFile);
  const baseUrl = process.env.DIFY_BASE_URL || env.DIFY_BASE_URL;
  const apiKey = process.env.DIFY_KNOWLEDGE_API_KEY || env.DIFY_KNOWLEDGE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("缺少 DIFY_BASE_URL 或 DIFY_KNOWLEDGE_API_KEY");
  }
  const result = await uploadArticles(baseUrl, apiKey, articles);
  console.log(
    `Dify 同步完成：知识库 ${result.datasetId}，新增 ${result.uploaded}，跳过 ${result.skipped}。`,
  );
  if (failures.length > 0) {
    console.warn(`另有 ${failures.length} 条链接抓取失败，已记录到 failed-urls.json，可稍后重试。`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
