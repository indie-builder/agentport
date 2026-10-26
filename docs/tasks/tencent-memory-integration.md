# 腾讯记忆项目与知识库联合集成探索

## 目标与当前有效决定

2026-10-25，用户暂停立即推进知识建设，追加探索腾讯疑似“Agent Memory DB”项目及其三层/多层记忆，与PACE、WeKnora核心知识能力联合集成的可能性。本轮只调研，不实施，不替换或取消已确认的完整知识闭环、Wiki/Feeds、飞书/GitLab同步目标。

优先定位 TencentCloud/TencentDB-Agent-Memory；并核对近名 Tencent-Hunyuan/Hy-Memory，区分应用技术栈三层与记忆算法/数据分层。项目身份尚未经用户逐项确认，找到后给官方链接说明，不靠模糊名称认定。

## 基线与范围

- PACE HEAD `797edfea`，沿用 `knowledge-base-research` worktree。
- 既有未提交差异：D-9已按用户确认更新；十二份先前知识调研及方案文档，均为本会话成果，不覆盖或提交。
- 本轮只新增记忆定向研究及汇总，必要时给原方案添加关联指针，不改产品代码/配置、不部署、不运行模型、不访问真实企业资料。

## 分工

- Sonnet：TencentDB项目官方来源、分层、API/MCP、许可证、部署与可复用边界。
- Sonnet：Hy-Memory技术栈与实际记忆管线、模型权重/许可和服务能力。
- Opus：PACE原生记忆、官方SDK能力和知识协同边界。
- 主会话：WeKnora已有记忆能力的重合检查及最后汇总，不重复外部项目调研。

## 核心判断问题

1. SDK会话恢复、原生记忆、企业知识、Wiki与共享经验是否区分清楚？
2. 外部记忆项目提供的真实新增价值是什么，能否仅服务检索/整理、不引另一Agent执行底座？
3. 原生MEMORY.md与外部DB谁写谁读，索引/编辑来源如何区分，如何避免双写与遗忘后重生？
4. 知识/记忆共享只限明确范围，自动从对话沉淀到企业Wiki会不会越界或误把推测当事实？
5. 联合引入需要的服务、模型、凭据、索引、备份、删除传播、导出、评测成本。

## WeKnora 记忆重合核对（本地固定源码）

WeKnora本身已有跨会话个人记忆，而不只有知识库：`website-docs/03-features/23-memory.md:13-38` 描述明确记住/后台自动提取两种模式、手工编辑、待确认推断、拒绝删除、常驻资料/偏好/兴趣与按问题召回事实/事项。默认空间开关关闭。

`internal/types/memory.go:21-65` 定义 profile/preference/fact/task/interest、explicit/extracted/manual 来源、active/superseded/archived/pending状态；这五种类别不是短/中/长期三层存储。`MemorySubject` 的主体作用域与PACE按agent持久目录不同，不能直接等同。

源码 `internal/application/service/memory/service.go:113` 为Recall，`:342` 起校验删除抑制，`:809`/`:828` 起删除/清空相关tombstone；`extract.go:391`将抑制记录用于提取，`consolidate.go:78`为整理入口。本轮静态检查，没有运行其遗忘或召回测试，不能宣称保证不重生。

WeKnora知识MCP目录 `internal/mcpserver/server.go` 本轮关键词检查未发现记忆工具，而个人记忆独立路由在 `internal/router/routes_memory.go:21-38`（settings/items/confirm/reject/export/consolidate），scope由主体身份推导。因此不能假设“接上WeKnora只读知识MCP”就同时拿到个人记忆服务，也不能把PACE的agent scope机械映射为WeKnora用户scope。

设计含义：比较新增项目时需解释它比现有官方auto-memory和WeKnora参考机制多提供什么；不能一并复制三套同范围的提取/常驻提示/长期写入。个人记忆可以帮助理解检索请求，但不扩展知识库访问范围，私有记忆不自动晋升企业Wiki。

固定一手来源：https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/website-docs/03-features/23-memory.md 、https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/internal/types/memory.go

## 联合集成评估口径（设计约束，非已选实现）

| 内容 | 现有/计划来源 | 应保持的边界 |
|---|---|---|
| 当前任务上下文与历史 | SDK transcript、resume/fork、平台消息 | 会话恢复不等同于长期记忆提取，不把聊天历史默认全量注入知识库 |
| 专家长期记忆 | 官方auto-memory、MEMORY.md与主题文件 | 现有写入主体与scope明确；第三方服务不默认同时写同一事实 |
| 企业知识 | 飞书/GitLab/文档/Feeds及Wiki | 原始证据与版本可追溯，源权限变化影响检索/Wiki |
| 可共享经验 | 从任务成果与人工确认中提炼 | 私有记忆不自动转公共事实；若导出技能要用官方SKILL.md/supporting files |

可以评估共用模型端点、索引技术和任务基础，但不能以此取消内容scope、来源和删除语义。记忆召回仅提供理解问题的上下文，不替代知识检索的来源证据。一次任务若不需要某侧内容，不必固定执行两套检索或把整个画像塞进提示。

对“分层”的评价依据是实际读写路径与生命周期，而非层数：写入者、来源、归属、压缩/合并、过期、修正、删除、可验证召回。若外部引擎只换了术语或复制官方原生能力，不能据“多层”认定必须引入；若解决跨专家有授权的共享经验与检索，再明确其独立职责和数据出口。

## 状态与验证

- [x] 定位两个官方候选
- [x] 官方源码及SDK原生核对，三份定向报告均返回
- [x] 联合方案、取舍与验证计划，见 [联合结论](knowledge-memory-joint-proposal.md)
- [x] 独立Opus复核主稿：通过，可作下一步验证方案；依据稿中“唯一文件载体/默认自研”等旧口径已清理
- [x] 文档本地链接、范围与差异检查通过

独立复核未重跑外部源码请求（证书校验失败），基于已落盘证据；本轮未进行候选部署或真实模型验证。

定向报告：[TencentDB](tencentdb-agent-memory-research.md)、[Hy-Memory](hy-memory-research.md)、[PACE原生边界](knowledge-memory-boundaries.md)。尚无运行结果。检索质量、跨run记忆、提取正确性、模型费用等不以README宣称或类型存在代替实测。
