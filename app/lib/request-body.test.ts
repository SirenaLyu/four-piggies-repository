import assert from "node:assert/strict";
import test from "node:test";
import { readJsonBody, RequestBodyError } from "./request-body.ts";

test("读取合法 JSON", async () => {
  const request = new Request("http://localhost/api", {
    method: "POST",
    body: JSON.stringify({ ok: true }),
  });
  assert.deepEqual(await readJsonBody(request, 100), { ok: true });
});

test("根据声明长度提前拒绝过大请求", async () => {
  const request = new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-length": "1000" },
    body: "{}",
  });
  await assert.rejects(
    readJsonBody(request, 100),
    (error: unknown) =>
      error instanceof RequestBodyError && error.status === 413,
  );
});

test("根据真实流字节数拒绝未声明长度的过大请求", async () => {
  const request = new Request("http://localhost/api", {
    method: "POST",
    body: "1234567890",
  });
  await assert.rejects(
    readJsonBody(request, 5),
    (error: unknown) =>
      error instanceof RequestBodyError && error.status === 413,
  );
});

test("非法 JSON 返回 400 类型错误", async () => {
  const request = new Request("http://localhost/api", {
    method: "POST",
    body: "{",
  });
  await assert.rejects(
    readJsonBody(request, 100),
    (error: unknown) =>
      error instanceof RequestBodyError && error.status === 400,
  );
});
