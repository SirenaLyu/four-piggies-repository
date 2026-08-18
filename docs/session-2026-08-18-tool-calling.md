# Session 记录:2026-08-18 tool calling 重构

> Phase 1 step 1 落地:把分类路由 RAG 升级成 LLM 自主 tool calling。9 个检索函数包成 AI SDK v7 tools,LLM 自己决定调哪个/哪几个/什么顺序,可以多步推理。

## 起点状态(8/17 收尾)

- 8/17 完成"规则层补 4 条弱信号 eval"(commit `ff4d714`,已 push 到 `origin/知识库构建`)
- Supabase top-1 95.6% / top-3 100% / MRR 0.978 / 失败 0
- 归档 `session-2026-08-16-eval-fixes.md` 列了 4 个下一步候选,8/17 做的是第 1 项(规则层)
- roadmap `project_roadmap.md` 推荐的 Phase 1 step 1 是 tool calling 重构 —— 8/18 接这个

## 关键设计决策

### 1. 工具集(9 个)

| 工具 | 后端 | 对应原 route.ts 函数 |
|---|---|---|
| `search_calendar` | `match_calendar` RPC | searchCalendar |
| `search_shuttle` | `match_shuttle` RPC | searchShuttle |
| `search_notices` | `match_notices` RPC | searchNotices |
| `search_library_hours` | `match_library_hours` RPC | searchLibraryHours |
| `search_scholarships` | `match_scholarships` RPC | searchScholarships |
| `search_pois` | `match_pois` RPC | searchPois |
| `search_courses` | `match_courses` + ilike 反查 | searchCourses |
| `find_substitute_courses` | `find_substitute_courses` RPC | searchSubstitutes |
| `search_dify_fallback` | `searchDifyAll` 跨 5 库 | (新,替代 difyFallbackPrompt 逻辑) |

每个工具:
- 内部自己 `embed(query)`(不依赖外层共享向量,因为 LLM 可能用与原问句不同的措辞调工具)
- 返回**结构化 JSON**(`{ count, results: [...] }`)而不是字符串 —— 让 LLM 看清字段名自由组织回答
- `description` 写清楚"什么时候应该调我",覆盖原 prompts.ts 的类目路由意图

### 2. classifier.ts / prompts.ts 的命运

- `classifier.ts`:**保留**,但不再驱动路由。改成给 LLM 的 system prompt 加一条 hint:"基于 embedding 分类器,这条问题最相关的类目可能是 X 或 Y" —— 降低 LLM 调错工具的概率,但不强制约束。失败就不带 hint,LLM 自主决策。
- `prompts.ts`:8 个分类模板**全部退役**(本次未删文件,但 route.ts 不再 import)。通用部分(`BASE_IDENTITY` / `FORMAT_RULES` / `NO_HALLUCINATION_FOOTER`)合并到 route.ts 的 `buildSystemPrompt(hint)` 函数里。类目专属格式约定移到 tool description(让 LLM 调工具时就知道返回字段含义)。
- `dify.ts`:`searchDifyAll` 仍被 `search_dify_fallback` 工具复用。`searchDify`(单库)和 `difySupports` 这次没被引用,保留备用。

### 3. `stopWhen: isStepCount(5)`

AI SDK v7 用 `stopWhen: isStepCount(N)` 替代旧版 `maxSteps: N`。设 N=5,允许 LLM 最多串行调 5 个工具(够覆盖"找自习教室→查食堂→查营业时间"3 步查询,留余量)。

### 4. 前端不动

`useChat` + `TextStreamChatTransport` + `createTextStreamResponse` 这套纯文本流接口保持不变。tool 调用过程对前端透明,LLM 最终生成文本回答,前端只看 text stream。本次不引入 tool UI 展示(roadmap Phase 2 再做)。

### 5. eval 脚本完全不动

`scripts/eval-retrieval.ts` 评估的是**检索质量**(classifier 路由 + RPC 召回),不是端到端回答质量。tool calling 重构不改变 classifier/RPC,所以 eval 数字应当**完全不变**。回归验证主要靠 eval(不变)+ 新写的端到端脚本 `scripts/test-chat-endpoint.mjs`(看 LLM 在真实工具集下能否正确路由 + 多步推理)。

## 前置验证:DeepSeek 支持 tool calling

写代码前先验证中科大 API 代理的 `deepseek-v4-flash-ascend` 是否支持 OpenAI function-calling 协议。`scripts/test-tool-calling.mjs` 用一个最简 `search_calendar` 工具测两条 query:

- "2026 秋季什么时候开学" → LLM 触发 `search_calendar` 工具调用,把口语化问句重写成 "2026年秋季学期开学时间" 作为 input。step 1 用工具返回的结构化 JSON 生成最终文本回答。**两步完成,完美。**
- "你好" → 1 步,无 tool call,直接文本回复。**说明 LLM 不会滥用工具。**

两点都满足重构前提。

## 改动文件

| 文件 | 改动 |
|---|---|
| `app/lib/tools.ts` | **新建**,9 个 tool 定义 + `campusTools` 集合 |
| `app/api/chat/route.ts` | **重写**,从 432 行的 searchRouted + 模板选择逻辑简化成 112 行的 `streamText({ tools, stopWhen })` |
| `scripts/test-tool-calling.mjs` | **新建**,前置验证脚本,确认 DeepSeek 支持 tool calling |
| `scripts/test-chat-endpoint.mjs` | **新建**,端到端测试 10 条典型 query |
| `docs/session-2026-08-18-tool-calling.md` | **新建**,本文件 |
| `docs/eval-retrieval-results.md` | eval 回归重新生成(数字与 8/17 完全一致) |

未改但相关:
- `app/lib/classifier.ts`:仍被 route.ts 作为 hint 调用,代码未动
- `app/lib/prompts.ts`:route.ts 不再 import,但文件保留(暂不删,以防回退)
- `app/lib/dify.ts`:仍被 tools.ts 的 `search_dify_fallback` 复用

## 端到端测试结果(10/10 全过)

`scripts/test-chat-endpoint.mjs` 测了 10 条典型 query,全过:

| # | 类别 | query | 期望关键词命中 |
|---|---|---|---|
| 1 | calendar 单类 | 2026 秋季什么时候开学 | 开学/注册 ✓ |
| 2 | shuttle 单类 | 去高新园区坐班车几点发车 | 高新/班车/发车 ✓ |
| 3 | notices 单类(8/16 修复点) | 本科生选课什么时候开始 | 选课/通知 ✓ |
| 4 | library 单类 | 东区图书馆周末开放吗 | 东区/图书馆/开放 ✓ |
| 5 | scholarships 单类 | 郭沫若奖学金什么时候公示 | 郭沫若/奖学金 ✓ |
| 6 | poi 单类(8/17 规则 C) | 东区学生食堂在哪个校区 | 东区/食堂/校区 ✓ |
| 7 | courses 单类 | 课程代码 022059 是什么课 | 022059/课程 ✓ |
| 8 | courses 替代查询 | 量子力学A 能替代什么课 | 量子力学/替代 ✓ |
| 9 | 跨类 query(library+shuttle) | 去图书馆坐班车几点 | 图书馆/班车 ✓ |
| 10 | 多步查询(poi+library) | 我下周想找地方自习,顺便问下图书馆开放时间 | 图书馆/开放 ✓ |

特别值得注意的几个观察:

1. **多步查询天然支持** —— case 9 "去图书馆坐班车几点" LLM 同时调了 `search_pois`(找图书馆位置)+ `search_shuttle`(找班车),输出里两类信息都有。这是分类路由 RAG 时代做不到的(分类器只能选 1-2 类,会丢第三类信息)。
2. **case 10 "我下周想找地方自习,顺便问下图书馆开放时间"** —— LLM 主动调了 `search_library_hours`,且明确告诉用户"自习教室地点的搜索没有返回具体的教学楼自习安排"(说明也调了 `search_pois` 但空了,如实说明)—— "诚实不臆测"行为生效。
3. **case 7 课程代码反查** —— ilike 反查路径正确触发,返回 量子力学B 80 学时 4 学分,且识别出"既是原课程也是替代课程"角色信息。
4. **case 8 课程替代查询** —— LLM 正确选择 `find_substitute_courses` 工具(而不是 `search_courses`),把课程名"量子力学A"作为 input 传入。tool description 写的"只传课程名,不要带'能替代什么课'等修饰词"指引生效。
5. **格式约定全部遵守** —— emoji 标签、🔗 链接、换行分条,跟 8/16 prompt 模板约束的效果一致甚至更好。

## Eval 回归(数字与 8/17 完全一致)

| 指标 | 8/17 基线 | 8/18 tool calling 后 | 变化 |
|---|---|---|---|
| 分类器 primary 准确率 | 93.6% (44/47) | 93.6% (44/47) | 不变(逻辑没动) |
| Supabase top-1 | 95.6% (43/45) | 95.6% (43/45) | 不变 |
| Supabase top-3 | 100% (45/45) | 100% (45/45) | 不变 |
| Supabase MRR | 0.978 | 0.978 | 不变 |
| Supabase 失败案例 | 0 条 | 0 条 | 不变 |
| Dify MRR | 0.955 | 0.955 | 不变 |

证明 tool calling 重构**没有破坏任何检索召回**(因为 classifier + RPC 都没动)。LLM 现在是在这套已验证的检索能力之上自主决策。

## 关键陷阱(本次踩过的)

1. **`inputSchema` 不能裸传 JSON schema 对象** —— `tool()` 的 `inputSchema` 期望 `Schema<INPUT>` 类型,裸传 `{ type: "object", ... }` 会被推断成 `Schema<unknown>`,导致 `execute` 参数被推成 `never`,TS 报 `No overload matches this call`。解决:用 `jsonSchema<{ query: string }>({ ... })` 显式给类型参数。本次 9 个 tool 全踩了,批量改完才过 tsc。
2. **`convertToModelMessages` 期望 UIMessage 格式而不是 ModelMessage** —— 它的签名是 `Array<Omit<UIMessage, 'id'>>`,即 `{ role, parts: [{ type: "text", text }] }`。如果传 `{ role, content: "..." }`(ModelMessage 格式),运行时报 `Cannot read properties of undefined (reading 'map')`。解决:测试脚本 `test-chat-endpoint.mjs` 改成发 UIMessage 格式。生产前端 `useChat` 本来就发 UIMessage,无影响。
3. **`scripts/*.mjs` 是纯 ESM 不支持 TS 语法** —— `(err as Error).message` 在 `.mjs` 里报 `SyntaxError: Unexpected identifier 'as'`。要么用 `.ts` + tsx,要么 `.mjs` 里写纯 JS(`err.message`)。

## 仍红 / 不在本次范围

- **Dify "周末有班车吗" reranker 失败**(8/16 老 bug)—— reranker 对中文短文本 CSV 偏置,需单独调,本次不动 Dify
- **跨类目 secondary 3 条 ✗**("量子力学A能代替什么课" / "开学注册期间图书馆开门吗" / "选课期间有什么奖学金可以申请")—— 这是 classifier 的 secondary 判断,不影响 tool calling LLM 的实际表现(LLM 在 case 9/10 已经能自己跨类多步查询)。优先级低。
- **eval 集扩到 100+ 条** —— 跟 roadmap Phase 1 step 3 一起做更划算
- **real-time tools(校历查询/空教室查询)** —— roadmap Phase 1 step 2,需要先爬 USTC 教务处实时页面
- **前端 tool UI 展示** —— roadmap Phase 2,让用户看到 LLM 调了哪些工具
- **prompts.ts 文件清理** —— 本次没删,以防回退。下次确认稳定后删

## 下一步候选(未启动)

按 roadmap `project_roadmap.md`:

1. **Phase 1 step 2:real-time tools** —— 爬 USTC 教务处通知/校车页面,做成 LLM 可调的实时工具(目前 9 个工具都是查静态库)
2. **Phase 1 step 3:多步 planning 验证** —— 设计 3+ 步的复杂查询测试集,验证 LLM 串行调 5 个工具的能力上限
3. **Phase 1 step 4:重新灌 `campus_documents`** —— Supabase `campus_documents` 表自项目删除后一直空着,本次 `search_dify_fallback` 工具是它的临时替代。重新手写校园政策数据灌进去后,可以加一个 `search_documents` 通用工具。
4. **eval 集扩到 100+ 条** —— 跟 step 3 一起做

## Git 状态(8/18 收尾)

- 本地 `main`:22 ahead / 1 behind `origin/main`(分叉保留,不动)
- 本地 `知识库构建`:在 `ff4d714` 之上新增 1 个 commit(本次 tool calling 重构),**未 push**(用户偏好默认不 push,见 `feedback_commits`)
- 工作树:有 `scripts/test-tool-calling.mjs` 和 `scripts/test-chat-endpoint.mjs` 两个新测试脚本(可能放进同一个 commit 或单独 commit)

See [[project_progress_2026_08_17_keyword_rules]] for the baseline this builds on, [[project_roadmap]] for the 3-phase plan (Phase 1 step 1 done, next is step 2 real-time tools), [[project_state]] for the big picture.
