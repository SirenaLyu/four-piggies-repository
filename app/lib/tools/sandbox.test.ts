import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  authorizeExistingPath,
  authorizePath,
  resolveAuthorizedDirectories,
  resolveInside,
  resolveWritePath,
} from "./sandbox.ts";

test("仅允许授权目录及其子路径", () => {
  const root = path.resolve("C:\\Users\\tester\\work");
  assert.equal(authorizePath(path.join(root, "a.txt"), [root]).ok, true);
  assert.equal(authorizePath(`${root}-outside`, [root]).ok, false);
  assert.equal(resolveInside("..\\outside.txt", root).ok, false);
});

test("客户端目录不能越过服务端允许根目录", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "campus-agent-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "campus-agent-outside-"));
  try {
    const accepted = await resolveAuthorizedDirectories([root, outside], [root]);
    assert.deepEqual(accepted, [await fs.realpath(root)]);
    assert.equal((await resolveWritePath("escape.txt", outside, accepted)).ok, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("Agent 拒绝读取环境变量、凭据和认证数据", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "campus-agent-secrets-"));
  try {
    const envFile = path.join(root, ".env.local");
    const npmCredentials = path.join(root, ".npmrc");
    const cloudCredentials = path.join(root, ".aws", "credentials");
    const authDir = path.join(root, "data", "auth");
    await fs.writeFile(envFile, "SECRET=test", "utf8");
    await fs.writeFile(npmCredentials, "token=test", "utf8");
    await fs.mkdir(path.dirname(cloudCredentials), { recursive: true });
    await fs.writeFile(cloudCredentials, "secret=test", "utf8");
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, "users.json"), "{}", "utf8");
    assert.equal((await authorizeExistingPath(envFile, [root])).ok, false);
    assert.equal((await authorizeExistingPath(npmCredentials, [root])).ok, false);
    assert.equal((await authorizeExistingPath(cloudCredentials, [root])).ok, false);
    assert.equal(
      (await authorizeExistingPath(path.join(authDir, "users.json"), [root])).ok,
      false,
    );
    assert.equal((await resolveWritePath(".env", root, [root])).ok, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
