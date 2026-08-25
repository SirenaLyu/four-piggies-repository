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
  // ===== 8/18 新增 real-time 工具测试 =====
  {
    name: "real-time calendar 按日期查询(2026-10-01 国庆)",
    query: "2026年10月1日是节假日吗,校历上写什么",
    expectKeywords: ["国庆", "休"],
  },
  {
    name: "real-time calendar 相对日期(明天)",
    query: "明天校历上有什么安排",
    expectKeywords: ["2026-08", "校历"],
  },
  {
    name: "real-time shuttle 周末过滤(根治 8/16 Dify 失败)",
    query: "周末有班车吗",
    expectKeywords: ["周末", "班"], // 期望回答"周末无班次"
  },
  {
    name: "real-time shuttle 工作日过滤",
    query: "工作日去高新园区有哪些班次",
    expectKeywords: ["高新", "班"],
  },
  // ===== 8/23 多步 planning 测试(3+ 步复杂查询) =====
  // 每条标注期望工具序列;expectKeywords 是最终回答里应当出现的关键词
  // 目的:验证 LLM 在 stopWhen=isStepCount(5) 下能否正确串行/并行调多工具
  {
    name: "多步 1:下周二没课找自习室+附近食堂中餐时间",
    query: "我下周二没课,想找个自习的地方,顺便问下附近食堂中午几点开饭",
    expectKeywords: ["图书馆", "食堂"], // 期望调 search_pois/search_library_hours + search_library_hours 或 search_pois 食堂
    expectedTools: ["search_pois 或 search_library_hours", "search_pois(食堂)"],
  },
  {
    name: "多步 2:开学注册期间图书馆开门吗+怎么坐班车去",
    query: "开学注册期间图书馆开门吗,我从东区怎么坐班车去西区图书馆",
    expectKeywords: ["图书馆", "班车"],
    expectedTools: ["search_calendar", "search_library_hours", "search_shuttle"],
  },
  {
    name: "多步 3:查一门课的替代课+那些替代课的学分",
    query: "量子力学A 能替代什么课,那些替代课分别是几学分",
    expectKeywords: ["量子力学", "学分"],
    expectedTools: ["find_substitute_courses", "search_courses"],
  },
  {
    name: "多步 4:国庆节放假+放假前一天班车最晚几点",
    query: "2026年国庆节放几天假,放假前一天从东区到高新区最晚一班班车几点",
    expectKeywords: ["国庆", "班车"],
    expectedTools: ["get_calendar_events_on_date", "search_shuttle 或 get_shuttle_on_day"],
  },
  {
    name: "多步 5:郭沫若奖学金公示期+期间图书馆开放时间",
    query: "郭沫若奖学金什么时候公示,公示期间图书馆周末开放吗",
    expectKeywords: ["郭沫若", "图书馆"],
    expectedTools: ["search_scholarships", "search_library_hours"],
  },
  {
    name: "多步 6:东区最近通知+有哪些奖学金可申请",
    query: "教务处最近发了什么通知,目前有哪些奖学金可以申请",
    expectKeywords: ["通知", "奖学金"],
    expectedTools: ["search_notices", "search_scholarships"],
  },
  {
    name: "多步 7:周末去高新图书馆+顺便坐班车",
    query: "周末想去高新区图书馆,顺便坐班车去,该怎么安排",
    expectKeywords: ["图书馆", "班车"],
    expectedTools: ["search_library_hours", "get_shuttle_on_day"],
  },
  {
    name: "多步 8:查 AED 位置+最近的食堂",
    query: "东区有哪些 AED 急救设备,附近有什么食堂可以吃饭",
    expectKeywords: ["AED", "食堂"],
    expectedTools: ["search_pois(AED)", "search_pois(食堂)"],
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
