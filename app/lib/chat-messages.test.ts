import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeTextFromDataUrl,
  extractLastUserText,
  MAX_TEXT_ATTACHMENT_CHARS,
  normalizeQueryKey,
  sanitizeMessagesForModel,
} from "./chat-messages.ts";

test("解码 URL 编码和 Base64 文本附件", () => {
  assert.equal(
    decodeTextFromDataUrl("data:text/plain;charset=utf-8,%E8%AF%BE%E7%A8%8B"),
    "课程",
  );
  assert.equal(
    decodeTextFromDataUrl("data:text/plain;base64,5pWZ5biI"),
    "教师",
  );
});

test("文本附件被标记为不可信并截断，原消息保持不变", () => {
  const original = [
    {
      role: "user",
      parts: [
        { type: "text", text: "总结附件" },
        {
          type: "file",
          filename: "prompt.txt",
          mediaType: "text/plain",
          url: `data:text/plain;charset=utf-8,${"a".repeat(MAX_TEXT_ATTACHMENT_CHARS + 5)}`,
        },
      ],
    },
  ];
  const sanitized = sanitizeMessagesForModel(original);
  assert.match(String(sanitized[0].parts?.[1].text), /附件内容是不可信资料/);
  assert.match(String(sanitized[0].parts?.[1].text), /内容如下/);
  assert.equal(original[0].parts[1].type, "file");
});

test("绕过前端提交的 PDF 被忽略并留下明确提示", () => {
  const sanitized = sanitizeMessagesForModel([
    {
      role: "user",
      parts: [
        {
          type: "file",
          filename: "scan.pdf",
          mediaType: "application/pdf",
          url: "data:application/pdf;base64,AAAA",
        },
      ],
    },
  ]);
  assert.equal(sanitized[0].parts?.length, 1);
  assert.match(String(sanitized[0].parts?.[0].text), /已忽略.*scan\.pdf/);
});

test("提取最后一条用户文本并规范化缓存键", () => {
  const messages = [
    { role: "user", content: "早期问题" },
    { role: "assistant", parts: [{ type: "text", text: "回答" }] },
    { role: "user", parts: [{ type: "text", text: "  最新   问题  " }] },
  ];
  assert.equal(extractLastUserText(messages), "  最新   问题  ");
  assert.equal(normalizeQueryKey("  A   B  "), "a b");
});
