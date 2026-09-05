import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  applyPatchInWorkspace,
  buildCommandEnvironment,
  findFilesInWorkspace,
  isProbablyBinary,
  readFileInWorkspace,
  redactSensitiveText,
  runCommand,
  searchTextInWorkspace,
  writeFileInWorkspace,
} from "./executor.ts";

test("命令环境默认不会继承应用密钥", () => {
  const env = buildCommandEnvironment({
    PATH: "C:\\Windows",
    TEMP: "C:\\Temp",
    OPENAI_API_KEY: "secret",
    DIFY_KNOWLEDGE_API_KEY: "secret",
  });
  assert.equal(env.PATH, "C:\\Windows");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DIFY_KNOWLEDGE_API_KEY, undefined);
});

test("文件内容会识别二进制并遮蔽常见密钥", () => {
  assert.equal(isProbablyBinary(Buffer.from([1, 0, 2])), true);
  const result = redactSensitiveText("api_key=abcdefghijklmnop\nsk-test-secret-token-123456");
  assert.ok(result.redactions >= 2);
  assert.doesNotMatch(result.text, /abcdefghijklmnop|sk-test-secret/);
});

test("读取返回哈希，补丁使用哈希防止覆盖并发修改", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "campus-agent-executor-"));
  const target = path.join(root, "sample.txt");
  try {
    await fs.writeFile(target, "alpha\nbeta\ngamma\n", "utf8");
    const read = await readFileInWorkspace(target, 2, 3);
    assert.equal(read.content, "beta\ngamma");
    const patched = await applyPatchInWorkspace(target, read.sha256, [
      { oldText: "beta", newText: "delta" },
    ]);
    assert.equal(patched.replacements, 1);
    await assert.rejects(
      () => applyPatchInWorkspace(target, read.sha256, [{ oldText: "delta", newText: "beta" }]),
      /哈希校验失败/,
    );
    await assert.rejects(
      () => writeFileInWorkspace(target, "blind overwrite"),
      /目标文件已存在/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("文件查找和文本搜索有界且忽略依赖目录", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "campus-agent-search-"));
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "index.ts"), "const campusAgent = true;\n", "utf8");
    await fs.writeFile(path.join(root, "node_modules", "ignored", "secret.ts"), "campusAgent", "utf8");
    const found = await findFilesInWorkspace(root, "*.ts");
    assert.deepEqual(found.files, [path.join("src", "index.ts")]);
    const searched = await searchTextInWorkspace(root, "campusAgent", { filePattern: "*.ts" });
    assert.equal(searched.matches.length, 1);
    assert.equal(searched.matches[0].line, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("请求取消会终止 Agent 子进程", async () => {
  const controller = new AbortController();
  const running = runCommand(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    process.cwd(),
    { signal: controller.signal, userId: "abort-test" },
  );
  setTimeout(() => controller.abort(), 50);
  const result = await running;
  assert.equal(result.aborted, true);
});
