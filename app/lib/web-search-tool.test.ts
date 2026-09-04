import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchTool } from "./web-search-tool.ts";

type RunnableTool = {
  execute: (input: { query: string }) => Promise<string>;
};

test("联网工具返回经过筛选的 Dify 结果并复用安全缓存", async () => {
  const previousBaseUrl = process.env.DIFY_BASE_URL;
  const previousApiKey = process.env.DIFY_WORKFLOW_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.DIFY_BASE_URL = "https://dify.example";
  process.env.DIFY_WORKFLOW_API_KEY = "app-test";
  let workflowCalls = 0;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://dify.example/v1/workflows/run");
    workflowCalls += 1;
    return Response.json({
      data: {
        outputs: {
          result:
            "标题：中国科学技术大学校园开放日\n日期：2026-09-03\n摘要：中国科学技术大学发布校园开放日活动安排。\nURL：https://www.ustc.edu.cn/info/1002/test.htm",
        },
      },
    });
  };

  try {
    const query = "中国科学技术大学 2026 校园开放日 最新安排";
    const usage = { webSearches: 0 };
    const tool = createWebSearchTool(
      usage,
      new AbortController().signal,
      { requestId: "web-search-test", scope: "test" },
    ) as unknown as RunnableTool;
    const first = await tool.execute({ query });
    assert.match(first, /校园开放日/);
    assert.match(first, /ustc\.edu\.cn/);
    assert.equal(workflowCalls, 1);

    globalThis.fetch = async () => {
      throw new Error("缓存命中时不应再次请求");
    };
    const cachedTool = createWebSearchTool(
      { webSearches: 0 },
      new AbortController().signal,
      { requestId: "web-search-cache-test", scope: "test" },
    ) as unknown as RunnableTool;
    const cached = await cachedTool.execute({ query });
    assert.match(cached, /联网搜索结果（缓存/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBaseUrl === undefined) delete process.env.DIFY_BASE_URL;
    else process.env.DIFY_BASE_URL = previousBaseUrl;
    if (previousApiKey === undefined) delete process.env.DIFY_WORKFLOW_API_KEY;
    else process.env.DIFY_WORKFLOW_API_KEY = previousApiKey;
  }
});
