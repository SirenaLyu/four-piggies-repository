import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CAPABILITIES,
  capabilityFingerprint,
  normalizeCapabilities,
} from "./capabilities.ts";

test("缺少客户端配置时采用安全默认值", () => {
  assert.deepEqual(normalizeCapabilities(null), DEFAULT_CAPABILITIES);
});

test("显式关闭能力不会被默认值覆盖", () => {
  assert.deepEqual(
    normalizeCapabilities({ knowledgeBase: false, webSearch: false, agent: true }),
    { knowledgeBase: false, webSearch: false, agent: true },
  );
});

test("缓存指纹区分不同能力边界", () => {
  assert.equal(
    capabilityFingerprint({ knowledgeBase: true, webSearch: false, agent: true }),
    "101",
  );
});
