# RAG 双后端检索质量对比评估报告

**生成时间**:2026-08-17T13:22:44.973Z
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
| top-1 命中 | 43/45 (95.6%) | 31/33 (93.9%) |
| top-3 命中 | 45/45 (100.0%) | 32/33 (97.0%) |
| MRR | 0.978 | 0.955 |

> Dify 跳过 12 条 query(poi / courses / fallback 在 Dify 无对应知识库)。

## 3. 分类器路由准确率

- classifier `primary` 准确率:44/47 (93.6%)

## 4. 各类目命中率

| 类目 | n | Supabase @1 | Supabase @3 | Dify @1 | Dify @3 |
|---|---|---|---|---|---|
| calendar | 7 | 6/7 | 7/7 | 7/7 | 7/7 |
| shuttle | 7 | 7/7 | 7/7 | 6/7 | 6/7 |
| notices | 7 | 7/7 | 7/7 | 7/7 | 7/7 |
| library | 6 | 5/6 | 6/6 | 5/6 | 6/6 |
| scholarships | 6 | 6/6 | 6/6 | 6/6 | 6/6 |
| poi | 6 | 6/6 | 6/6 | N/A | N/A |
| courses | 6 | 6/6 | 6/6 | N/A | N/A |

## 5. 失败案例

### 5.1 Supabase 失败(0 条,top-3 未命中)

(无)

### 5.2 Dify 失败(1 条,top-3 未命中)

- **"周末有班车吗"** 期望 `shuttle`
  - top1: `route_name: 东区→西区;direction: 点对点;departure: 东区;arrival: 西区;depart_time: 17:00;arrive_time: nan;weekday_only: True;period: 2026-08-01~2026-08-29;note: 始发站满员即发,无固定到达时间;source: manual:用户提供 2026-08-15`

## 6. 跨类目干扰

| query | 期望 secondary | classifier secondary | 命中? |
|---|---|---|---|
| 量子力学A能代替什么课 | `courses` | `(无)` | ✗ |
| 去图书馆坐班车几点 | `library` | `library` | ✓ |
| 开学注册期间图书馆开门吗 | `library` | `calendar` | ✗ |
| 选课期间有什么奖学金可以申请 | `scholarships` | `(无)` | ✗ |

## 7. 后续改进建议

(根据本次结果由人工补充)
