# 知识库与 main 迁移整合

保留 main 的 `0033_slim_cyclops`、`0034_wealthy_ikaris`、`0035_pretty_tana_nile`；冲突的 0033/0034 快照与 journal 使用 main 的 stage 3 原文。删除知识分支旧 `0033_steep_nico_minoru.sql`、`0034_normal_sebastian_shaw.sql`。以 main 0035 快照为基线执行 `pnpm db:generate`，生成 `0036_demonic_dust.sql` 与包含双方 schema 的 `0036_snapshot.json`。

0036 包含 15 张知识表、图片 embedding 协议与启用约束、servers kind 的 knowledge 值；main 插件表及其索引完整保留。自动生成保留 search_vector GENERATED ALWAYS/STORED 与 GIN；手工补回先行的 vector 扩展及 enabled/非空向量条件的 HNSW cosine 索引。schema 自动合并语义正确，本任务未修改 schema。

验证结果：`pnpm db:generate` 成功生成 0036；Node assert 语义检查通过：37 条连续 journal、0035→0036 快照链、26 张 main 表除 servers kind CHECK 外全部定义保持一致、15 张新增知识表、图片协议字段、生成列/GIN、vector/HNSW 均保留。重新运行 `pnpm db:generate` 应显示无 schema 差异。主会话还需在全新独立测试数据库执行 `DATABASE_URL=<新库连接串> pnpm db:migrate` 并运行相关集成测试；本任务未执行 migrate。

开发测试库要求：曾执行知识分支旧 0033/0034 的独立库必须重置或另建新库；不得在旧库增量执行整合迁移，否则历史编号和已建表冲突。重置仅针对可丢弃测试库，由主会话统一处理。
