import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLlmJson } from "./parse-llm-json.ts";

test("解析普通 JSON 对象", () => {
  const r = parseLlmJson<{ a: number }>('{"a":1}');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { a: 1 });
});

test("剥离 ```json 代码围栏", () => {
  const r = parseLlmJson<{ x: string }>('```json\n{"x":"y"}\n```');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { x: "y" });
});

test("剥离无语言标注的代码围栏", () => {
  const r = parseLlmJson<{ x: number }>('```\n{"x":2}\n```');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { x: 2 });
});

test("从杂文本中截取第一个 { 到最后一个 }", () => {
  const r = parseLlmJson<{ ok: boolean }>('前缀 {"ok": true} 后缀');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { ok: true });
});

test("非法 JSON 返回 ok:false 并保留 raw", () => {
  const r = parseLlmJson<unknown>("not json at all");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.raw, "not json at all");
});

test("非字符串输入被防御性处理", () => {
  const r = parseLlmJson<unknown>(123 as unknown as string);
  assert.equal(r.ok, false);
});
