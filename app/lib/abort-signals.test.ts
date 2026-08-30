import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeoutSignal } from "./abort-signals.ts";

test("父请求取消会传递到组合信号", () => {
  const controller = new AbortController();
  const signal = withTimeoutSignal(controller.signal, 60_000);
  controller.abort(new Error("client disconnected"));
  assert.equal(signal.aborted, true);
});

test("没有父信号时仍创建超时信号", () => {
  const signal = withTimeoutSignal(undefined, 60_000);
  assert.equal(signal.aborted, false);
});
