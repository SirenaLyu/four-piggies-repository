import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_OFFICE_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  inferAttachmentMediaType,
  validateAttachment,
} from "./attachment-policy.ts";

test("缺失 MIME 时按扩展名识别文本附件", () => {
  assert.equal(
    inferAttachmentMediaType({ name: "课程表.md", size: 10, type: "" }),
    "text/markdown",
  );
});

test("允许可安全提取的 Office Open XML 文档并限制大小", () => {
  assert.equal(
    validateAttachment({ name: "课程.docx", size: 10 }, 0, 0),
    null,
  );
  assert.match(
    validateAttachment(
      { name: "课表.xlsx", size: MAX_OFFICE_ATTACHMENT_BYTES + 1 },
      0,
      0,
    ) ?? "",
    /文件过大/,
  );
  assert.match(validateAttachment({ name: "扫描.pdf", size: 10 }, 0, 0) ?? "", /暂不支持/);
});

test("文本和图片使用不同的单文件大小限制", () => {
  assert.match(
    validateAttachment(
      { name: "large.txt", size: MAX_TEXT_ATTACHMENT_BYTES + 1 },
      0,
      0,
    ) ?? "",
    /文件过大/,
  );
  assert.equal(
    validateAttachment(
      { name: "photo.png", size: MAX_IMAGE_ATTACHMENT_BYTES },
      0,
      0,
    ),
    null,
  );
});
