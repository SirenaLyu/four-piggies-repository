import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractGovPolicySearchTerms,
  formatGovPolicyResults,
} from "./official-search.ts";

test("只为国务院官方政策查询生成政策库关键词", () => {
  assert.equal(
    extractGovPolicySearchTerms(
      "国务院 人工智能 政策 2026年 最新 通知 检索基准日期 2026-08-31",
    ),
    "人工智能",
  );
  assert.equal(extractGovPolicySearchTerms("人工智能最新新闻"), null);
  assert.equal(extractGovPolicySearchTerms("中国科学技术大学最新通知"), null);
});

test("政策库响应只保留 gov.cn 官方结果并清理 HTML", () => {
  const formatted = formatGovPolicyResults({
    code: 200,
    searchVO: {
      listVO: [
        {
          title: "国务院关于深入实施“<em>人工智能</em>+”行动的意见",
          pubtimeStr: "2025.08.26",
          pcode: "国发〔2025〕11号",
          summary: "<em>人工智能</em>政策摘要",
          url: "https://www.gov.cn/zhengce/zhengceku/202508/content_7037862.htm",
        },
        {
          title: "伪造转载",
          url: "https://example.com/fake",
        },
      ],
    },
  });
  assert.match(formatted, /国务院关于深入实施“人工智能\+”行动的意见/);
  assert.match(formatted, /国发〔2025〕11号/);
  assert.match(formatted, /https:\/\/www\.gov\.cn\//);
  assert.doesNotMatch(formatted, /<em>|example\.com/);
});
