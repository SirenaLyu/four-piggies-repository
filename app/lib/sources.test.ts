import assert from "node:assert/strict";
import test from "node:test";
import { citedSources, sourceAnchor, linksInSource, safeSourceUrl, sourcesFromParts, webSourcesFromText } from "./sources.ts";
import { extractRecord } from "./dify-knowledge.ts";
import { sanitizeMessagesForModel } from "./chat-messages.ts";
import { saveConversationMessages, loadConversationMessages } from "./conversation-storage.ts";
import type { UIMessage } from "ai";

test("knowledge records retain document identity without inventing URLs", () => {
  const chunk = extractRecord({ score: 0.8, segment: { id: "seg", content: "图书馆规则", document: { id: "doc", name: "借阅规则" } } }, "library");
  assert.equal(chunk?.documentTitle, "借阅规则");
  assert.equal(chunk?.documentId, "doc");
  assert.equal(chunk?.sourceUrl, undefined);
});

test("source links reject executable schemes and embedded credentials", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,test", "file:///C:/secret", "https://user:secret@example.com"]) assert.equal(safeSourceUrl(url), undefined);
  assert.equal(linksInSource("[官网](https://www.ustc.edu.cn/info/test.htm)。").length, 1);
  assert.deepEqual(linksInSource("[原文](https://example.com/article_(2026))"), [{ title: "原文", url: "https://example.com/article_(2026)" }]);
});

test("web cards keep each result's title, URL and excerpt together", () => {
  const sources = webSourcesFromText("标题：甲通知\n摘要：甲的安排\nURL：https://www.ustc.edu.cn/a\n\n标题：乙通知\n摘要：乙的安排\nURL：https://www.ustc.edu.cn/b");
  assert.equal(sources.length, 2);
  assert.equal(sources[1].title, "乙通知");
  assert.equal(sources[1].url, "https://www.ustc.edu.cn/b");
  assert.doesNotMatch(sources[1].excerpt, /甲/);
});

test("source cards survive history persistence and are excluded from model input", () => {
  const sources = webSourcesFromText("标题：通知\nURL：https://www.ustc.edu.cn/a");
  const messages = [{ id: "a", role: "assistant", parts: [{ type: "text", text: "回答" }, { type: "data-sources", data: { selection: "cited", sources } }] }] as UIMessage[];
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  saveConversationMessages("chat", messages, "user", storage);
  assert.equal(sourcesFromParts(loadConversationMessages("chat", "user", storage)[0].parts)[0].url, sources[0].url);
  assert.equal(sanitizeMessagesForModel(messages)[0].parts?.length, 1);
  assert.equal(sourcesFromParts([{ type: "data-sources", data: { selection: "cited", sources: [{ ...sources[0], url: "javascript:alert(1)", links: [null] }] } }])[0].url, undefined);
});


test("only explicitly cited candidates are selected, not unknown IDs or code examples", () => {
  const sources = webSourcesFromText("标题：甲\nURL：https://example.com/a\n\n标题：乙\nURL：https://example.com/b");
  const citation = `[来源](#${sourceAnchor(sources[1])})`;
  assert.deepEqual(citedSources(`采用乙 ${citation} ${citation} [来源](#source-unknown)`, sources), [sources[1]]);
  assert.deepEqual(citedSources("没有采用资料 https://example.com/a", sources), []);
  assert.deepEqual(citedSources("`" + citation + "`", sources), []);
  assert.deepEqual(sourcesFromParts([{ type: "data-sources", data: { sources } }]), [], "旧的全部检索结果不可作为采用来源展示");
});
