import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { extractOfficeArchive } from "./office-attachment.ts";

async function archive(files: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "arraybuffer" });
}

test("从 DOCX 主文档 XML 提取段落和制表符", async () => {
  const input = await archive({
    "word/document.xml":
      "<w:document><w:body><w:p><w:r><w:t>课程介绍</w:t></w:r></w:p><w:p><w:r><w:t>教师</w:t></w:r><w:tab/><w:r><w:t>张老师</w:t></w:r></w:p></w:body></w:document>",
  });
  assert.equal(await extractOfficeArchive(input, "课程.docx"), "课程介绍\n教师\t张老师");
});

test("从 XLSX 解析共享字符串与数值单元格", async () => {
  const input = await archive({
    "xl/sharedStrings.xml": "<sst><si><t>课程</t></si><si><t>数学</t></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>3</v></c></row><row><c t="s"><v>1</v></c></row></sheetData></worksheet>',
  });
  assert.equal(
    await extractOfficeArchive(input, "课表.xlsx"),
    "## 工作表 1\n课程\t3\n数学",
  );
});

test("从 PPTX 按幻灯片顺序提取文本", async () => {
  const input = await archive({
    "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>第一页</a:t></a:r></a:p></p:sld>",
  });
  assert.equal(
    await extractOfficeArchive(input, "讲义.pptx"),
    "## 幻灯片 1\n第一页\n\n## 幻灯片 2\n第二页",
  );
});
