import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
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
