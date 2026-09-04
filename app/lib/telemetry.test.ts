import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelemetryContext,
  errorMessage,
  requestIdFor,
  withRequestId,
} from "./telemetry.ts";

test("requestIdFor 保留安全的上游请求 ID", () => {
  const request = new Request("http://localhost/api/chat", {
    headers: { "x-request-id": "edge-request_1234" },
  });
  assert.equal(requestIdFor(request), "edge-request_1234");
});

test("requestIdFor 拒绝短 ID 和控制字符并生成 UUID", () => {
  const request = new Request("http://localhost/api/chat", {
    headers: { "x-request-id": "bad" },
  });
  assert.match(requestIdFor(request), /^[0-9a-f-]{36}$/);
});

test("withRequestId 写入响应头，context 使用相同规则", () => {
  const request = new Request("http://localhost/api/export", {
    headers: { "x-request-id": "client-request-999" },
  });
  const context = createTelemetryContext(request, "export");
  const response = withRequestId(Response.json({ ok: true }), context.requestId);
  assert.deepEqual(context, {
    requestId: "client-request-999",
    scope: "export",
  });
  assert.equal(response.headers.get("x-request-id"), "client-request-999");
});

test("errorMessage 统一未知异常", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("failed"), "failed");
});
