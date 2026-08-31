import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());

const datasetId =
  process.env.WOKEPAIKE_DIFY_DATASET_ID ??
  "1e3922a5-c7a6-4307-a852-62921e2a843b";
const baseUrl = (process.env.DIFY_BASE_URL ?? "").replace(/\/+$/, "");
const apiKey = process.env.DIFY_KNOWLEDGE_API_KEY ?? "";
const generatedRoot = path.resolve(
  process.argv.find((value) => value.startsWith("--dir="))?.slice(6) ??
    "generated/wokepaike-knowledge",
);
const shouldUpload = process.argv.includes("--upload");
const serialIndexing = process.argv.includes("--serial");
const refreshCategory = process.argv
  .find((value) => value.startsWith("--refresh-category="))
  ?.slice("--refresh-category=".length);

if (!baseUrl || !apiKey) {
  throw new Error("缺少 DIFY_BASE_URL 或 DIFY_KNOWLEDGE_API_KEY");
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(generatedRoot, "wokepaike_manifest.json"), "utf8"),
);
const expectedNames = new Set(manifest.documents.map((document) => document.name));
const headers = { Authorization: `Bearer ${apiKey}` };

async function api(pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
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
    throw new Error(
      `${init.method ?? "GET"} ${pathname} -> HTTP ${response.status}: ${JSON.stringify(body).slice(0, 1_000)}`,
    );
  }
  return body;
}

async function listDocuments() {
  const documents = [];
  for (let page = 1; ; page += 1) {
    const body = await api(
      `/v1/datasets/${datasetId}/documents?page=${page}&limit=100`,
    );
    documents.push(...(body.data ?? []));
    if (!body.has_more) return documents;
  }
}

function compactDocument(document) {
  return {
    id: document.id,
    name: document.name,
    indexing_status: document.indexing_status,
    enabled: document.enabled,
    word_count: document.word_count,
    segments_count: document.segments_count,
    created_at: document.created_at,
    updated_at: document.updated_at,
    error: document.error ?? null,
  };
}

async function uploadDocument(document) {
  const filePath = path.join(generatedRoot, document.name);
  const bytes = fs.readFileSync(filePath);
  const data = {
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
  form.append(
    "file",
    new Blob([bytes], { type: "text/markdown" }),
    document.name,
  );
  const result = await api(
    `/v1/datasets/${datasetId}/document/create-by-file`,
    { method: "POST", body: form },
  );
  return {
    id: result.document?.id,
    name: document.name,
    batch: result.batch,
    initialStatus: result.document?.indexing_status,
  };
}

async function updateDocument(document, documentId) {
  const filePath = path.join(generatedRoot, document.name);
  const bytes = fs.readFileSync(filePath);
  const data = {
    name: document.name,
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
  form.append(
    "file",
    new Blob([bytes], { type: "text/markdown" }),
    document.name,
  );
  const result = await api(
    `/v1/datasets/${datasetId}/documents/${documentId}/update-by-file`,
    { method: "POST", body: form },
  );
  return {
    id: documentId,
    name: document.name,
    batch: result.batch,
    initialStatus: result.document?.indexing_status,
  };
}

async function waitForDocument(documentId, name, timeoutMs = 20 * 60 * 1_000) {
  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < timeoutMs) {
    const document = await api(
      `/v1/datasets/${datasetId}/documents/${documentId}`,
    );
    if (document.indexing_status !== lastStatus) {
      console.log(
        JSON.stringify({
          event: "serial-indexing",
          name,
          status: document.indexing_status,
          error: document.error ?? null,
        }),
      );
      lastStatus = document.indexing_status;
    }
    if (["completed", "error", "paused"].includes(document.indexing_status)) {
      if (document.indexing_status !== "completed") {
        throw new Error(
          `${name} 索引失败：${document.error ?? document.indexing_status}`,
        );
      }
      return document;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`${name} 在 ${timeoutMs / 60_000} 分钟内未完成索引`);
}

const before = await listDocuments();
const existingByName = new Map(before.map((document) => [document.name, document]));
const existingManaged = before.filter((document) => expectedNames.has(document.name));
const missing = manifest.documents.filter(
  (document) => !existingByName.has(document.name),
);
const refresh = refreshCategory
  ? manifest.documents.filter(
      (document) =>
        document.category === refreshCategory && existingByName.has(document.name),
    )
  : [];

console.log(
  JSON.stringify({
    mode: shouldUpload ? "upload" : "dry-run",
    datasetId,
    expected: manifest.documents.length,
    existingManaged: existingManaged.length,
    missing: missing.length,
    refresh: refresh.length,
    refreshCategory: refreshCategory ?? null,
    existingUnmanaged: before.length - existingManaged.length,
    serialIndexing,
  }),
);

if (!shouldUpload) process.exit(0);

const uploadResults = [];
for (let index = 0; index < refresh.length; index += 1) {
  const document = refresh[index];
  const existing = existingByName.get(document.name);
  const result = await updateDocument(document, existing.id);
  uploadResults.push({ ...result, action: "update" });
  console.log(
    JSON.stringify({
      event: "updated",
      progress: `${index + 1}/${refresh.length}`,
      name: document.name,
      id: result.id,
    }),
  );
  if (serialIndexing) {
    await waitForDocument(result.id, document.name);
  }
}
for (let index = 0; index < missing.length; index += 1) {
  const document = missing[index];
  const result = await uploadDocument(document);
  uploadResults.push({ ...result, action: "create" });
  console.log(
    JSON.stringify({
      event: "uploaded",
      progress: `${index + 1}/${missing.length}`,
      name: document.name,
      id: result.id,
    }),
  );
  if (serialIndexing) {
    await waitForDocument(result.id, document.name);
  }
}

fs.writeFileSync(
  path.join(generatedRoot, "upload-results.json"),
  `${JSON.stringify({ uploadedAt: new Date().toISOString(), uploadResults }, null, 2)}\n`,
  "utf8",
);

const startedAt = Date.now();
const timeoutMs = 45 * 60 * 1_000;
let lastSignature = "";
let after;
while (Date.now() - startedAt < timeoutMs) {
  after = await listDocuments();
  const managed = after.filter((document) => expectedNames.has(document.name));
  const counts = Object.fromEntries(
    ["waiting", "parsing", "cleaning", "splitting", "indexing", "completed", "error", "paused"].map(
      (status) => [
        status,
        managed.filter((document) => document.indexing_status === status).length,
      ],
    ),
  );
  const signature = JSON.stringify(counts);
  if (signature !== lastSignature) {
    console.log(JSON.stringify({ event: "indexing", managed: managed.length, counts }));
    lastSignature = signature;
  }
  if (
    managed.length === manifest.documents.length &&
    managed.every((document) =>
      ["completed", "error", "paused"].includes(document.indexing_status),
    )
  ) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

after ??= await listDocuments();
const managedAfter = after.filter((document) => expectedNames.has(document.name));
const snapshot = {
  capturedAt: new Date().toISOString(),
  datasetId,
  totalDocuments: after.length,
  managedDocuments: managedAfter.map(compactDocument),
  unmanagedDocuments: after
    .filter((document) => !expectedNames.has(document.name))
    .map(compactDocument),
};
fs.writeFileSync(
  path.join(generatedRoot, "remote-after.json"),
  `${JSON.stringify(snapshot, null, 2)}\n`,
  "utf8",
);

const failed = managedAfter.filter((document) =>
  ["error", "paused"].includes(document.indexing_status),
);
const completed = managedAfter.filter(
  (document) => document.indexing_status === "completed",
);
console.log(
  JSON.stringify({
    event: "finished",
    expected: manifest.documents.length,
    completed: completed.length,
    failed: failed.map(compactDocument),
    pending: managedAfter.filter(
      (document) =>
        !["completed", "error", "paused"].includes(document.indexing_status),
    ).length,
    totalWordCount: completed.reduce(
      (total, document) => total + (document.word_count ?? 0),
      0,
    ),
  }),
);

if (failed.length > 0 || completed.length !== manifest.documents.length) {
  process.exitCode = 2;
}
