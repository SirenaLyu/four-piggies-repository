/**
 * 验证 deepseek-v4-flash-ascend 是否支持 OpenAI function-calling 协议。
 *
 * tool calling 重构的前置条件:如果模型不支持 tools 参数,LLM 会忽略工具定义,
 * 直接输出文本回答,那么重构方案要降级(JSON 模式 + 自定义解析)。
 *
 * 用法:npx tsx scripts/test-tool-calling.mjs
 */
import * as fs from "fs";
const envText = fs.readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const k = trimmed.slice(0, eq).trim();
  let v = trimmed.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[k] = v;
}

const { streamText, tool, isStepCount, jsonSchema } = await import("ai");
const { createOpenAI } = await import("@ai-sdk/openai");

const chatClient = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
  name: "campus-chat",
});
const CHAT_MODEL = "deepseek-v4-flash-ascend";

// 一个最简工具:返回硬编码校历事件,只验证 LLM 是否能正确触发 tool_call
const fakeCalendarTool = tool({
  description:
    "查询中国科学技术大学校历、学期安排、开学放假时间、考试周、节假日。当用户问任何与校历/开学/放假/学期时间有关的问题时调用此工具。",
  inputSchema: jsonSchema({
    type: "object",
    properties: {
      query: { type: "string", description: "用户关于校历的具体问题" },
    },
    required: ["query"],
  }),
  execute: async ({ query }) => {
    console.log(`  [tool execute] search_calendar called with query="${query}"`);
    return {
      events: [
        {
          event_title: "老生开学注册",
          start_date: "2026-08-30",
          end_date: "2026-08-30",
          academic_year: "2026",
          semester: "秋季",
          source_url: "https://www.ustc.edu.cn/calendar/2026-fall",
        },
      ],
    };
  },
});

const queries = [
  "2026 秋季什么时候开学",
  "你好", // 无关问句,LLM 应该不调工具直接回复
];

for (const q of queries) {
  console.log(`\n=== query: "${q}" ===`);
  const result = streamText({
    model: chatClient.chat(CHAT_MODEL),
    system:
      "你是中国科学技术大学智能校园助手。当用户问题与校历/开学/放假时间有关时,调用 search_calendar 工具获取准确信息后再回答;否则直接回复。",
    tools: { search_calendar: fakeCalendarTool },
    stopWhen: isStepCount(3),
    messages: [{ role: "user", content: q }],
  });

  let text = "";
  for await (const chunk of result.textStream) {
    text += chunk;
  }
  console.log(`  final text: ${text.slice(0, 200)}`);

  // 看 steps 里是否触发了 tool call
  const steps = await result.steps;
  console.log(`  steps count: ${steps.length}`);
  for (const [i, step] of steps.entries()) {
    const toolCalls = step.toolCalls ?? [];
    console.log(
      `  step ${i}: finishReason=${step.finishReason}, toolCalls=${JSON.stringify(
        toolCalls.map((c) => ({ name: c.toolName, input: c.input })),
      )}`,
    );
  }
}
