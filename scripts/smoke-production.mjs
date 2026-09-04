import assert from "node:assert/strict";
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
const child = spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
  cwd: projectRoot,
  env: { ...process.env, NODE_ENV: "production" },
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
    },
    body: "{",
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.headers.get("x-request-id"), requestId);

  console.log(
    JSON.stringify({
      suite: "production-smoke",
      passed: 5,
      checks: [
        "page",
        "security-headers",
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
}
