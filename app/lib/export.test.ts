import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sanitizeDownloadFilename,
  wrapTextByWidth,
} from "./export.ts";

test("下载文件名移除路径和 Windows 非法字符", () => {
  assert.equal(
    sanitizeDownloadFilename('../报告:2026/秋季?.pdf'),
    ".._报告_2026_秋季_.pdf",
  );
  assert.equal(sanitizeDownloadFilename("   "), "download");
});

test("PDF 文本按测量宽度保留全部中英文字符", () => {
  const source = "中文ABC测试";
  const lines = wrapTextByWidth(source, 4, (value) => Array.from(value).length);
  assert.deepEqual(lines, ["中文AB", "C测试"]);
  assert.equal(lines.join(""), source);
  assert.deepEqual(wrapTextByWidth("", 4, (value) => value.length), [""]);
});
