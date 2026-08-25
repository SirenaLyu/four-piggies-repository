# Session 记录:2026-08-23 扩爬 notices + 多步 planning 验证 + 2 bug 修复

> 续 8/18 real-time tools 之后的 session。启动 roadmap Phase 1 step 5(扩 campus_notices 数据)+ step 3(多步 planning 验证),中途暴露 2 个 bug 并修复。所有改动落在 `知识库构建` 分支,**未 push**。

## 起点状态(8/18 real-time tools 之后)

- 4 个 commit 已落 `知识库构建`:`061ea71` `c744217` `fee4a18` `88b0213`
- 11 个 tool(9 语义相似 + 2 real-time),eval 60 条,MRR 0.966
- 已知数据盲区:`campus_notices` 表无考试类通知,eval case"关于考试的通知有哪些"失败
- 用户反馈:"全校课表我是没有权限的可以换一个" → 放弃空教室查询(原 step 2 剩余项),转向 step 5 扩 notices

## 任务清单(7→10,本 session 全部完成)

| # | 任务 | 状态 |
|---|---|---|
| 5 | 扩写 notices 爬虫支持列表页翻页 | ✅ |
| 6 | 跑爬虫验证考试类通知 | ✅(发现考试通知是数据天花板) |
| 7 | 灌 Supabase 并跑 eval 回归 | ✅ |
| 8 | 设计多步 planning 测试集(8 条) | ✅ |
| 9 | 跑多步 planning 端到端测试 | ✅(22/22 全过) |
| 10 | 归档 8/23 session + 更新 memory | ✅(本文件) |

## 改动 1:扩爬虫支持教务处通知列表页翻页

**文件**:`scripts/crawl-ustc-extra.ts`(+209 行)

**问题**:原 `fetchNotices()` 只拉教务处 RSS feed(`feed.xml`),仅覆盖最近 20 条通知。历史通知(如考试安排、上学期选课通知)拿不到。

**方案**:加 `fetchNoticesFromListPages(maxPagesPerCategory)`,直接爬教务处通知列表页 HTML:
- 类目:`notice-teaching`(教学)+ `notice-info`(信息)
- URL 模式:`/notice/{slug}`(p1) + `/notice/{slug}/page/N`(p>=2)
- 解析 `<li class="post-XXX post type-post">` 里的 `<a href>` + `<span class="date">`
- 列表页只给标题+日期+URL,再对每个详情页发请求拿 `author` + `body_preview`(800 字)
- 与 RSS 合并去重(URL 为 key),RSS 已有 body_preview 优先

**用法**:`npx tsx scripts/crawl-ustc-extra.ts --only=notices --notice-pages=10`

**结果**:notices 数据从 20 条扩到 87 条(教学 5 页 + 信息 5 页)。

## 改动 2:重爬 + 灌 Supabase + eval 回归

`D:/ustc-data/notices.{json,csv}` 2026-08-23 19:42 重新生成,87 条。重跑 `feed_crawled_data.ts --only=notices` 灌入 Supabase。

`docs/eval-retrieval-results.md` 2026-08-23 11:47 重新生成,60 条 eval 数字:
- Supabase top-1: 55/58 (94.8%) — 与 8/18 一致
- Supabase MRR: 0.966 — 与 8/18 一致
- 唯一失败 case"关于考试的通知有哪些":top1 从"教学智能体大赛"变成"大学生研究计划结题答辩",**仍失败**

**关键发现**:教务处 `notice-teaching`/`notice-info` 分类下**本来就沒有考试安排通知**。87 条里只有 1 条期末评教通知,没有"期末考试安排""缓考""补考"这类核心考试通知。考试安排走的是综合教务系统(jw.ustc.edu.cn)内网,需登录权限。**这是数据天花板,扩爬虫解决不了**——除非用户能提供考试安排的数据源或登录权限。

## 改动 3:多步 planning 测试集(8 条)

**文件**:`scripts/test-chat-endpoint.mjs`(+51 行,10→14→22 条)

8 条 3+ 步复杂查询,每条标注期望工具序列:

| # | query | 期望工具序列 |
|---|---|---|
| 多步 1 | 我下周二没课,想找个自习的地方,顺便问下附近食堂中午几点开饭 | get_calendar_events_on_date + search_library_hours + search_pois(食堂) |
| 多步 2 | 开学注册期间图书馆开门吗,我从东区怎么坐班车去西区图书馆 | search_calendar + search_library_hours + search_shuttle |
| 多步 3 | 量子力学A 能替代什么课,那些替代课分别是几学分 | find_substitute_courses + search_courses(×4 替代课) |
| 多步 4 | 2026年国庆节放几天假,放假前一天从东区到高新区最晚一班班车几点 | get_calendar_events_on_date + search_shuttle/get_shuttle_on_day |
| 多步 5 | 郭沫若奖学金什么时候公示,公示期间图书馆周末开放吗 | search_scholarships + search_library_hours |
| 多步 6 | 教务处最近发了什么通知,目前有哪些奖学金可以申请 | search_notices + search_scholarships |
| 多步 7 | 周末想去高新区图书馆,顺便坐班车去,该怎么安排 | search_library_hours + get_shuttle_on_day |
| 多步 8 | 东区有哪些 AED 急救设备,附近有什么食堂可以吃饭 | search_pois(AED) + search_pois(食堂) |

## 改动 4:修 2 个 bug

### Bug 1:脏数据过滤失效(`app/lib/tools.ts:407-410`)

**症状**:多步 1 实跑 LLM 回答"校历上该日为'26'",爬虫把教学周数当 event_title 灌进了 `campus_calendar`。

**根因**:原过滤 `event_title.trim().length >= 2` 没拦住 `"26"`(长度正好 2)。数据库里 70 个 distinct event_title 中,约 30 个是纯数字 1-31(教学周数)。

**修复**:改为 `t.length >= 2 && !/^\d+$/.test(t)`——纯数字一律过滤,保留 `"*休"` `"1 劳动节 *休"` `"21 新生报到"` 等含非数字字符的有效 title。

**验证**:`2026-08-25` raw 1 条(title="26")→ cleaned 0 条。LLM 修复后回答"该日是普通教学日(校历无特殊事件)"。

### Bug 2:LLM 多步 3 主动性不足(不二次调工具)

**症状**:多步 3 用户问"那些替代课分别是几学分",8/23 实跑 LLM 只调了 `find_substitute_courses` + `search_courses("量子力学A")`,**没对 4 门替代课分别调 search_courses**,回答"未直接获取到这几门原课程各自的学分数"。

**根因**:不是 step count 瓶颈(`stopWhen: isStepCount(5)` 5 步够用),是 LLM 没意识到要二次调工具。`find_substitute_courses` 返回的 substitutes 列表只含课程名+代码,不含学分。

**修复**:
1. `find_substitute_courses` tool description 加一句:"返回的 substitutes 列表只含课程名+代码,不含学分学时——若用户还问'那些替代课的学分/学时',需对每门替代课继续调 search_courses 查详情"
2. `route.ts` system prompt TOOL_GUIDE 调用原则加一条通用"列表+详情模式":"若一个工具返回的是条目列表而用户问的是每条的详情,必须对列表里每条继续调对应详情工具,不要只回答'未获取到'"

**验证**:多步 3 修复后 LLM 对 4 门替代课都调了 search_courses:量子物理 4 学分、量子力学 3 学分、量子力学B 4 学分、量子力学C 3 学分(还额外查了英文版量子物理 4 学分)。

## 端到端测试结果(22/22 全过)

| 阶段 | 测试集 | 通过 |
|---|---|---|
| 8/23 第一次 | 多步 1-4(修复前) | 4/4 回答合理,但暴露 bug 1 + bug 2 |
| 8/25 修复后 | 多步 1、3、5、6、7、8 | 6/6 |
| 8/25 修复后 | 多步 2、4 + 14 旧 case 回归 | 16/16 |
| **合计** | **22 条** | **22/22** |

## 仍红 / 不在本次范围

- **eval case"关于考试的通知有哪些"** 仍失败——数据天花板,教务处公开通知分类无考试安排,需登录权限或手写补充
- **Dify "周末有班车吗" reranker 失败**(8/16 老 bug)—— eval 层面仍失败,端到端已通过 get_shuttle_on_day 根治
- **eval 集扩到 100+ 条** —— roadmap Phase 1 step 4,留后续
- **re-feed campus_documents**(空表)+ search_documents 通用工具 —— roadmap Phase 1 step 6,留后续
- **空教室查询** —— 用户无全校课表权限,放弃
- **prompts.ts 文件清理** —— 退役文件仍未删,以防回退
- **多步 5 LLM 风格小瑕疵** —— 第一次回答后说"我需要进一步确认"又调一次 search_library_hours,啰嗦但正确,非 bug

## Git 状态(8/25 收尾)

- 本地 `main`:22 ahead / 1 behind `origin/main`(分叉保留)
- 本地 `知识库构建`:`88b0213` 之上新增 4 个 commit(待提交):
  - feat(crawl): 扩写 notices 爬虫支持列表页翻页
  - fix(tools): 脏数据过滤改为排除纯数字 event_title
  - feat(chat): system prompt 加"列表+详情"多步引导 + find_substitute_courses description 补二次调工具说明
  - test: 多步 planning 测试集扩到 8 条 + 归档 8/23 session
- 工作树:本次改动提交后干净

## 下一步候选(未启动)

按 roadmap `project_roadmap.md`:

1. **Phase 1 step 4**:eval 集扩到 100+ 条 —— 跟多步 planning 测试集一起扩,加 40+ 条覆盖多步 + real-time + 跨类场景
2. **Phase 1 step 6**:re-feed campus_documents(空表)+ 加 search_documents 通用工具 —— 手写校园政策数据(保研/学籍/学位)
3. **Phase 2**:user identity + cross-session memory + 校园日历订阅

See [[session-2026-08-18-realtime-tools]] for the prerequisite real-time tools, [[session-2026-08-18-tool-calling]] for the 9-tool refactor, [[project_roadmap]] for the 3-phase plan.
