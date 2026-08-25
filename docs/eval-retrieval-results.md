# RAG 双后端检索质量对比评估报告

**生成时间**:2026-08-25T02:40:30.807Z
**评估集大小**:102 条 query
**类目分布**:`calendar`=17, `shuttle`=16, `notices`=14, `library`=13, `scholarships`=14, `poi`=14, `courses`=12, `fallback`=2

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
| top-1 命中 | 95/100 (95.0%) | 70/74 (94.6%) |
| top-3 命中 | 97/100 (97.0%) | 71/74 (95.9%) |
| MRR | 0.961 | 0.953 |

> Dify 跳过 26 条 query(poi / courses / fallback 在 Dify 无对应知识库)。

## 3. 分类器路由准确率

- classifier `primary` 准确率:95/102 (93.1%)

## 4. 各类目命中率

| 类目 | n | Supabase @1 | Supabase @3 | Dify @1 | Dify @3 |
|---|---|---|---|---|---|
| calendar | 17 | 15/17 | 16/17 | 16/17 | 16/17 |
| shuttle | 16 | 16/16 | 16/16 | 15/16 | 15/16 |
| notices | 14 | 13/14 | 13/14 | 13/14 | 13/14 |
| library | 13 | 12/13 | 13/13 | 12/13 | 13/13 |
| scholarships | 14 | 14/14 | 14/14 | 14/14 | 14/14 |
| poi | 14 | 13/14 | 13/14 | N/A | N/A |
| courses | 12 | 12/12 | 12/12 | N/A | N/A |

## 5. 失败案例

### 5.1 Supabase 失败(3 条,top-3 未命中)

- **"关于考试的通知有哪些"** 期望 `notices`,分类 `notices`
  - top1: `关于2024秋和2025春开题的大学生研究计划结题答辩与学生选择成绩工作的通知 2025-11-20 教学`
- **"开学注册日图书馆开门吗,怎么坐班车去西区"** 期望 `calendar`,分类 `library` **[分类错误]**
  - top1: `西区 楼层:12楼 西文书库 工作日:8:00-12:00 14:00-18:00 周末:—— 电话:63607942`
- **"东区食堂中午营业时间和图书馆自习室开放时间"** 期望 `poi`,分类 `library` **[分类错误]**
  - top1: `东区 楼层:5楼东、西 自习室 工作日:7:00-23:00 电话:63601327`

### 5.2 Dify 失败(3 条,top-3 未命中)

- **"周末有班车吗"** 期望 `shuttle`
  - top1: `route_name: 东区→西区;direction: 点对点;departure: 东区;arrival: 西区;depart_time: 17:00;arrive_time: nan;weekday_only: True;period: 2026-08-01~2026-08-29;note: 始发站满员即发,无固定到达时间;source: manual:用户提供 2026-08-15`
- **"考试周持续到几号"** 期望 `calendar`
  - top1: `academic_year: 2026;semester: 秋季;start_date: 2026-10-10;end_date: 2026-10-10;event_title: *补周二课;source_url: https://www.teach.ustc.edu.cn/calendar/20135.html`
- **"关于考试的通知有哪些"** 期望 `notices`
  - top1: `title: 关于中国科大“一〇七杯”算力与智能体开发大赛补报名的通知;url: https://www.teach.ustc.edu.cn/notice/notice-info/20412.html;publish_date: 2026-07-14;author: 教务处;category: 信息;body_preview: 为进一步推动人工智能赋能教育教学工作，提升学生人工智能应用素养和科研实践能力，教务处联合网络信息中心、学生工作 […]`

## 6. 跨类目干扰

| query | 期望 secondary | classifier secondary | 命中? |
|---|---|---|---|
| 量子力学A能代替什么课 | `courses` | `(无)` | ✗ |
| 去图书馆坐班车几点 | `library` | `library` | ✓ |
| 开学注册期间图书馆开门吗 | `library` | `calendar` | ✗ |
| 选课期间有什么奖学金可以申请 | `scholarships` | `(无)` | ✗ |
| 我想去西区图书馆还书,顺便坐班车去高新,该怎么安排 | `shuttle` | `library` | ✗ |
| 开学注册日图书馆开门吗,怎么坐班车去西区 | `library` | `shuttle` | ✗ |
| 郭沫若奖学金公示期间图书馆研讨室开放吗 | `library` | `(无)` | ✗ |
| 东区食堂中午营业时间和图书馆自习室开放时间 | `library` | `poi` | ✗ |

## 7. 后续改进建议

(根据本次结果由人工补充)
