import assert from "node:assert/strict";
import test from "node:test";
import {
  createFixedWindowRateLimiter,
  isAllowedRequestOrigin,
  requestAddress,
} from "./api-security.ts";

test("允许同源请求并拒绝伪造的跨站来源", () => {
  const sameOrigin = new Request("https://campus.example/api/chat", {
    headers: { host: "campus.example", origin: "https://campus.example" },
  });
  const crossOrigin = new Request("https://campus.example/api/chat", {
    headers: { host: "campus.example", origin: "https://evil.example" },
  });
  assert.equal(isAllowedRequestOrigin(sameOrigin, new Set()), true);
  assert.equal(isAllowedRequestOrigin(crossOrigin, new Set()), false);
});

test("显式白名单可允许可信的反向代理前端", () => {
  const request = new Request("https://internal.example/api/chat", {
    headers: { host: "internal.example", origin: "https://campus.example" },
  });
  assert.equal(
    isAllowedRequestOrigin(request, new Set(["https://campus.example"])),
    true,
  );
});

test("默认不信任可伪造的代理来源头", () => {
  const request = new Request("https://internal.example/api/chat", {
    headers: {
      host: "internal.example",
      origin: "https://evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "203.0.113.7",
    },
  });
  assert.equal(isAllowedRequestOrigin(request, new Set(), false), false);
  assert.equal(requestAddress(request, false), "direct-client");
});

test("部署在可信反向代理后可显式启用代理头", () => {
  const request = new Request("http://internal:3000/api/chat", {
    headers: {
      host: "internal:3000",
      origin: "https://campus.example",
      "x-forwarded-host": "campus.example",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "203.0.113.7, 10.0.0.2",
    },
  });
  assert.equal(isAllowedRequestOrigin(request, new Set(), true), true);
  assert.equal(requestAddress(request, true), "203.0.113.7");
});

test("固定窗口限流在窗口结束后自动恢复", () => {
  const limit = createFixedWindowRateLimiter();
  assert.equal(limit("chat:user", 2, 1_000, 0).allowed, true);
  assert.equal(limit("chat:user", 2, 1_000, 100).allowed, true);
  assert.equal(limit("chat:user", 2, 1_000, 200).allowed, false);
  assert.equal(limit("chat:user", 2, 1_000, 1_001).allowed, true);
});
