# Session 记录:2026-08-18 real-time tools 落地

> Phase 1 step 2 的前半段:加 2 个 real-time 工具(`get_calendar_events_on_date` / `get_shuttle_on_day`),eval 集从 47 条扩到 60 条,端到端测试脚本加 4 条 real-time case。两个 commit:`fee4a18` + `88b0213`,均在 `知识库构建` 分支,**未 push**。

## 起点状态(8/18 tool calling 重构后)

- `061ea71` + `c744217` 完成 9 工具 tool calling 重构,10/10 端到端全过,eval 数字与 8/17 完全一致
- 但 8/16 Dify eval 失败的"周末有班车吗"在 tool calling 层面仍未根治——`search_shuttle` 是语义相似查询,reranker 会把东区→西区点对点排到 top1,LLM 看到一堆工作日班次很难自信回答"周末无班次"
- "下周二/2026-10-01 是节假日吗"这类按具体日期判断的问题,`search_calendar` 也只是语义相似——爬虫数据里有单字符脏 title(`"26"`),LLM 容易抓错
- roadmap Phase 1 step 2 是 real-time tools,8/18 把其中两个**基于已有数据可做**的先做了(无需新爬虫);空教室查询需要爬教务处实时页面,留给后续

## 关键设计决策

### 1. 两个新工具:语义查询 vs 精确过滤

| 工具 | 后端查询 | 与原 search_* 的正交关系 |
|---|---|---|
| `get_calendar_events_on_date(date)` | `start_date <= date AND end_date >= date` 范围查 | `search_calendar` 是语义相似(适合"什么时候开学"),新工具是精确日期过滤(适合"2026-10-01 有课吗") |
| `get_shuttle_on_day(weekday)` | `weekday_only = 'false'` (周末)或全部(工作日) | `search_shuttle` 是语义相似(适合"去高新园区几点"),新工具是按星期过滤(适合"周末有班车吗") |

**Why 两套并存而不是替换**:语义相似和精确过滤是两种正交的查询意图。问"什么时候开学"不应该精确过滤某一天,问"周末有班车吗"不应该靠 reranker 猜"周末"≈"周六周日"。LLM 在 TOOL_GUIDE 里看到明确选择指引,自己选对。

### 2. `get_calendar_events_on_date` 的脏数据过滤

爬虫灌进 `campus_calendar` 的部分条目 title 是单字符(`"26"`),是页面解析 bug 残留。新工具 execute 里加 `length(title) > 1` 过滤,避免 LLM 收到 `title: "26"` 这种无意义返回。爬虫脚本本身的修复留给后续(数据脏了治本在爬虫,治标在查询)。

### 3. `get_shuttle_on_day` 的 weekday 语义

shuttle 表 `weekday_only` 字段是 boolean 文本:
- `'true'`:仅工作日运行
- `'false'`:每日运行(含周末)

`get_shuttle_on_day("周末")` 只查 `weekday_only = 'false'`;`get_shuttle_on_day("工作日")` 查全部。8/18 验证 shuttle 表 29 条全部是 `'true'`(工作日班次),所以"周末有班车吗"会返回 0 条,LLM 明确回答"周末无班次记录"——根治 8/16 Dify reranker 老 bug。

### 4. system prompt 注入当前日期

route.ts `buildSystemPrompt()` 加一段:
```
当前日期:YYYY-MM-DD(星期X)。用户说"下周二/这周五/明天"等相对日期时,以此为准推算具体 YYYY-MM-DD。
```
让 LLM 能把"明天"→ `2026-08-19`、"下周二"→ 具体日期,再传给 `get_calendar_events_on_date`。TOOL_GUIDE 里也明确写:"用户说'下周二/这周五'等相对日期时,先用今天日期(系统已知)推算出具体 YYYY-MM-DD 再调 get_calendar_events_on_date"。

### 5. TOOL_GUIDE 加选择指引

route.ts system prompt 的 TOOL_GUIDE 列出 11 个工具,并对每个 real-time 工具明确"何时调我,不要用 search_*":
```
- get_calendar_events_on_date:按具体日期(YYYY-MM-DD)查校历事件——回答"下周二/8月25日有课吗"这类问题用这个,不要用 search_calendar
- get_shuttle_on_day:按星期几精确过滤班车——回答"周末有班车吗""工作日班次"用这个,不要用 search_shuttle
```

防止 LLM 习惯性调语义相似工具(因为它在 9 工具集里用了很久)。8/18 端到端测试验证 LLM 确实选对了。

## 改动文件

| 文件 | 改动 |
|---|---|
| `app/lib/tools.ts` | 新增 `getCalendarEventsOnDateTool` + `getShuttleOnDayTool` 两个 tool 定义,`campusTools` 集合扩到 11 个 |
| `app/api/chat/route.ts` | `buildSystemPrompt()` 加当前日期注入;TOOL_GUIDE 加 2 个新工具说明 + 选择指引(119 行) |
| `scripts/eval-retrieval.ts` | 47→60 条 eval(+13 覆盖原 9 工具弱场景) |
| `scripts/test-chat-endpoint.mjs` | 加 4 条 real-time 测试 case(10→14 条) |
| `docs/eval-retrieval-results.md` | eval 重新生成(60 条) |

未改但相关:
- `app/lib/classifier.ts`:仍是 hint,未动
- `app/lib/dify.ts`:仍被 `search_dify_fallback` 复用,未动
- `app/lib/prompts.ts`:仍退役未删,未动

## eval 集扩到 60 条(+13 覆盖原 9 工具弱场景)

| 类目 | 新增 | 内容 |
|---|---|---|
| calendar | +3 | 多学期聚合 / 范围事件 / 具体学期+事件类型 |
| shuttle | +3 | 边界校区 / 时段聚合 / 返程最晚时段 |
| notices | +2 | 多通知聚合 / 类别过滤 |
| library | +1 | 分馆+楼层+服务三重限定 |
| scholarships | +1 | 联系方式专项 |
| poi | +1 | AED 通用查询(不限具体楼宇) |
| courses | +1 | 英文名查询 |
| 跨类多步 | +1 | library 主 + shuttle 副 |

## eval 结果(60 条,8/18 重新生成)

| 指标 | 8/17 基线(47 条) | 8/18 real-time 后(60 条) |
|---|---|---|
| 分类器 primary 准确率 | 93.6% (44/47) | 93.3% (56/60) |
| Supabase top-1 | 95.6% (43/45) | 94.8% (55/58) |
| Supabase top-3 | 100% (45/45) | 98.3% (57/58) |
| Supabase MRR | 0.978 | 0.966 |
| Supabase 失败案例 | 0 | 1 条 |

> 注:eval 数字小幅回退是**因为 eval 集本身变难了**(多了 13 条覆盖弱场景的 case),不是检索能力下降。新增 13 条里 12/13 通过。

### 唯一失败 case

**"关于考试的通知有哪些"** 期望 `notices`,分类也对 `notices`,但 top1 是"关于转发首届教学智能体大赛的通知"。
- 原因:`campus_notices` 表里**没有考试类通知**(数据盲区)
- 不是分类/检索 bug,是数据覆盖问题
- LLM 端到端会诚实回答"暂无关于考试的通知"(`NO_HALLUCINATION_FOOTER` 生效)

## 端到端测试结果(14/14 全过)

新增 4 条 real-time case 全过:

| # | name | query | 期望关键词命中 |
|---|---|---|---|
| 11 | real-time calendar 按日期查询 | 2026年10月1日是节假日吗,校历上写什么 | 国庆/休 ✓ |
| 12 | real-time calendar 相对日期 | 明天校历上有什么安排 | 2026-08/校历 ✓ |
| 13 | real-time shuttle 周末过滤 | 周末有班车吗 | 周末/班 ✓ |
| 14 | real-time shuttle 工作日过滤 | 工作日去高新园区有哪些班次 | 高新/班 ✓ |

特别值得注意:
- case 13 "周末有班车吗" LLM 正确调 `get_shuttle_on_day("周末")`,收到 0 条返回,回答"周末无班次记录"——8/16 Dify reranker 老 bug 在端到端层面根治
- case 11 "2026-10-01 是节假日吗" LLM 正确调 `get_calendar_events_on_date("2026-10-01")`,收到"国庆 休",回答里含"国庆"和"休"
- case 12 "明天校历上有什么安排" LLM 解析"明天"为 `2026-08-19`,调 `get_calendar_events_on_date("2026-08-19")`,返回无事件,回答"2026-08-19 普通教学日"——system prompt 日期注入生效

## 仍红 / 不在本次范围

- **Dify "周末有班车吗" reranker 失败**(8/16 老 bug)—— Dify eval 层面仍失败,但端到端层面 `get_shuttle_on_day` 已根治(LLM 不走 Dify 兜底)
- **"关于考试的通知有哪些"** —— 数据盲区(notices 表无考试类),需扩爬教务处通知分类
- **跨类目 secondary 5 条 ✗** —— 不影响 tool calling LLM 的实际多步表现
- **空教室查询** —— roadmap Phase 1 step 2 剩余项,需爬教务处实时页面
- **eval 集扩到 100+ 条** —— 跟 roadmap Phase 1 step 3 一起做更划算
- **前端 tool UI 展示** —— roadmap Phase 2
- **prompts.ts 文件清理** —— 仍未删,以防回退

## 下一步候选(未启动)

按 roadmap `project_roadmap.md`:

1. **Phase 1 step 2 剩余:空教室查询 real-time 工具** —— 爬 USTC 教务处实时页面
2. **Phase 1 step 3:多步 planning 验证** —— 设计 3+ 步复杂查询测试集,验证 LLM 串行调 5 工具能力上限
3. **Phase 1 step 4:eval 集扩到 100+ 条** —— 跟 step 3 一起做
4. **Phase 1 step 5:重新灌 `campus_documents`** —— Supabase `campus_documents` 表仍空,可手写校园政策数据 + 加 `search_documents` 通用工具

## Git 状态(8/18 收尾)

- 本地 `main`:22 ahead / 1 behind `origin/main`(分叉保留)
- 本地 `知识库构建`:`c744217` 之上新增 2 个 commit(`fee4a18` + `88b0213`),**未 push** `origin/知识库构建`(按 [[feedback_commits]] 偏好)
- 工作树干净

See [[session-2026-08-18-tool-calling]] for the prerequisite 9-tool refactor, [[project_roadmap]] for the 3-phase plan (Phase 1 step 2 partially done, remaining is 空教室查询).
