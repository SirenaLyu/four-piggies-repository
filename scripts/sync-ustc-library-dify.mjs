import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());

const DATASET_ID =
  process.env.USTC_LIBRARY_DIFY_DATASET_ID ??
  "748dd072-a42c-4cfc-8df4-b0dc9432be50";
const SOURCE_PATH = path.resolve("knowledge/ustc-library-borrowing-rules.md");
const OUTPUT_ROOT = path.resolve("generated/ustc-library-sync");
const DOCUMENT_NAME = path.basename(SOURCE_PATH);
const shouldUpload = process.argv.includes("--upload");
const baseUrl = (process.env.DIFY_BASE_URL ?? "").replace(/\/+$/, "");
const apiKey = process.env.DIFY_KNOWLEDGE_API_KEY ?? "";

if (!baseUrl || !apiKey) {
  throw new Error("缺少 DIFY_BASE_URL 或 DIFY_KNOWLEDGE_API_KEY");
}

async function api(pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 1_000) };
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${pathname} -> HTTP ${response.status}: ${JSON.stringify(body).slice(0, 1_000)}`);
  }
  return body;
}

async function listDocuments() {
  const documents = [];
  for (let page = 1; ; page += 1) {
    const body = await api(
      `/v1/datasets/${DATASET_ID}/documents?page=${page}&limit=100`,
    );
    documents.push(...(body.data ?? []));
    if (!body.has_more) return documents;
  }
}

function compact(document) {
  return {
    id: document.id,
    name: document.name,
    indexing_status: document.indexing_status,
    word_count: document.word_count,
    segments_count: document.segments_count,
    error: document.error ?? null,
  };
}

async function writeSnapshot(name, value) {
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  await fs.writeFile(
    path.join(OUTPUT_ROOT, name),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function waitForDocument(documentId) {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const document = await api(
      `/v1/datasets/${DATASET_ID}/documents/${documentId}`,
    );
    console.log(
      JSON.stringify({ event: "indexing", status: document.indexing_status }),
    );
    if (document.indexing_status === "completed") return document;
    if (["error", "paused"].includes(document.indexing_status)) {
      throw new Error(document.error ?? `索引状态：${document.indexing_status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("图书馆规则文档在20分钟内未完成索引");
}

const before = await listDocuments();
await writeSnapshot("remote-before.json", {
  capturedAt: new Date().toISOString(),
  datasetId: DATASET_ID,
  documents: before.map(compact),
});
const existing = before.find((document) => document.name === DOCUMENT_NAME);
console.log(
  JSON.stringify({
    event: "plan",
    datasetId: DATASET_ID,
    document: DOCUMENT_NAME,
    action: existing ? "update" : "create",
    upload: shouldUpload,
  }),
);

if (!shouldUpload) {
  console.log("未使用 --upload，未写入 Dify。");
  process.exit(0);
}

const bytes = await fs.readFile(SOURCE_PATH);
const data = {
  ...(existing ? { name: DOCUMENT_NAME } : {}),
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
      segmentation: {
        separator: "\n\n---\n\n",
        max_tokens: 1024,
        chunk_overlap: 80,
      },
    },
  },
};
const form = new FormData();
form.append("data", JSON.stringify(data));
form.append("file", new Blob([bytes], { type: "text/markdown" }), DOCUMENT_NAME);
const endpoint = existing
  ? `/v1/datasets/${DATASET_ID}/documents/${existing.id}/update-by-file`
  : `/v1/datasets/${DATASET_ID}/document/create-by-file`;
const result = await api(endpoint, { method: "POST", body: form });
const documentId = result.document?.id ?? existing?.id;
if (!documentId) throw new Error("Dify 响应缺少文档 ID");
await waitForDocument(documentId);

const after = await listDocuments();
await writeSnapshot("remote-after.json", {
  capturedAt: new Date().toISOString(),
  datasetId: DATASET_ID,
  documents: after.map(compact),
});
const synced = after.find((document) => document.id === documentId);
console.log(JSON.stringify({ event: "finished", document: compact(synced) }));
