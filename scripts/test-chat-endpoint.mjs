/**
 * 端到端验证 tool calling 重构后的 /api/chat 端点
 *
 * 发几条典型查询,记录 LLM 调了哪些工具、最终回答是否符合预期。
 * 这个脚本不直接 inspect tool 调用(因为 route.ts 用 createTextStreamResponse 纯文本流),
 * 只看最终文本回答里有没有命中期望关键词。
 *
 * 用法:npx tsx scripts/test-chat-endpoint.mjs
 */
const queries = [
  {
    name: "calendar 单类",
    query: "2026 秋季什么时候开学",
    expectKeywords: ["8月30日", "开学", "注册"],
  },
  {
    name: "shuttle 单类",
    query: "去高新园区坐班车几点发车",
    expectKeywords: ["高新", "班车", "发车"],
  },
  {
    name: "notices 单类(8/16 修复点)",
    query: "本科生选课什么时候开始",
    expectKeywords: ["选课", "通知"],
  },
  {
    name: "library 单类",
    query: "东区图书馆周末开放吗",
    expectKeywords: ["东区", "图书馆", "开放"],
  },
  {
    name: "scholarships 单类",
    query: "郭沫若奖学金什么时候公示",
    expectKeywords: ["郭沫若", "奖学金"],
  },
  {
    name: "poi 单类(8/17 规则 C)",
    query: "东区学生食堂在哪个校区",
    expectKeywords: ["东区", "食堂", "校区"],
  },
  {
    name: "courses 单类",
    query: "课程代码 022059 是什么课",
    expectKeywords: ["022059", "课程"],
  },
  {
    name: "courses 替代查询",
    query: "量子力学A 能替代什么课",
    expectKeywords: ["量子力学", "替代"],
  },
  {
    name: "跨类 query(library+shuttle)",
    query: "去图书馆坐班车几点",
    expectKeywords: ["图书馆", "班车"],
  },
  {
    name: "多步查询(poi+library)",
    query: "我下周想找地方自习,顺便问下图书馆开放时间",
    expectKeywords: ["图书馆", "开放"],
  },
];

let pass = 0;
let fail = 0;
const failures = [];

for (const { name, query, expectKeywords } of queries) {
  process.stdout.write(`\n=== ${name}: "${query}" ===\n`);
  try {
    const res = await fetch("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // UIMessage 格式(前端 useChat 发的):{ id, role, parts: [{ type: "text", text }] }
        messages: [
          {
            id: `test-${Date.now()}`,
            role: "user",
            parts: [{ type: "text", text: query }],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.log(`  HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      fail++;
      failures.push({ name, reason: `HTTP ${res.status}` });
      continue;
    }
    const text = await res.text();
    console.log(`  response (${text.length} chars): ${text.slice(0, 400)}${text.length > 400 ? "..." : ""}`);

    const hitKeywords = expectKeywords.filter((k) => text.includes(k));
    if (hitKeywords.length === 0) {
      console.log(`  ✗ FAIL: 没命中任何期望关键词 ${JSON.stringify(expectKeywords)}`);
      fail++;
      failures.push({ name, reason: `no keyword hit, expected ${JSON.stringify(expectKeywords)}` });
    } else {
      console.log(`  ✓ PASS: 命中 ${JSON.stringify(hitKeywords)}`);
      pass++;
    }
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
    fail++;
    failures.push({ name, reason: err.message });
  }
}

console.log(`\n\n=== 总结:${pass} pass / ${fail} fail ===`);
if (failures.length) {
  console.log("失败:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.reason}`);
  process.exit(1);
}
