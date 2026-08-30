import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlLruCache } from "./ttl-lru-cache.ts";

test("TTL 到期后不再返回缓存值", () => {
  const cache = new TtlLruCache<string, number>(2, 100);
  cache.set("a", 1, 1_000);
  assert.equal(cache.get("a", 1_099), 1);
  assert.equal(cache.get("a", 1_100), undefined);
});

test("超过容量时淘汰最久未使用项", () => {
  const cache = new TtlLruCache<string, number>(2, 1_000);
  cache.set("a", 1, 0);
  cache.set("b", 2, 0);
  assert.equal(cache.get("a", 1), 1);
  cache.set("c", 3, 1);
  assert.equal(cache.get("b", 1), undefined);
  assert.equal(cache.get("a", 1), 1);
  assert.equal(cache.get("c", 1), 3);
});
