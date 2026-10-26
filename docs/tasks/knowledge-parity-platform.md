# PACE × WeKnora：平台整合与运行可靠性对照

2026-10-25；只读产品源码，唯一产出本文件。范围不含检索/Wiki算法，不运行参考代码、全套测试或真实模型，不接腾讯Memory。
PACE 是当前未提交 worktree；下列 P 链接固定到本地源码行，不能伪装成 GitHub 已提交版本。WeKnora W 链接全部固定至 `e1f9a6166a593a4804a2f99f1d942919c9cc8ea7`，并据本地同 SHA 源码核对。

## 判定与优先事项（最多六项）

1. **确定 gap：知识 MCP 的跨宿主配置导出不能直接使用。** PACE 导出标准 HTTP MCP + `KNOWLEDGE_*_TOKEN` 环境变量占位，但没有 run-id header；服务端知识分支必须同时获得有效 runId、未过期 token、该运行与 server 的绑定。token 在 worker 启动运行时随机生成、只存 hash，再注入该运行工作区，因此“用户补填一个静态 token”不能使导出配置成立。调用链是导出构造 → worker 签发/注入 → endpoint 校验，不是仅凭搜索认定缺失。[P1][P2][P3][P4] WeKnora 有独立 MCP endpoint 创建、轮转 token 和自身 Bearer 鉴权入口，其文档明确每端点 token/库范围/工具范围。[W1][W2] **最小推荐：**当前先把导出能力明确标为“同实例重导入可恢复绑定，外部宿主连接尚不支持”；确需跨宿主时才补一种受库范围约束、可撤销的外部凭据及配套导出，不泄露 run token。普通 generated MCP 有长期 token 回退，但知识分支提前返回，不可混为一谈。[P2]

2. **确定 gap：平台健康指标遗漏知识队列。** `/health/metrics` → `collectMetrics` → `getQueue()` 只取 RUNS_QUEUE；知识任务实际由 `getKnowledgeQueue()` 创建的 `knowledge-jobs` 独立消费。[P5][P6] 因而聊天队列健康不证明知识摄取正常。已有库内 jobs、取消、重试、重启对账不是缺失；WeKnora 对实际队列集合扫描，并记录耗尽重试的 dead-letter。[P7][W3][W4] **最小推荐：**现有 metrics 增加知识队列 waiting/active/failed 与最老等待时长，沿用现有日志和任务页面；暂不引入新监控平台。

3. **功能差异：批量上传已做，批量管理与完整 URL 状态未齐。** PACE 第四资源 tab 已接入；详情 panel/page/folder 进 URL，但文档 query/status/tag 和打开的文档仍是 DocumentsTab 局部 state。删除、重处理、编辑、查看都持有单个 document 对象；上传则逐文件调用并记录成功/失败，不能称完全没有批量能力。[P8][P9][P10] WeKnora 有批量下载、重解析、标签、移动和删除的 UI 事件及服务端入口。[W5][W6] **最小推荐：**复用现有文档 mutations 做选择后批量删除/重处理/移动/标签，显示逐项失败；把实际需要分享和刷新恢复的筛选/文档 ID 纳入现有 search schema。跨库批量、额外工作流暂不增加。

4. **功能差异：解析原文查看不等于原件内联预览。** PACE 文档检查器与引用弹窗都请求解析后的 Markdown，原件通过 download 链接获取；可看引用/图片不等于可在页面内核对 PDF 原始版式。[P11][P12] WeKnora 将原件 preview 与 download 分为两条权限路由，UI 也明确区分 parsed content、preview、原件下载。[W6][W7] **最小推荐：**保留当前 Markdown 与下载，按最常用格式补 PDF/图片内联原件入口及页码定位；Office 先下载或经现有转换服务，不引入第二套解析引擎。

5. **功能差异：语料包有硬容量边界；运行验收未达：大库迁移尚无证据。** PACE 单原件 32 MiB，ZIP 64 MiB、解压总计 128 MiB、最多 5,000 entries；导出逐个 readFile，最后 zipSync 并在压缩后检查 64 MiB，导入也是完整 buffer/unzipSync。[P13][P14] 不能把“知识库可持续增加文档”解释成“任意大小库都能打包迁移”；内存占用也不能只按最终 ZIP 大小估算。WeKnora 批量原件下载是另一能力，并不能作为完整 Wiki/配置/版本迁移或无上限导出的证据。[W5][W6] **最小推荐：**先在导出入口说明并预估现有限额、失败前给出可行动提示；全量搬迁继续走平台 DB+知识卷备份。确有超限库再做流式包，不凭假设直接重写。现有真实恢复记录与剩余边界见下文。[P15]

6. **运行验收未达：真实服务、容器组合与费用仍需部署验收。** 已有正式 worker 依赖部署副本可 import SDK、真实 SDK/CLI→本地模型 mock→MCP→落库，以及隔离 PG+文件恢复记录，不能再报“SDK 未安装/完全没备份”。但真实 Docling 扫描 PDF/Office、真实模型/embedding/rerank、企业连接器凭据、主库镜像切换和远端 restic 尚未验收。[P15][P16] Compose 将知识卷挂给 API/worker、Docling 是可选 profile，worker 挂 Docker socket；这证明接线，不证明实际整栈容器交付已成功。[P17] WeKnora 自有服务编排和模型下载接口也不是 PACE 环境的验收证据。[W8][W9] **最小推荐：**按目标部署执行一次真实 PDF→任务→引用→原件、失败任务恢复、受控预算模型调用和隔离恢复；记录时延、内存、磁盘及费用，先不扩大部署栈。

## 已有能力与明确取舍

- **建库/settings/model provision：**PACE 已有 embedding/rerank profile CRUD、测试、库设置与重建，并在缺 embedding profile 时支持建库内创建回填。[P18][P19] WeKnora 库编辑器使用模型配置组件，还提供 Ollama 状态/列举/下载/进度接口。[W8][W10] “平台代装本地模型”是当前功能差异，不是缺模型配置；最小方案仍为用户提供可用 endpoint，不强行引入 Ollama 服务。
- **专家父子绑定与官方文件原则：**UI 用 serverIds 保留普通连接器并替换知识绑定；worker 汇合父与启用子级 bindings，知识连接经统一构造器写入 MCP 条目。[P3][P4][P20] 这比复制 WeKnora 自有 Agent/聊天系统更符合 PACE；知识 DB/语料卷属于内容资源，不违反“智能体定义用官方文件”。架构已明确区分知识与 auto-memory。[P21] 不接腾讯Memory，不另造第二套 Agent loop 或聊天/长期记忆。
- **API 消耗边界与权限：**PACE REST 是登录后的单 admin，共享知识资源；知识 MCP 另按 run/server 校验。全局 600 请求/分钟、知识 worker 并发 2、Wiki `maxTurns:12`/`maxBudgetUsd:0.5` 已存在，但分别是请求频率、任务并发、单次生成上限，不等于 embedding/rerank/定时同步的全局费用额度。[P2][P22][P23][P24] WeKnora 有 API-key scope、KB 读写权限及租户存储额度字段。[W6][W11][W12] 单 admin 不要求补 RBAC；应称“单管理员共享资源+运行绑定隔离”，不能称“完整企业权限镜像”。费用先做供应商账单/任务调用量的验收观察，实际需要时再加总预算。
- **多租户、多向量库、图谱、完整独立 Agent/聊天：**是参考产品边界与 PACE 当前架构取舍，不按数量照搬。当前 PostgreSQL/pgvector、官方 Agent SDK、官方文件目录、共享单 admin 边界应保持；企业 ACL 需求成立时需单独设计，不通过知识任务顺带扩展。
- **备份/迁移/运维：**已有 DB+知识原件/解析产物+工作区的隔离恢复、hash/权限核对与故障回滚记录；不重报已修的目录换入嵌套问题。[P15][P16] 主库镜像切换前仍须实际环境完整备份并验证恢复；语料 ZIP 与全平台备份职责不同。已有任务错误/重试/取消/对账；真正残留的是上述平台指标盲区与部署验证边界。

## 已修问题排除与证据限度

原十项修复按对应触发条件保留，不凭旧基线认定整个来源生命周期已正确。[P16] 后续独立[定点复核](knowledge-parity-verification.md)确认新的范围收缩/完整重建路径有残留：范围收缩不立即停用范围外文档；完整 rebuild 可将已停用来源的保留文档重新置为 ready。这与已修的“确认失权时停用”分支不同，应列 P1。暂停抓取不等同撤销授权。
本轮仅源码调用链复核；没有新鲜运行测试。沿用既有验收记录时明确其 mock/隔离/部署限制，不把协议跑通称生成质量或生产可靠性已验收。

## 双侧证据索引（path:line）

[P1]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/api/src/features/agent-package.ts:106
[P2]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/api/src/features/servers/mcp-endpoint.ts:92
[P3]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/worker/src/index.ts:436
[P4]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/shared/src/mcp.ts:69
[P5]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/api/src/plugins/metrics.ts:75
[P6]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/api/src/queue/producer.ts:120
[P7]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/worker/src/knowledge/reconcile.ts:66
[P8]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/web/src/components/resource-page.tsx:13
[P9]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/web/src/routes/-search.ts:66
[P10]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/web/src/pages/knowledge-detail.tsx:282
[P11]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/web/src/pages/knowledge-detail.tsx:1180
[P12]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/web/src/pages/knowledge-detail.tsx:1492
[P13]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/api/src/features/knowledge/package.ts:28
[P14]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/api/src/features/knowledge/package.ts:541
[P15]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/docs/tasks/knowledge-delivery-verification.md:30
[P16]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/docs/tasks/knowledge-final-fix-verification.md:7
[P17]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/docker-compose.yml:69
[P18]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/web/src/pages/knowledge.tsx:794
[P19]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/api/src/features/knowledge/routes.ts:1090
[P20]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/web/src/pages/agents.tsx:828
[P21]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/docs/ARCHITECTURE.md:219
[P22]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/api/src/plugins/security.ts:46
[P23]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/worker/src/knowledge/queue.ts:187
[P24]: /Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-base-research/packages/worker/src/knowledge/wiki.ts:269
[W1]: https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/internal/router/routes_mcp_endpoint.go#L21
[W2]: https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/mcp-server/README.md#L7
[W3]: https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/internal/router/task_inspector.go#L70
[W4]: https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/internal/router/task.go#L234
[W5]: https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/frontend/src/views/knowledge/components/DocumentBatchBar.vue#L24
[W6]: https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/internal/router/routes_knowledge.go#L138
[W7]: https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/frontend/src/views/knowledge/KnowledgeBase.vue#L369
[W8]: https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/internal/router/routes_infra.go#L119
[W9]: https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/docker-compose.yml#L1
[W10]: https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/frontend/src/views/knowledge/KnowledgeBaseEditorModal.vue#L230
[W11]: https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/internal/middleware/auth.go#L411
[W12]: https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/internal/types/tenant.go#L99
