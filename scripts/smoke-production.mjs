import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const port = Number(process.env.SMOKE_TEST_PORT ?? 3210);
const origin = `http://127.0.0.1:${port}`;
const nextBin = path.join(
  projectRoot,
  "node_modules",
  "next",
  "dist",
  "bin",
  "next",
);
const authDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "campus-auth-smoke-"));
const agentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "campus-agent-smoke-"));
const smokeUserRoot = path.join(agentRoot, "smoke-user");
const secondUserRoot = path.join(agentRoot, "second-user");
await fs.mkdir(smokeUserRoot, { recursive: true });
await fs.mkdir(secondUserRoot, { recursive: true });
const child = spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NODE_ENV: "production",
    AUTH_DATA_DIR: authDataDir,
    AUTH_SESSION_SECRET: "smoke-session-secret-with-at-least-32-characters",
    AUTH_ENCRYPTION_KEY: "smoke-encryption-secret-with-at-least-32-characters",
    AUTH_ALLOW_REGISTRATION: "true",
    AGENT_ALLOWED_ROOTS: agentRoot,
    AGENT_USER_ROOTS_JSON: JSON.stringify({
      "smoke-user": [smokeUserRoot],
      "second-user": [secondUserRoot],
    }),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    serverOutput = `${serverOutput}${chunk}`.slice(-8_000);
  });
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next.js 提前退出 (${child.exitCode})\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${origin}/?chat=1`);
      if (response.ok) return response;
    } catch {
      // 启动过程中连接失败是预期状态。
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Next.js 在 ${timeoutMs}ms 内未就绪\n${serverOutput}`);
}

try {
  const page = await waitForServer();
  assert.equal(page.status, 200);
  assert.match(await page.text(), /科大精灵/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(
    page.headers.get("referrer-policy"),
    "strict-origin-when-cross-origin",
  );
  assert.match(
    page.headers.get("permissions-policy") ?? "",
    /camera=\(\).*microphone=\(\).*geolocation=\(\)/,
  );
  const contentSecurityPolicy =
    page.headers.get("content-security-policy") ?? "";
  assert.match(contentSecurityPolicy, /object-src 'none'/);
  assert.match(contentSecurityPolicy, /frame-ancestors 'none'/);
  assert.doesNotMatch(contentSecurityPolicy, /unsafe-eval/);

  const unauthenticated = await fetch(`${origin}/api/model-config`);
  assert.equal(unauthenticated.status, 401);
  const unauthenticatedAgent = await fetch(`${origin}/api/agent/directories`);
  assert.equal(unauthenticatedAgent.status, 401);

  const register = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ username: "smoke-user", password: "SmokePass123" }),
  });
  assert.equal(register.status, 201);
  const cookie = register.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);

  const session = await fetch(`${origin}/api/auth/session`, {
    headers: { cookie },
  });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.username, "smoke-user");

  const grantDirectory = await fetch(`${origin}/api/agent/directories`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: JSON.stringify({ path: smokeUserRoot }),
  });
  assert.equal(grantDirectory.status, 200);
  assert.deepEqual((await grantDirectory.json()).directories, [await fs.realpath(smokeUserRoot)]);

  const secondRegister = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ username: "second-user", password: "SecondPass123" }),
  });
  assert.equal(secondRegister.status, 201);
  const secondCookie = secondRegister.headers.get("set-cookie")?.split(";")[0];
  assert.ok(secondCookie);
  const crossUserGrant = await fetch(`${origin}/api/agent/directories`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: secondCookie },
    body: JSON.stringify({ path: smokeUserRoot }),
  });
  assert.equal(crossUserGrant.status, 403);
  const ownGrant = await fetch(`${origin}/api/agent/directories`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: secondCookie },
    body: JSON.stringify({ path: secondUserRoot }),
  });
  assert.equal(ownGrant.status, 200);

  const saveModel = await fetch(`${origin}/api/model-config`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin,
      cookie,
    },
    body: JSON.stringify({
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-smoke-secret",
      model: "deepseek-chat",
      fallbackModel: "",
    }),
  });
  assert.equal(saveModel.status, 200);
  const savedModel = await saveModel.json();
  assert.equal(savedModel.apiKeyConfigured, true);
  assert.equal(savedModel.apiKey, undefined);
  assert.equal(savedModel.source, "user");
  assert.doesNotMatch(
    await fs.readFile(path.join(authDataDir, "users.json"), "utf8"),
    /sk-smoke-secret/,
  );

  const privateModelUrl = await fetch(`${origin}/api/model-config`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin,
      cookie,
    },
    body: JSON.stringify({
      baseUrl: "http://127.0.0.1:9999",
      apiKey: "sk-private",
      model: "private-model",
      fallbackModel: "",
    }),
  });
  assert.equal(privateModelUrl.status, 400);

  const crossOrigin = await fetch(`${origin}/api/summarize`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://evil.example",
    },
    body: "{}",
  });
  assert.equal(crossOrigin.status, 403);

  const requestId = "smoke-request-0001";
  const invalidJson = await fetch(`${origin}/api/summarize`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-request-id": requestId,
      cookie,
    },
    body: "{",
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.headers.get("x-request-id"), requestId);

  console.log(
    JSON.stringify({
      suite: "production-smoke",
      passed: 14,
      checks: [
        "page",
        "security-headers",
        "unauthenticated-api",
        "unauthenticated-agent-api",
        "register-session",
        "server-side-agent-grant",
        "cross-user-agent-isolation",
        "second-user-own-grant",
        "encrypted-model-config",
        "encrypted-at-rest",
        "model-url-ssrf-guard",
        "cross-origin",
        "invalid-json",
        "request-id",
      ],
    }),
  );
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  await fs.rm(authDataDir, { recursive: true, force: true });
  await fs.rm(agentRoot, { recursive: true, force: true });
}
