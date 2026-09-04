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
const refreshCategories = process.argv
  .find((value) => value.startsWith("--refresh-category="))
  ?.slice("--refresh-category=".length)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean) ?? [];

if (!baseUrl || !apiKey) {
  throw new Error("缺少 DIFY_BASE_URL 或 DIFY_KNOWLEDGE_API_KEY");
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(generatedRoot, "wokepaike_manifest.json"), "utf8"),
);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(generatedRoot, "runs", runId);
if (shouldUpload) {
  fs.mkdirSync(runRoot, { recursive: true });
  fs.copyFileSync(
    path.join(generatedRoot, "wokepaike_manifest.json"),
    path.join(runRoot, "wokepaike_manifest.json"),
  );
  for (const document of manifest.documents) {
    fs.copyFileSync(
      path.join(generatedRoot, document.name),
      path.join(runRoot, document.name),
    );
  }
}

function writeRunArtifact(name, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(path.join(generatedRoot, name), content, "utf8");
  if (shouldUpload) {
    fs.writeFileSync(path.join(runRoot, name), content, "utf8");
  }
}

const expectedNames = new Set(manifest.documents.map((document) => document.name));
const headers = { Authorization: `Bearer ${apiKey}` };

async function api(pathname, init = {}) {
  const method = init.method ?? "GET";
  const attempts = method === "GET" ? 4 : 1;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
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
        const error = new Error(
          `${method} ${pathname} -> HTTP ${response.status}: ${JSON.stringify(body).slice(0, 1_000)}`,
        );
        if (method !== "GET" || (response.status < 500 && response.status !== 429)) {
          error.retryable = false;
          throw error;
        }
        lastError = error;
      } else {
        return body;
      }
    } catch (error) {
      lastError = error;
      if (method !== "GET" || error.retryable === false) throw error;
    }

    if (attempt < attempts) {
      const delayMs = attempt * 2_000;
      console.warn(
        JSON.stringify({
          event: "read-retry",
          pathname,
          attempt,
          delayMs,
          error: String(lastError?.message ?? lastError),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
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
const beforeSnapshot = {
  capturedAt: new Date().toISOString(),
  datasetId,
  totalDocuments: before.length,
  documents: before.map(compactDocument),
};
writeRunArtifact("remote-before.json", beforeSnapshot);
const existingByName = new Map(before.map((document) => [document.name, document]));
const existingManaged = before.filter((document) => expectedNames.has(document.name));
const missing = manifest.documents.filter(
  (document) => !existingByName.has(document.name),
);
const refresh = refreshCategories.length > 0
  ? manifest.documents.filter(
      (document) =>
        refreshCategories.includes(document.category) &&
        existingByName.has(document.name),
    )
  : [];

console.log(
  JSON.stringify({
    mode: shouldUpload ? "upload" : "dry-run",
    runId: shouldUpload ? runId : null,
    datasetId,
    expected: manifest.documents.length,
    existingManaged: existingManaged.length,
    missing: missing.length,
    refresh: refresh.length,
    refreshCategories,
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

writeRunArtifact("upload-results.json", {
  runId,
  uploadedAt: new Date().toISOString(),
  uploadResults,
});

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
writeRunArtifact("remote-after.json", snapshot);

const failed = managedAfter.filter((document) =>
  ["error", "paused"].includes(document.indexing_status),
);
const completed = managedAfter.filter(
  (document) => document.indexing_status === "completed",
);
const syncSummary = {
  event: "finished",
  runId,
  datasetId,
  manifestGeneratedAt: manifest.generatedAt,
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
};
writeRunArtifact("sync-summary.json", syncSummary);
fs.writeFileSync(
  path.join(generatedRoot, "latest-run.json"),
  `${JSON.stringify(
    {
      runId,
      runDirectory: path.relative(generatedRoot, runRoot),
      completed: syncSummary.completed,
      expected: syncSummary.expected,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(JSON.stringify(syncSummary));

if (failed.length > 0 || completed.length !== manifest.documents.length) {
  process.exitCode = 2;
}
