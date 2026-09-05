import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "campus-memory-test-"));
const origin = "http://127.0.0.1:3212";
let plannedChange;
let modelContext = "";
const mock = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  modelContext = JSON.stringify(body.messages);
  const hasResult = body.messages.some((message) => message.role === "tool");
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "memory-test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (!hasResult && plannedChange) {
    send({ role: "assistant", tool_calls: [{ index: 0, id: "memory-call", type: "function", function: { name: "update_memory", arguments: JSON.stringify(plannedChange) } }] });
    send({}, "tool_calls");
  } else {
    send({ role: "assistant", content: "已处理本次请求。" });
    send({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", "3212"], {
  cwd: root,
  env: { ...process.env, AUTH_DATA_DIR: authDir, AUTH_ALLOW_REGISTRATION: "true", AUTH_SESSION_SECRET: "memory-test-session-secret-32-characters", AUTH_ENCRYPTION_KEY: "memory-test-encryption-secret-32-characters", OPENAI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, OPENAI_API_KEY: "local-mock", CHAT_MODEL: "memory-test", CHAT_FALLBACK_MODEL: "memory-test" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (chunk) => { logs = (logs + chunk).slice(-12000); });
child.stderr.on("data", (chunk) => { logs = (logs + chunk).slice(-12000); });
const request = (url, cookie, method = "GET", body) => fetch(origin + url, { method, headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
async function register(username) {
  const response = await request("/api/auth/register", "", "POST", { username, password: "MemoryTest123" });
  assert.equal(response.status, 201);
  return response.headers.get("set-cookie").split(";")[0];
}
async function get(cookie) { return (await request("/api/memory", cookie)).json(); }
async function change(cookie, version, action) {
  const response = await request("/api/memory", cookie, "PATCH", { version, change: action });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function chat(cookie, messages) {
  const response = await request("/api/chat", cookie, "POST", { id: `test-${Date.now()}`, messages, capabilities: { knowledgeBase: false, webSearch: false, agent: false }, userProfile: { major: "FORGED", grade: "FORGED" } });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const events = raw.split("\n").filter((line) => line.startsWith("data: ") && !line.includes("[DONE]")).map((line) => JSON.parse(line.slice(6)));
  assert.ok(!events.some((event) => event.type === "error"), raw);
  return events;
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* waiting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(ready, logs);
  assert.equal((await request("/api/memory")).status, 401);
  const first = await register("memory-first");
  const second = await register("memory-second");
  let memory = await get(first);
  assert.equal(memory.onboarded, false);
  memory = await change(first, memory.version, { action: "profile", major: "物理", grade: "大二" });
  memory = await change(first, memory.version, { action: "add", content: "喜欢例子" });
  const id = memory.entries[0].id;
  assert.equal((await get(second)).entries.length, 0);
  assert.equal((await request("/api/memory", second, "PATCH", { version: 0, change: { action: "delete", id } })).status, 400);
  assert.equal((await request("/api/memory", first, "PATCH", { version: 0, change: { action: "delete", id } })).status, 409);
  memory = await change(first, memory.version, { action: "update", id, content: "喜欢具体实例" });
  memory = await change(first, memory.version, { action: "delete", id });
  for (const approved of [false, true]) {
    plannedChange = { version: memory.version, change: { action: "add", content: "偏好简短回答" } };
    const user = { id: "user-1", role: "user", parts: [{ type: "text", text: "请记住我偏好简短回答" }] };
    const events = await chat(first, [user]);
    assert.match(modelContext, /物理/);
    assert.ok(!modelContext.includes("FORGED"));
    const approval = events.find((event) => event.type === "tool-approval-request");
    const input = events.find((event) => event.type === "tool-input-available");
    assert.ok(approval?.signature, JSON.stringify(events));
    assert.ok(input, JSON.stringify(events));
    assert.deepEqual(await get(first), memory, "未确认时不能写入");
    const assistant = { id: "assistant-1", role: "assistant", parts: [{ type: "tool-update_memory", toolCallId: input.toolCallId, input: input.input, state: "approval-responded", approval: { id: approval.approvalId, signature: approval.signature, approved } }] };
    await chat(first, [user, assistant]);
    const updated = await get(first);
    assert.equal(updated.entries.length, approved ? 1 : 0);
    memory = updated;
  }
  for (const change of [
    { action: "update", id: memory.entries[0].id, content: "偏好简短回答和实例" },
    { action: "profile", major: "数学", grade: "大三" },
  ]) {
    plannedChange = { version: memory.version, change };
    const user = { id: "edit-user", role: "user", parts: [{ type: "text", text: "请修改我的记忆" }] };
    const events = await chat(first, [user]);
    const approval = events.find((event) => event.type === "tool-approval-request");
    const input = events.find((event) => event.type === "tool-input-available");
    assert.ok(approval?.signature);
    await chat(first, [user, { id: "edit-assistant", role: "assistant", parts: [{ type: "tool-update_memory", toolCallId: input.toolCallId, input: input.input, state: "approval-responded", approval: { id: approval.approvalId, signature: approval.signature, approved: true } }] }]);
    const updated = await get(first);
    assert.equal(updated.version, memory.version + 1);
    memory = updated;
  }
  assert.deepEqual(memory.profile, { major: "数学", grade: "大三" });
  assert.equal(memory.entries[0].content, "偏好简短回答和实例");
  plannedChange = undefined;
  await chat(first, [{ id: "recall", role: "user", parts: [{ type: "text", text: "你好" }] }]);
  assert.match(modelContext, /偏好简短回答/);
  assert.equal((await get(second)).entries.length, 0);
  assert.match(await fs.readFile(path.join(authDir, "users.json"), "utf8"), /偏好简短回答/);
  console.log("Memory production smoke passed: auth, CRUD, isolation, conflicts, persisted recall, approval and rejection, server-authoritative context (local model stub).");
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  // The directory was created specifically for this test under the OS temp directory.
  assert.ok(path.resolve(authDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(authDir, { recursive: true, force: true });
}
