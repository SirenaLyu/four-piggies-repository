# Session 记录:2026-08-16 eval-driven 修复轮

> 这是把当天第二轮工作(eval 失败案例修复)落到代码 + git 的一段对话归档,便于后续继续工作时快速恢复上下文。

## 起点状态

- 已落地分类路由 RAG 框架(见 `project_progress_2026_08_16.md`),5 张新 Supabase 表已灌库
- 已跑过 47-query eval,Supabase top-1 73.3% / MRR 0.760,Dify top-1 93.9% / MRR 0.955
- 用户原话 "你可以直接修复完成问题" —— 不再讨论方案,直接修 eval 暴露的 4 个失败案例

## 4 个失败案例 + 对应修复

| # | 失败 query | 期望 | 实际(修复前) | 修复 |
|---|---|---|---|---|
| 1 | "本科生选课什么时候开始" | notices | fallback(top1=notices 0.505, top2=shuttle 0.501, gap=0.004 < MIN_LEAD 0.03) | `STRONG_THRESHOLD=0.50` bypass MIN_LEAD |
| 2 | "暑期公共教室开放吗" | notices | fallback(关键词不在描述里) | notices 描述补"教室开放"等 |
| 3 | "助教岗位怎么申请" | notices | scholarships | notices + scholarships 描述都补"助教岗位/勤工助学岗位" |
| 4 | "课程代码 022059 是什么课" | courses | 命中不了(embedding 相似弱) | searchCourses 加 ilike `%code%` 反查 |

附带做的:
- scholarships 描述补"助学贷款、勤工助学岗位、资助育人、绿色通道"
- poi 描述补"餐厅、楼层位置、在哪个校区、怎么走"
- primary=fallback 时不再无检索 —— `searchDifyAll` 跨 5 库并行 top-2 兜底 + 新 `difyFallbackPrompt` 模板

## 改动文件

| 文件 | 改动 |
|---|---|
| `app/lib/classifier.ts` | `STRONG_THRESHOLD=0.50` + 3 处类目描述扩词 |
| `app/api/chat/route.ts` | `searchCourses(embedding, query)` 加 ilike 反查 + fallback 时调 `searchDifyAll` + 三路 prompt 选择 |
| `app/lib/dify.ts` | 新增 `searchDifyAll(query, topKPerDataset=2)` |
| `app/lib/prompts.ts` | 新增 `difyFallbackPrompt(ctx)` |
| `scripts/eval-retrieval.ts` | 镜像 `searchCourses` 也加 ilike 反查,调用处传 query |
| `scripts/debug-classify.mjs` | 新增,打印 query 在 7 类上的 top-3 余弦分数 |
| `docs/eval-retrieval-results.md` | 重新生成,新数字 |

## 关键陷阱(踩过的坑,避免再踩)

1. **eval 脚本有自己一份 `searchCourses` 镜像** —— 改 `app/api/chat/route.ts` 的检索逻辑必须同步改 `scripts/eval-retrieval.ts`,否则 eval 数字和生产代码不一致。本次"课程代码 022059"第一次修了 route.ts 没改 eval,跑 eval 还是失败,定位到 eval 自己的 searchCourses 没有 ilike 路径。
2. **Git 分叉** —— 本地 `main` 与 `origin/main` 分叉(远端有不兼容的 force-push "删除supabase数据库改用dify")。决定保留两条架构线,**新工作 push 到 `origin/知识库构建`**,不 force-push 覆盖远端 main。
3. **CRLF 警告** —— Windows 上 `git add` 新文件会有 `LF will be replaced by CRLF` 警告,正常,不影响提交。

## 2 个 commit(都已 push 到 `origin/知识库构建`)

- `c2e66d9` fix: 分类器加 STRONG_THRESHOLD + 扩展 notices/scholarships/poi 关键词
- `418eddd` feat: fallback 跨 Dify 5 库兜底 + 课程代码 ilike 反查

## Eval 结果对比

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 分类器 primary 准确率 | 76.6% | **85.1%** (40/47) |
| Supabase top-1 | 73.3% | **86.7%** (39/45) |
| Supabase top-3 | — | **91.1%** (41/45) |
| Supabase MRR | 0.760 | **0.897** |
| Dify MRR | 0.955 | 0.955(未变) |

## 仍失败的 4 条(后续改进方向)

| query | 现状 | 方向 |
|---|---|---|
| "暑期公共教室开放吗" | 分类 fallback,应 notices | "教室开放"已在描述里,embedding 没匹中 → 加规则补 |
| "助教岗位怎么申请" | 分类 scholarships,应 notices | "助教岗位"在两处描述里,scholarships 略高 → 加规则补 |
| "图书馆在东校区吗" | 分类 library,应 poi | 空间问句"在 X 校区吗"已在 poi 描述里,library 含"校区分馆"也匹中 → 加规则补 |
| "正阳楼餐厅几点开饭" | 分类 fallback,应 poi | 餐厅关键词已加,但"开饭"这种口语化时间问句没匹中 → 加规则补 |

**共同特征**:都是 embedding 弱信号场景(空间问句、时间问句、口语化表达),纯余弦相似度不够,后续考虑 embedding + 关键词规则混合。

Dify 侧失败 1 条:"周末有班车吗"——reranker 把"东区→西区 点对点"排到 top-1,实际期望"周末班次"信息。reranker 对中文短文本 CSV 偶尔有偏。

## 下一步候选(未启动)

1. **classifier 加规则层**:在 embedding 余弦相似度基础上,叠加关键词/正则规则,处理空间问句、时间问句这种弱 embedding 信号。例如 `/在哪个校区|在哪一层|怎么走/` 直接路由 poi,`/几点开饭|几点关门|开不开门/` 配合地点名词路由。
2. **评估集扩到 100+ 条**:覆盖更多边缘 case,迭代阈值与描述。
3. **Dify 路径加 ilike 反查**:目前 Dify 只能走 semantic,课程代码 case 在 Dify 上仍然失败(本项目内"课程代码"类查询只走 Supabase,所以 Dify 跳过这条也 OK)。
4. **tool calling 重构**(`project_roadmap.md` 推荐):把分类路由 + 检索升级成 LLM tool calling,让 LLM 自己决定调哪个工具,而不是 embedding 分类器硬路由。

## Git 当前状态

- 本地 `main`:21 commits,与 `origin/main` 分叉(origin 有 1 个不兼容 force-push)
- 本地 `知识库构建`:与 `origin/知识库构建` 同步,fast-forward 到 `418eddd`
- **后续工作继续 push 到 `知识库构建` 分支**,不要 push main
- 用户偏好按逻辑主题拆 commit(见 `feedback_commits.md`),默认不 push 除非用户要求
