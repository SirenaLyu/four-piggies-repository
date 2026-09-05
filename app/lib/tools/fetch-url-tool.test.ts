import assert from "node:assert/strict";
import test from "node:test";
import {
  createUrlFetchTool,
  extractReadableText,
} from "./fetch-url-tool.ts";

type RunnableTool = {
  execute: (input: { url: string }) => Promise<string>;
};

function makeTool(usage: { webSearches: number; urlFetches?: number }) {
  return createUrlFetchTool(usage, new AbortController().signal, {
    requestId: "fetch-url-test",
    scope: "test",
  }) as unknown as RunnableTool;
}

function installFetchMock() {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedUrls.push(url.toString());
    if (url.hostname === "203.0.113.10") {
      return new Response(
        "<html><head><title>测试页</title><style>a{color:red}</style></head>" +
          "<body><script>alert('x')</script><h1>奖学金通知</h1>" +
          "<p>评定工作&nbsp;&amp;流程详见正文。</p><p>第二段内容。</p></body></html>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (url.hostname === "203.0.113.20" && url.pathname === "/jump") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://203.0.113.21/final.htm" },
      });
    }
    if (url.hostname === "203.0.113.21") {
      return new Response("<p>重定向后的正文。</p>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (url.hostname === "203.0.113.30" && url.pathname === "/jump") {
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/secret" },
      });
    }
    if (url.hostname === "203.0.113.40") {
      return new Response("%PDF-1.7 fake", {
        headers: { "content-type": "application/pdf" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return {
    originalFetch,
    requestedUrls: () => requestedUrls,
  };
}

test("extractReadableText 移除脚本样式并解码实体、块级换行", () => {
  const html =
    "<!DOCTYPE html><html><head><style>a{color:red}</style>" +
    "<script>alert('x')</script></head><body>" +
    "<h1>标题&amp;正文</h1><p>第一段&nbsp;内容</p><p>第二段</p>" +
    "<div>&#x4e2d;&#25991;</div></body></html>";
  const text = extractReadableText(html);
  assert.match(text, /标题&正文/);
  assert.match(text, /第一段 内容/);
  assert.match(text, /第二段/);
  assert.match(text, /中文/);
  assert.doesNotMatch(text, /alert|color:red|DOCTYPE/);
  // 块级标签转换为换行（标题、两段、div 共 4 行）
  assert.equal(text.split("\n").length, 4);
});

test("内网与非法 URL 被拒绝且不发起网络请求", async () => {
  const { originalFetch, requestedUrls } = installFetchMock();
  try {
    const rejected = [
      "http://127.0.0.1:3000/admin",
      "http://192.168.1.1/router",
      "http://10.0.0.5/internal",
      "http://[::1]/x",
      "http://169.254.169.254/metadata",
      "http://localhost:8080/local",
    ];
    for (const url of rejected) {
      const tool = makeTool({ webSearches: 0, urlFetches: 0 });
      const text = await tool.execute({ url });
      assert.match(text, /已拒绝访问|不安全|内网/, `应拒绝：${url}`);
    }
    const tool = makeTool({ webSearches: 0, urlFetches: 0 });
    assert.match(await tool.execute({ url: "ftp://example.com/f" }), /仅支持 http\/https/);
    assert.match(await tool.execute({ url: "不是链接" }), /不是合法的 URL/);
    assert.equal(requestedUrls().length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("成功抓取公网页面：前缀、正文、来源与预算计数", async () => {
  const { originalFetch, requestedUrls } = installFetchMock();
  try {
    const usage = { webSearches: 0, urlFetches: 0 };
    const tool = makeTool(usage);
    const text = await tool.execute({ url: "https://203.0.113.10/info.htm" });

    assert.match(text, /【网页正文（已做安全过滤）】/);
    assert.match(text, /来源：https:\/\/203\.0\.113\.10\/info\.htm/);
    assert.match(text, /奖学金通知/);
    assert.match(text, /评定工作 &流程详见正文/);
    assert.doesNotMatch(text, /alert/);
    assert.equal(usage.urlFetches, 1);
    assert.equal(requestedUrls().length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("重定向逐跳校验：正常跳转可跟随，跳转内网被拒绝", async () => {
  const { originalFetch, requestedUrls } = installFetchMock();
  try {
    const usage = { webSearches: 0, urlFetches: 0 };
    const tool = makeTool(usage);
    const text = await tool.execute({ url: "https://203.0.113.20/jump" });
    assert.match(text, /重定向后的正文/);
    assert.match(text, /来源：https:\/\/203\.0\.113\.21\/final\.htm/);
    assert.equal(requestedUrls().length, 2);

    const blockedTool = makeTool({ webSearches: 0, urlFetches: 0 });
    const blocked = await blockedTool.execute({
      url: "https://203.0.113.30/jump",
    });
    assert.match(blocked, /网页阅读失败/);
    assert.match(blocked, /已拒绝访问/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("仅接受 HTML/纯文本，二进制类型被拒绝", async () => {
  const { originalFetch } = installFetchMock();
  try {
    const tool = makeTool({ webSearches: 0, urlFetches: 0 });
    const text = await tool.execute({ url: "https://203.0.113.40/doc.pdf" });
    assert.match(text, /不支持的页面类型/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("达到每轮上限后不再抓取", async () => {
  const { originalFetch, requestedUrls } = installFetchMock();
  try {
    const usage = { webSearches: 0, urlFetches: 3 };
    const tool = makeTool(usage);
    const text = await tool.execute({ url: "https://203.0.113.10/info.htm" });
    assert.match(text, /网页阅读次数已达上限/);
    assert.equal(requestedUrls().length, 0);
    assert.equal(usage.urlFetches, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
