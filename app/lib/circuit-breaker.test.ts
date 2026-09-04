import assert from "node:assert/strict";
import test from "node:test";
import { createCircuitBreaker } from "./circuit-breaker.ts";

test("连续失败达到阈值后短暂熔断", () => {
  const breaker = createCircuitBreaker(2, 1_000);
  breaker.recordFailure(0);
  assert.equal(breaker.canRequest(100), true);
  breaker.recordFailure(100);
  assert.equal(breaker.canRequest(200), false);
  assert.equal(breaker.canRequest(1_101), true);
});

test("成功请求会重置失败计数", () => {
  const breaker = createCircuitBreaker(2, 1_000);
  breaker.recordFailure(0);
  breaker.recordSuccess();
  assert.deepEqual(breaker.snapshot(), { failures: 0, openUntil: 0 });
});
