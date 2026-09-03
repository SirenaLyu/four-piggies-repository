import assert from "node:assert/strict";
import test from "node:test";
import {
  modelHistoryLimit,
  selectRecentMessages,
  shouldPrefetchKnowledge,
} from "./chat-performance.ts";

test("稳定校园问题进入知识库快速路径", () => {
  assert.equal(shouldPrefetchKnowledge("科大食堂有哪些？"), true);
  assert.equal(shouldPrefetchKnowledge("图书馆怎么借书？"), true);
});

test("实时问题保留联网与工具判断流程", () => {
  assert.equal(shouldPrefetchKnowledge("科大今天有什么最新通知？"), false);
  assert.equal(shouldPrefetchKnowledge("合肥现在天气怎么样？"), false);
});

test("通用申请问题不会被误判为校园知识库问题", () => {
  assert.equal(shouldPrefetchKnowledge("如何申请美国研究生？"), false);
});

test("长对话只保留最近消息并从用户轮次开始", () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    id: index,
  }));
  const selected = selectRecentMessages(messages, 9);
  assert.equal(selected.length, 8);
  assert.equal(selected[0].role, "user");
  assert.equal(selected.at(-1)?.id, 29);
});

test("历史消息上限具有安全范围", () => {
  assert.equal(modelHistoryLimit(undefined), 24);
  assert.equal(modelHistoryLimit("2"), 6);
  assert.equal(modelHistoryLimit("100"), 50);
});
