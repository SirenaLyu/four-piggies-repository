import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());

const projectRoot = process.cwd();
const port = Number(process.env.E2E_PORT ?? 3211);
const baseUrl = `http://127.0.0.1:${port}`;
const authDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "campus-e2e-auth-"));
const nextBin = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
const runner = path.join(projectRoot, "scripts", "eval-campus-e2e.mjs");
const username = `e2e-${Date.now()}`;
const password = "CampusE2ePass123";
const child = spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NODE_ENV: "production",
    AUTH_DATA_DIR: authDataDir,
    AUTH_SESSION_SECRET: "campus-e2e-session-secret-with-at-least-32-characters",
    AUTH_ENCRYPTION_KEY: "campus-e2e-encryption-key-with-at-least-32-characters",
    AUTH_ALLOW_REGISTRATION: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    serverOutput = `${serverOutput}${chunk}`.slice(-12_000);
  });
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next.js 提前退出 (${child.exitCode})\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Next.js 在 ${timeoutMs}ms 内未就绪\n${serverOutput}`);
}

async function runChild(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const processChild = spawn(executable, args, {
      cwd: projectRoot,
      stdio: "inherit",
      ...options,
    });
    processChild.once("error", reject);
    processChild.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`评测进程失败：code=${code} signal=${signal ?? "none"}`));
    });
  });
}

try {
  await fs.access(path.join(projectRoot, ".next", "BUILD_ID"));
  await waitForServer();
  const register = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!register.ok) {
    throw new Error(`临时评测账号创建失败：HTTP ${register.status} ${await register.text()}`);
  }
  await runChild(
    process.execPath,
    ["--no-warnings", runner, "--answer", "--strict", `--base-url=${baseUrl}`, ...process.argv.slice(2)],
    {
      env: {
        ...process.env,
        E2E_BASE_URL: baseUrl,
        E2E_USERNAME: username,
        E2E_PASSWORD: password,
      },
    },
  );
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  await fs.rm(authDataDir, { recursive: true, force: true });
}
