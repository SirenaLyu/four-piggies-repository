# scripts 目录索引

所有脚本通过 `npm run <name>` 调用（见根目录 package.json）。

## crawl/ —— 数据采集与灌库

| 脚本 | npm 命令 | 说明 |
|---|---|---|
| `crawl-ustc.ts` | `npm run crawl` | 爬取校园地图 POI（建筑/食堂/AED 等）+ 课程替代池 → `D:\ustc-data\` |
| `crawl-ustc-extra.ts` | `npm run crawl-extra` | 爬取校历/班车/教务通知/图书馆/奖学金 5 类数据（支持 `--only=` 指定类目） |
| `feed_crawled_data.ts` | `npm run feed-crawled` | 把 `D:\ustc-data\` 的爬取结果灌入 Supabase（支持 `--dry-run` / `--only=`） |
| `feed_data.ts` | `npm run feed-docs` | 早期脚本：灌入通用校园文档（campus_documents 表） |

## eval/ —— 检索质量评估与调试

| 脚本 | npm 命令 | 说明 |
|---|---|---|
| `eval-retrieval.ts` | `npm run eval` | 47 条 query 双后端（Supabase/Dify）对比评估，输出命中率 + MRR + 报告到 docs/ |
| `test-classifier.ts` | `npm run test-classifier` | 分类器单测（embedding 路由 + 关键词规则层） |
| `debug-classify.mjs` | `node scripts/eval/debug-classify.mjs` | 单条 query 分类调试（查看 7 类目分数分布） |

## dify/ —— Dify 知识库操作样例

Dify 建库/上传/检索 API 的请求体样例（JSON），供建库与实验时参考，
实际检索逻辑在 `app/lib/retrieval/dify.ts`。详见 `docs/dify-retrieval-experiment.md`。

## docs-gen/ —— 文档生成

| 脚本 | npm 命令 | 说明 |
|---|---|---|
| `generate-doc-pdf.ts` | `npm run gen-doc` | 把 docs/ 指南 md 渲染为 PDF（puppeteer-core + 系统浏览器） |

## 其他

| 脚本 | npm 命令 | 说明 |
|---|---|---|
| `check-tables.ts` | `npm run check-tables` | 检查 Supabase 各表行数，确认灌库结果 |
