import { test } from "node:test";
import assert from "node:assert/strict";
import { languageToExtension, parseCodeBlocks } from "./markdown.ts";

test("提取多个围栏代码块", () => {
  const blocks = parseCodeBlocks(
    "```python\nprint(1)\n```\n\ntext\n\n```js\nconsole.log(2)\n```",
  );
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].language, "python");
  assert.equal(blocks[0].code, "print(1)");
  assert.equal(blocks[1].language, "js");
  assert.equal(blocks[1].code, "console.log(2)");
});

test("无语言标注默认为 text", () => {
  const blocks = parseCodeBlocks("```\nhello\n```");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].language, "text");
  assert.equal(blocks[0].code, "hello");
});

test("languageToExtension 常用映射", () => {
  assert.equal(languageToExtension("python"), "py");
  assert.equal(languageToExtension("TypeScript"), "ts");
  assert.equal(languageToExtension("c++"), "cpp");
});

test("未知语言回退为 txt", () => {
  assert.equal(languageToExtension("unknown-lang"), "txt");
});
