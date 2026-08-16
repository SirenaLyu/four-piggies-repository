# Dify 检索对比实验报告

**日期**:2026-08-16
**Dify 实例**:`http://114.214.241.106/`(1.16.1)
**API key**:`dataset-tGSTzWOdMMWOLXnAMyEIT8ff`
**Embedding 模型**:BAAI/bge-m3(SiliconFlow 提供)
**Reranker**:BAAI/bge-reranker-v2-m3(SiliconFlow 提供)

## 1. 实验目标

在 5 个新建主题知识库上对比 3 种检索配置的命中率,确定生产环境最佳配置。

5 个新库:
| 中文名 | dataset_id | 文档 | segments |
|---|---|---|---|
| 校历 | `ab7400a3-...` | calendar.csv | 155 |
| 班车 | `781772a0-...` | shuttle.csv | 29 |
| 教务通知 | `76ca3310-...` | notices.csv | 20 |
| 图书馆 | `748dd072-...` | library-hours.csv | 28 |
| 奖学金 | `058eb792-...` | scholarships.csv | 164 |

Dify 自动分块按 CSV 行切,segments 数与 CSV 行数完全一致。

## 2. 三种检索配置

| 配置 | search_method | reranking | 其他 |
|---|---|---|---|
| A. semantic+rerank | `semantic_search` | ON, `reranking_model` = bge-reranker-v2-m3 | top_k=5, no threshold |
| B. semantic no-rerank | `semantic_search` | OFF | top_k=5, no threshold |
| C. hybrid | `hybrid_search` | `weighted_score`, keyword 0.3 + vector 0.7 | top_k=5, no threshold |

## 3. 探针 query 与 top-1 命中

| 库 | 探针 query | A (sem+rerank) | B (sem only) | C (hybrid) |
|---|---|---|---|---|
| 校历 | 2026 秋季什么时候开学 | 老生开学注册 (0.986) | 中秋节 (0.680) | 中秋节 (0.548) |
| 班车 | 去高新区的班车几点发车 | 12:30 班次 (0.766) | 20:00 班次 (0.672) | 20:00 班次 (0.470) |
| 教务通知 | 最近的教务处通知讲什么 | 选课通知 (0.490) | 教学工程 (0.644) | 实习管理 (0.586) |
| 图书馆 | 东区图书馆周六开门吗,几点关门 | **东区1楼西** (0.916) | 西区12楼 (0.620) | 西区12楼 (0.434) |
| 奖学金 | 雪迪龙奖学金的联系人是谁,邮箱多少 | 雪迪龙 (0.041) | 雪迪龙 (0.606) | 雪迪龙 (0.506) |

## 4. 关键观察

### 4.1 Reranker 显著改善跨字段 CSV 检索

图书馆案例最典型:用户问"东区图书馆",B 和 C 都把"西区12楼"排第一(语义上"西区"+"图书"和"东区"+"图书"距离相近),只有 A 配置的 reranker 把"东区1楼西"纠正回 top-1。

校历和班车案例中,A 也是唯一把最切题结果(老生开学注册、12:30 班次)排第一的配置。B 和 C 都被节假日或其他班次的语义相近度干扰。

### 4.2 Hybrid 对中文 CSV 是噪声

C 配置的 keyword 0.3 权重在中文短文本 CSV 上反而引入噪声:用户问"东区"时,keyword 命中"西区"因为"区"字相同,反而压过 semantic 命中"东区"。在 5 个库中,C 的 top-1 命中率 = 1/5(只有奖学金),远低于 A 的 5/5。

### 4.3 Reranker 分数跨库不可比

A 配置下校历分数 0.986、奖学金 0.041,差 24 倍。这是 bge-reranker-v2-m3 对不同文档结构的输出特征:校历是 `academic_year: 2026;semester: 秋季;...` 这种 key-value 短文本,与 query 字面重叠多 → 分数高;奖学金是 `title: ...; body_preview: ...` 这种长段落,语义匹配但字面重叠少 → 分数低。

**结论**:不能用绝对分数做跨库阈值。score_threshold 应关闭,或按库分别调。

## 5. 推荐生产配置

```
search_method:       semantic_search
reranking_enable:    true
reranking_mode:      reranking_model
reranking_model:     BAAI/bge-reranker-v2-m3 (langgenius/siliconflow/siliconflow)
top_k:               5
score_threshold_enabled: false
```

**理由**:
- top-1 命中率 5/5,显著优于 no-rerank(1/5 命中正确校区/时间)和 hybrid(1/5)
- reranker 在跨字段 CSV 上把字面相近但语义偏离的候选(西区 vs 东区)正确降权
- 不开 score_threshold,因为 reranker 分数跨库差异巨大,统一阈值会误杀

## 6. 后续工作

- 把这个配置应用到 chat route 的 fallback 路径(若 Dify 检索效果优于 Supabase pgvector,可作为兜底)
- 扩展评估集:5 个探针 → 30-50 个,自动算 MRR / nDCG,而不是只看 top-1
- 评估 `top_k=3` vs `top_k=5` vs `top_k=10` 对下游 LLM 答案质量的影响(更多上下文 vs 噪声)
- 测试 `doc_form: hierarchical_model` 父子分块对长 body_preview(奖学金)的检索效果
- 测试自定义 process_rule 的 chunk size(当前 automatic 模式按 CSV 行切,对长 body_preview 可能切得过粗)

## 7. 复现脚本

- `scripts/dify-create-{calendar,shuttle,notices,library,scholarships}.json` —— 5 个库的 create payload
- `scripts/dify-upload-data.json` —— 文档上传时的 data 字段(indexing_technique + automatic process_rule)
- `scripts/dify-retrieve-semantic.json` —— A 配置 payload 模板
- `scripts/dify-retrieve-semantic-norerank.json` —— B 配置 payload 模板
- `scripts/dify-retrieve-hybrid.json` —— C 配置 payload 模板

所有脚本用 `--data-binary @file` 避免 curl 命令行下中文编码问题。
