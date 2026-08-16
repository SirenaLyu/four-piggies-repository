# RAG 双后端检索质量对比评估报告

**生成时间**:2026-08-16T12:46:02.856Z
**评估集大小**:47 条 query
**类目分布**:`calendar`=7, `shuttle`=7, `notices`=7, `library`=6, `scholarships`=6, `poi`=6, `courses`=6, `fallback`=2

## 1. 评估配置

- **Embedding 模型**:BAAI/bge-m3(SiliconFlow)
- **Supabase**:`classifyWithEmbedding` 路由后的 primary 类目 → 对应 `match_*` RPC(match_threshold=0.4)
- **Dify**:`semantic_search` + `reranking_model=BAAI/bge-reranker-v2-m3` + top_k=5 + 无阈值(docs/dify-retrieval-experiment.md 推荐配置)
- **路由策略**:Dify 端用 `expectedCategory` 路由(理想路由),隔离分类器误差与检索质量两件事;Supabase 端用 classifier 的 primary(贴近生产)
- **命中判定**:top-1 / top-3 内出现标注 `expectedKeywords` 任意一个即视为命中
- **MRR**:首个命中位置的倒数,无命中=0

## 2. 总体命中率

| 指标 | Supabase pgvector | Dify semantic+rerank |
|---|---|---|
| top-1 命中 | 33/45 (73.3%) | 31/33 (93.9%) |
| top-3 命中 | 35/45 (77.8%) | 32/33 (97.0%) |
| MRR | 0.760 | 0.955 |

> Dify 跳过 12 条 query(poi / courses / fallback 在 Dify 无对应知识库)。

**同口径对比**(只看 Dify 也覆盖的 5 类:calendar/shuttle/notices/library/scholarships,共 33 条):

| 指标 | Supabase (n=33) | Dify (n=33) |
|---|---|---|
| top-1 命中 | 25/33 (75.8%) | 31/33 (93.9%) |
| top-3 命中 | 27/33 (81.8%) | 32/33 (97.0%) |
| MRR | 0.788 | 0.955 |

口径一致后 Dify 仍领先 ~18 个百分点的 top-1、~15 个百分点的 top-3。差距主要来自 reranker 与 notices 类目的分类错误(notices 在 Supabase 只有 2/7 命中,在 Dify 是 7/7)。

## 3. 分类器路由准确率

- classifier `primary` 准确率:36/47 (76.6%)

## 4. 各类目命中率

| 类目 | n | Supabase @1 | Supabase @3 | Dify @1 | Dify @3 |
|---|---|---|---|---|---|
| calendar | 7 | 6/7 | 7/7 | 7/7 | 7/7 |
| shuttle | 7 | 7/7 | 7/7 | 6/7 | 6/7 |
| notices | 7 | 2/7 | 2/7 | 7/7 | 7/7 |
| library | 6 | 5/6 | 6/6 | 5/6 | 6/6 |
| scholarships | 6 | 5/6 | 5/6 | 6/6 | 6/6 |
| poi | 6 | 3/6 | 3/6 | N/A | N/A |
| courses | 6 | 5/6 | 5/6 | N/A | N/A |

## 5. 失败案例

### 5.1 Supabase 失败(10 条,top-3 未命中)

- **"暑期公共教室开放吗"** 期望 `notices`,分类 `fallback` **[分类错误]**
  - top1: `(无结果)`
- **"本科生选课什么时候开始"** 期望 `notices`,分类 `fallback` **[分类错误]**
  - top1: `(无结果)`
- **"毕业论文选题怎么报"** 期望 `notices`,分类 `fallback` **[分类错误]**
  - top1: `(无结果)`
- **"助教岗位怎么申请"** 期望 `notices`,分类 `scholarships` **[分类错误]**
  - top1: `勤工助学工作规范与流程 2006-11-16 系统管理员 勤工助学 勤工助学工作规范 （二OO四年二月二十日） 1、岗位设置：用工单位（设岗单位）须以组织名义向学校勤工助学办公室提交书面用工申请，经勤工助学办批准后方可接纳学生参加勤工助学。设岗单位一般不得自己物色岗位人选，原则上由勤工助学办公室或各院系从特困生中推荐。2、上岗申请：凡欲参加勤工助学的特困生应在学年初向班主任或院系分管领导提出申请，填写《勤工助学上岗申请审批表》(学生处提供)，由班主任和院系领导签署意见后交勤工`
- **"实习管理有什么新规定"** 期望 `notices`,分类 `fallback` **[分类错误]**
  - top1: `(无结果)`
- **"勤工助学岗位有哪些"** 期望 `scholarships`,分类 `fallback` **[分类错误]**
  - top1: `(无结果)`
- **"图书馆在东校区吗"** 期望 `poi`,分类 `library` **[分类错误]**
  - top1: `东区 楼层:6楼东 行政办公 电话:63602325 / 63602328`
- **"西区附近有餐厅吗"** 期望 `poi`,分类 `fallback` **[分类错误]**
  - top1: `(无结果)`
- **"正阳楼餐厅几点开饭"** 期望 `poi`,分类 `library` **[分类错误]**
  - top1: `东区 楼层:2楼中 服务台 工作日:8:00-22:00 电话:63600996`
- **"课程代码 022059 是什么课"** 期望 `courses`,分类 `courses`
  - top1: `表达与沟通 Expression and Communication 代码:025101 学时:60 学分:3 角色:substitute`

### 5.2 Dify 失败(1 条,top-3 未命中)

- **"周末有班车吗"** 期望 `shuttle`
  - top1: `route_name: 东区→西区;direction: 点对点;departure: 东区;arrival: 西区;depart_time: 17:00;arrive_time: nan;weekday_only: True;period: 2026-08-01~2026-08-29;note: 始发站满员即发,无固定到达时间;source: manual:用户提供 2026-08-15`

## 6. 跨类目干扰

| query | 期望 secondary | classifier secondary | 命中? |
|---|---|---|---|
| 量子力学A能代替什么课 | `courses` | `(无)` | ✗ |
| 去图书馆坐班车几点 | `library` | `library` | ✓ |
| 开学注册期间图书馆开门吗 | `library` | `calendar` | ✗ |
| 选课期间有什么奖学金可以申请 | `scholarships` | `notices` | ✗ |

## 7. 后续改进建议

(根据本次结果由人工补充)
