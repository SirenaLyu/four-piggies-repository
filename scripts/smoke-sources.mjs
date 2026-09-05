import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sourceTextId } from "../app/lib/sources.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "campus-sources-test-"));
const origin = "http://localhost:3214";
let plannedTool;
let modelCalls = 0;
let omitCitation = false;
const mock = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const json = (data) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); };
  if (req.url.includes("/datasets/")) return json({ records: [{ score: 0.85, segment: { id: "seg-unused", document: { id: "doc-unused", name: "未采用资料" }, content: "其他图书馆服务规则。" } }, { score: 0.9, segment: { id: "seg-1", document: { id: "doc-1", name: "图书馆借阅规则（测试资料）" }, content: "本科生借阅规则测试片段。\n[图书馆官网](https://lib.ustc.edu.cn/)" } }] });
  if (req.url.includes("/workflows/")) return json({ data: { outputs: { result: "标题：中国科学技术大学校园开放日\n日期：2026-09-05\n摘要：中国科学技术大学校园开放日安排测试资料。\nURL：https://www.ustc.edu.cn/" } } });
  modelCalls++;
  if (!body.stream) return json({ id: "mock", choices: [{ index: 0, message: { role: "assistant", content: "来源卡片测试" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "sources-test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (plannedTool && !body.messages.some((message) => message.role === "tool")) {
    send({ role: "assistant", content: `[来源](#source-${sourceTextId("knowledge:test-library:doc-unused:seg-unused")}) 过程文字` });
    send({ role: "assistant", tool_calls: [{ index: 0, id: "source-call", type: "function", function: { name: plannedTool, arguments: JSON.stringify({ query: "中国科学技术大学校园开放日" }) } }] });
    send({}, "tool_calls");
  } else {
    const context = body.messages.filter((m) => m.role === "system" || m.role === "tool").map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
    const citedLine = context.split("\n").find((line) => line.includes('"citation"') && line.includes("借阅规则")) ?? context;
    const citation = citedLine.match(/\[来源\]\(#source-[a-z0-9]+\)/)?.[0] ?? "";
    send({ role: "assistant", content: "以下为来源卡片功能测试回答，请展开下方资料核对。" + (omitCitation ? "" : citation) });
    send({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", "3214"], {
  cwd: root,
  env: { ...process.env, AUTH_DATA_DIR: authDir, AUTH_ALLOW_REGISTRATION: "true", AUTH_SESSION_SECRET: "sources-test-session-secret-32-characters", AUTH_ENCRYPTION_KEY: "sources-test-encryption-secret-32-characters", OPENAI_BASE_URL: `${mockOrigin}/v1`, OPENAI_API_KEY: "local-mock", CHAT_MODEL: "sources-test", CHAT_FALLBACK_MODEL: "sources-test", DIFY_BASE_URL: mockOrigin, DIFY_KNOWLEDGE_API_KEY: "dataset-test", DATASET_IDS: "test-library", DIFY_DATASET_ROUTE_MAP: "{}", DIFY_WORKFLOW_API_KEY: "workflow-test" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { logs = (logs + chunk).slice(-12000); });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* waiting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(ready, logs);
  const registered = await fetch(`${origin}/api/auth/register`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username: "sources-test", password: "SourcesTest123" }) });
  assert.equal(registered.status, 201);
  const cookie = registered.headers.get("set-cookie").split(";")[0];
  async function chat(id, query, capabilities) {
    const response = await fetch(`${origin}/api/chat`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ id, capabilities, messages: [{ id: "user", role: "user", parts: [{ type: "text", text: query }] }] }) });
    assert.equal(response.status, 200);
    const raw = await response.text();
    const events = raw.split("\n").filter((line) => line.startsWith("data: ") && !line.includes("[DONE]")).map((line) => JSON.parse(line.slice(6)));
    assert.ok(!events.some((event) => event.type === "error"), raw);
    return events.filter((event) => event.type === "data-sources").at(-1)?.data.sources ?? [];
  }
  const knowledge = { knowledgeBase: true, webSearch: false, agent: false };
  const prefetched = await chat("prefetch", "图书馆借阅规则是什么？", knowledge);
  assert.equal(prefetched.length, 1, "多条命中只展示引用的一条");
  assert.equal(prefetched[0]?.kind, "knowledge");
  assert.match(prefetched[0].title, /借阅规则/);
  assert.equal(prefetched[0].links[0].url, "https://lib.ustc.edu.cn/");
  omitCitation = true;
  assert.deepEqual(await chat("uncited", "图书馆借阅规则有哪些？", knowledge), [], "检索命中但未引用时不展示");
  omitCitation = false;
  const beforeCache = modelCalls;
  assert.deepEqual(await chat("prefetch", "图书馆借阅规则是什么？", knowledge), prefetched);
  assert.equal(modelCalls, beforeCache, "缓存应同时重放回答和来源");
  plannedTool = "query_knowledge_base";
  const toolSources = await chat("knowledge-tool", "请检索相关资料", knowledge);
  assert.equal(toolSources.length, 1, "中间步骤引用不应计入最终采用来源");
  assert.match(toolSources[0].title, /借阅规则/);
  plannedTool = "web_search";
  const web = await chat("web-tool", "中国科学技术大学校园开放日最新安排", { knowledgeBase: false, webSearch: true, agent: false });
  assert.equal(web[0]?.url, "https://www.ustc.edu.cn/");
  assert.match(web[0].title, /校园开放日/);
  plannedTool = undefined;
  assert.deepEqual(await chat("plain", "你好", { knowledgeBase: false, webSearch: false, agent: false }), []);
  console.log("Sources smoke passed: prefetch, knowledge tool, web tool, cached source replay and no-source answer (local stubs).");
  if (process.argv.includes("--serve")) {
    console.log(`UI test server: ${origin}/?chat=1 ; user sources-test ; password SourcesTest123`);
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  }
} catch (error) { console.error(logs); throw error; }
finally {
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  assert.ok(path.resolve(authDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(authDir, { recursive: true, force: true });
}
