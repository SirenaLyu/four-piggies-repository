import assert from "node:assert/strict";
import test from "node:test";
import {
  agentFinalAnswerStep,
  modelHistoryLimit,
  selectRecentMessages,
  shouldDualChannelPrefetch,
  shouldPrefetchKnowledge,
  shouldUseAgentTools,
} from "./chat-performance.ts";

test("稳定校园问题进入知识库快速路径", () => {
  assert.equal(shouldPrefetchKnowledge("科大食堂有哪些？"), true);
  assert.equal(
    shouldPrefetchKnowledge("东区美食广场在哪里，晚餐到几点？"),
    true,
  );
  assert.equal(
    shouldPrefetchKnowledge("雪迪龙科技创新奖学金公示的联系人和办公地点"),
    true,
  );
  assert.equal(shouldPrefetchKnowledge("图书馆怎么借书？"), true);
});

test("实时问题保留联网与工具判断流程", () => {
  assert.equal(shouldPrefetchKnowledge("科大今天有什么最新通知？"), false);
  assert.equal(
    shouldPrefetchKnowledge("科大最新奖学金公示的联系人和截止时间"),
    false,
  );
  assert.equal(shouldPrefetchKnowledge("合肥现在天气怎么样？"), false);
});

test("稳定校园主题叠加时效词触发双通道并行预取", () => {
  assert.equal(
    shouldDualChannelPrefetch("科大最新的奖学金评定政策是什么？"),
    true,
  );
  assert.equal(
    shouldDualChannelPrefetch("图书馆最近的开闭馆时间有变更吗"),
    true,
  );
  // 纯稳定问题保持知识库单通道，不额外发起联网检索。
  assert.equal(shouldDualChannelPrefetch("图书馆怎么借书？"), false);
  // 纯时效问题无稳定校园主题，不触发双通道。
  assert.equal(shouldDualChannelPrefetch("合肥现在天气怎么样？"), false);
  // 过短查询不触发。
  assert.equal(shouldDualChannelPrefetch("奖学金"), false);
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

test("Agent 开关只在本地项目意图出现时激活工具", () => {
  assert.equal(shouldUseAgentTools("请分析 C:\\work\\demo 里的代码"), true);
  assert.equal(shouldUseAgentTools("帮我修改项目中的 package.json"), true);
  assert.equal(shouldUseAgentTools("科大食堂几点关门？"), false);
});

test("Agent 修改任务获得比只读任务更高的动态步数预算", () => {
  assert.equal(agentFinalAnswerStep("读取项目 README 文件"), 5);
  assert.equal(agentFinalAnswerStep("修改项目代码并运行测试"), 7);
});
