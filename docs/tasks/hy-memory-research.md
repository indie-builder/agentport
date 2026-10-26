# Hy-Memory / MemHub 独立核查（腾讯混元 Agent Memory）

> 2026-10-25 核查。只读公开仓库与官网，未克隆、未运行任何上游代码或模型，未下载权重。区分「源码类型存在」「文档声称」「运行验证」三档；性能对比一律不采信。官网提供的是产品口径，仓库 `main` 与实践版本不同步处单独标注。

## 摘要（12 行）

1. 所谓「三层」在官网指**模型-框架-应用**三层全开源，不是短/中/长期记忆层；记忆层实际是 Chat 的 **L0–L7 八层**认知结构，另有 Working/Coding 各两层。
2. 仓库里没有 episodic/semantic/short-term/mid-term 的命名；`episode` 只是按时间间隔切会话摘要的实现细节，L5 Knowledge 在源码注释里写明「暂未实现」。
3. 实际记忆管线：`add` 写 raw → LLM 抽取事实 → reconcile（ADD/UPDATE/SUPERSEDE/DELETE 逻辑删除）→ 写向量库；`search` 走向量 + 可选 BM25/RRF/本地 cross-encoder rerank。
4. 存储默认 ChromaDB + Kuzu + SQLite，**没有 Postgres**（`rdb.py` 自己标注为「红色模块 - 待实现」）；Qdrant/Neo4j/FAISS/MySQL 为可选。
5. 不需要 Hy-Memory-30B-A3B：默认 `gpt-4.1-nano`，任何 OpenAI 兼容 LLM + embedding 端点即可；30B 只是可选的写入模型。
6. 代码与权重均为 Apache-2.0（HuggingFace 模型卡同）；GitHub API 因自定义前言显示 NOASSERTION。
7. Claude Code 接入是官方的，但由 **MemHub 桌面端**安装：写用户级 `~/.claude.json`、`~/.claude/skills/memhub-recall`、`~/.claude/settings.json` 三组 hook；只支持 macOS/Linux。
8. SDK 自带的 HTTP 服务是无鉴权 stdlib 服务，只绑 127.0.0.1（CORS `*`）；鉴权在 MemHub 的 broker/credential 层。
9. 它确有自己的一套 System 1/System 2 LLM 调用，但**不是**完整智能体循环、不提供工具编排，可以作为辅助记忆服务与 Claude Agent SDK 并存。
10. 与 WeKnora Wiki 边界清晰：Hy-Memory 是个人对话/工作/编码记忆，无文档摄取、OCR、共享 Wiki、来源 ACL；不能替代知识库与 Wiki。
11. 主要适配成本：Python与独立存储、额外模型调用、按用户/专家导出和删除契约不明确。MemHub的用户级安装不能原样套入PACE沙盒；辅助服务本身并不因使用数据库就违反官方文件定义原则。
12. 建议：列为辅助记忆候选，先与原生能力及TencentDB Core比较，不把整套MemHub桌面端直接引入PACE；是否采用需样本验证，不默认自研替代。

## 1. 版本与许可（固定证据）

| 项 | 值 | 来源 |
|---|---|---|
| 仓库 | `Tencent-Hunyuan/Hy-Memory`，默认分支 `main`，Python | https://github.com/Tencent-Hunyuan/Hy-Memory |
| main HEAD | `fcb1bcd8665322c3500027dae096f8749a61b071`（2026-10-25，release 之后） | https://github.com/Tencent-Hunyuan/Hy-Memory/commits/main |
| SDK release | tag `hy-memory-v2.0.5` → commit `d08e070816b1`（2026-10-22），产物 wheel/sdist | https://github.com/Tencent-Hunyuan/Hy-Memory/releases/tag/hy-memory-v2.0.5 |
| 产品 release | tag `v1.0.4` → 打包 dmg + runtime（macOS arm64、Linux x64/arm64），无 Windows | https://github.com/Tencent-Hunyuan/Hy-Memory/releases/tag/v1.0.4 |
| 版本漂移 | README 仍写 `pip install hy-memory==2.0.4`，`pyproject.toml` 已是 `2.0.5`；MemHub README 自称 1.0.5 build 14，但 GitHub release 只到 v1.0.4 | https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/README.zh.md · https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/pyproject.toml · https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/memhub/README.md |
| 代码许可 | 根 `LICENSE` 为 Apache-2.0，并明确覆盖「code, parameters, and weights」；`memhub/LICENSE` 亦 Apache-2.0 | https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/LICENSE · https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/memhub/LICENSE |
| 权重许可 | HuggingFace `tencent/Hy-Memory-30B-A3B` license 字段 `apache-2.0`；FP8/GGUF 变体同系列 | https://huggingface.co/tencent/Hy-Memory-30B-A3B |

结论：许可上没有阻塞。注意 GitHub 许可证 API 对未识别前言返回 `NOASSERTION`，属识别问题而非额外限制。

## 2. 「三层」到底是什么

- 官网原文：「模型、框架、应用三层全开源」，并列出 `Hy-Memory-30B-A3B`（模型）/ `Hy-Memory`（SDK 框架）/ `MemHub`（应用）。→ 这是**技术栈分层**。https://memory.hunyuan.tencent.com/
- 同一页面又把框架能力写成「聊天记忆 · 工作记忆 · 代码记忆」，这是**场景**分类，也不是时间尺度分层。
- 真正的数据层级在源码 `MemoryLayer`：`L0_BASIC_INFO / L1_RAW / L2_FACT / L3_SUMMARY / L4_IDENTITY / L5_KNOWLEDGE / L6_SCHEMA / L7_INTENTION`，注释写明「L0-L4 在 VDB, L5-L7 在 Graph (ultra 模式)」，且 `L5_KNOWLEDGE — …暂未实现`。→ **八个认知层，不是三层，也不是短/中/长期**。https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/hy_memory/models/memory.py
- `episodic`/`semantic`/短时/中期在这些官方文档与枚举里都**没有**出现；`episode` 是按写入间隔（默认 1800s）切分后总结一次的实现，`episode_summary.py` 明确说这是为了少花 token，不是记忆类型分层。https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/hy_memory/agent/episode_summary.py · https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/docs/env_reference.md
- 三种运行模式才接近「能力分级」：`lite` 纯向量无 LLM；`pro` 有 LLM 抽取与 reconcile；`ultra` 再加 System 2 图式归纳与图存储，且 `evolve()` 必须调用方显式触发。https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/docs/env_reference.md
- Working/Coding 是独立的两层（事实 + 可复用经验），Coding 另有「版本演进链」，用本地 git diff 记录，标称零 LLM 调用。https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/README.zh.md · https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/docs/env_reference.md

判定：Hy-Memory官网的“三层”是模型-引擎-应用产品栈，不是记忆层模型；不能据此认定用户指的是这个仓库，TencentDB候选需另行比较。

## 3. 读写管线、合并更新与失效

写：`client.add(messages, user_id, agent_id?, session_id?, memory_at, scene)`。原文进 raw（MemHub 文档口径：raw 只滚动保留三天，一条 raw 一个完整 turn，不含 tool）；再经 extractor 抽事实，reconciler 决定操作。https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/memhub/MEMORY.md · https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/hy_memory/client.py

合并/更新语义（`reconciler.py` 文档字符串与 prompt 一致）：
- `ADD` 纯新增；`UPDATE` 同主题合并精炼；`SUPERSEDE` 新旧替代并保留链头；`DELETE` 是**逻辑删除**（`status=SHADOW, is_latest=False`，不进演化链、不参与召回）。
- 状态另有 `SUPERSEDED / NEGATED / CONFLICTED / ARCHIVED`；低置信度推断同样进 SHADOW。
- reconcile 完全失败时降级为「全部 ADD」兜底。
https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/hy_memory/agent/reconciler.py · https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/hy_memory/models/memory.py

检索：`search(query, user_ids, include_sources/exclude_sources, layers, limit, min_score, reader)`；reader `legacy`（纯向量）或 `hybrid`（加后端关键词/BM25）；Chroma 下 hybrid 退化为纯向量。可选本地 cross-encoder rerank（需 torch，默认关）。L1 raw 不由 search 返回，L0 画像走单独 `get_user_profile()`。https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/docs/hy_memory_search_skill.md · https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/docs/env_reference.md

删除/失效：`delete(memory_id)`、`delete_all`（HTTP 层）存在；raw 有滚动窗口，抽取后的高层记忆不受窗口影响。**没有**跨记忆的 TTL/衰减策略说明，只有排序里的 `recency_decay_days`（默认 30）。https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/hy_memory/server.py · https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/hy_memory/config.py

## 4. 依赖与部署面

- Python `>=3.9`；主依赖 `chromadb>=1.5.9`、`kuzu`、`openai`、`pydantic`、`scikit-learn`、`tiktoken`、`rank-bm25`、`jieba`。可选 extra：`qdrant`/`faiss`/`neo4j`/`mysql`/`rerank(torch,transformers)`。
  https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/pyproject.toml
- 存储全在本地目录 `~/.hy_memory`（或 `MEMORY_DATA_DIR`）：chroma 目录、kuzu 库、`cache.db`、`coding_memory.db`。**无 Postgres**；`rdb.py` 自己标为「红色模块 - 待实现」，计划后端才有 PostgreSQL。
  https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/docs/env_reference.md · https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/hy_memory/data/rdb.py
- CPU 可跑：SDK 自身不做推理，LLM/embedding 走 HTTP；只有开本地 rerank 才需要 torch/GPU。权重模型（可选）需自备 vLLM/SGLang 服务，模型卡未给最低显存——**未验证**。
- MemHub 运行时另需 Node 24 + pnpm 11 + Python 3.12 + uv（源码开发口径）。https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/memhub/README.md

## 5. Claude Code / MCP 官方整合

- 官方文档《Claude Code 一键插入支持》明确：装的是「MCP 配置 + Skill + 三组 Capture Hook」，不是传统插件。
- 具体落点：`~/.claude.json` 的 `mcpServers.one-memory`；`~/.claude/skills/memhub-recall/SKILL.md`；`~/.claude/settings.json` 的 `UserPromptSubmit` / `Stop` / `SubagentStop` 调 `one-memory capture claude-code`；另有 `~/.claude/.one-memory/recall-install.json`。
- 默认工具 `om_recall`、`om_conversations`、`om_diagnostic_trace`；默认 scope `all-apps` 与 `source:claude-code`。一键插入**不是**自动 prefetch，MCP 是被动查询。
- MCP 是 app bundle 内的 stdio server，靠 `ONE_MEMORY_BROKER_DISCOVERY` 找本机 broker；跨进程只走回环。
https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/memhub/docs/harness-support/claude-code.md · https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/memhub/docs/contracts/one-memory-recall-install-v1.md · https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/memhub/packages/host-bridge/src/capture-hooks.ts

- 平台限制：Windows 不支持；只发 macOS arm64 + Linux x64/arm64（v1.0.4 产物）。https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/memhub/README.md
- 独立 SDK 的 `python -m hy_memory.server` 是零依赖 stdlib 服务，默认 `127.0.0.1:19527`、CORS `*`、**代码里没有任何 Authorization 校验**；不能当多用户服务暴露。https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/hy_memory/server.py

## 6. 导出与数据主权

- SDK 有 `get/list_memories/update/delete`，但没有批量导出格式或导入契约；正文权威在 Chroma/Kuzu/SQLite 里，MemHub 明确「不存 memory 实体」，只存 `memory_id`。
- MemHub 只有整机 `backup restore`（必须在 Runtime 停止时、只接受 `backups/` 内来源）；不是按智能体/按用户的可移植导出。
- 对PACE的适配问题是按scope导出、恢复和删除尚未建立明确契约，不是数据库存储本身违反原则。官方文件表达智能体接入定义，私有记忆与transcript也不应默认随公开定义包导出；如采用外部服务，连接可用官方MCP定义，记忆数据另行备份/有选择导出。
https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/memhub/MEMORY.md · https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/memhub/apps/cli/src/backup-restore.ts

## 7. 能否只当辅助记忆服务

可以，但要清楚三点（源码可证）：
1. 它不是智能体循环：没有工具编排/沙箱/文件系统，只提供 `add/search/get/update/delete/list/evolve` + profile。不会替代 Claude Agent SDK。
2. 它自带第二套模型调用链（extractor/reconciler/system2/evolve，中文 prompt 为主），会产生独立 token 成本与延迟，且默认温度、max_tokens 都由 `MEMORY_*` 变量控制。
3. 并发/质量未验证：仓库没有公开 PoC 性能数据可引用，官网 55.49 vs 54.62 的对比属营销口径，不采信。

https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/hy_memory/client.py · https://raw.githubusercontent.com/Tencent-Hunyuan/Hy-Memory/fcb1bcd8665322c3500027dae096f8749a61b071/hy_memory/agent/prompts_zh.py

## 8. 与 WeKnora 知识/Wiki 的边界

| 维度 | Hy-Memory | PACE 现有 / WeKnora 目标 |
|---|---|---|
| 内容 | 个人对话、任务经验、代码变更链 | 组织文档、外部来源、Wiki 页面 |
| 来源 | 对话消息 + 宿主 `~/.claude/projects` 导入 | 上传/飞书/GitLab/Feeds + 引用溯源 |
| 权限 | `user_id`/`agent_id`/`source` 过滤 + MemHub 授权 | 库级绑定、来源 ACL、专家范围 |
| 产物 | 事实/摘要/画像/图式 | 分块索引 + 可编辑 Wiki + 版本回退 |
| 可移植 | 二进制库 + 整机备份 | 目标为可导出素材 + 索引重建 |

结论：两者不能相互替代，但会在上下文供给、检索技术和经验整理上有交集，需明确职责。PACE已有agent-memory可作原生基线；外部服务也可按官方MCP配置接入，不因数据存数据库就违反原则。Hy-Memory不具备本轮已确认的完整文档同步/OCR/Wiki引用链，不能用它取消知识建设。

## 9. 证据化建议（按推荐度）

1. **先原生基线，再比较开源引擎。** 事实版本、替代链、逻辑删除和摘要是有价值的观察项，但不能据此默认在PACE自研一整套。若需要这些能力，先验证Hy-Memory或其他成熟开源组件能否适配，并与TencentDB Core比较。
2. **若确需语义记忆检索**，可在隔离环境做一次性spike：SDK连获准模型端点与测试存储，验证中文抽取、scope、删除后召回、重启和导出；采用前不接入正式产品数据。
3. **MemHub 个人跨工具记忆**只作为用户本机独立工具评估，不改 PACE 沙箱与 `.claude` 挂载；其 hook 会写用户级 `~/.claude`，与「每智能体独立 `.claude`」冲突，且不支持 Windows。
4. **不采纳**：把它当核心记忆底座 / 用它替代知识库与 Wiki / 引用官网或 README 的性能数字 / 在未验证前声称「支持 MCP 即可接入」。

## 10. 未验证与缺口

- 未运行 SDK 或 MemHub，未安装权重；所有质量、召回率、稳定性结论均无实测。
- `main` 与 `hy-memory-v2.0.5` 之间存在提交差异（main 已含 2026-10-24 架构文档更新），本文以 `main` 源码为准并标注；引用 release 行为时需按 tag 复核。
- 模型卡未给最低显存、上下文长度；「CPU 可跑」仅指 SDK 本身。
- 本地 rerank 模型默认从 HuggingFace 拉取（`nreimers/mmarco-mMiniLMv2-L6-H384-v1`），离线部署可行性未验证。
- 未核对 `THIRD_PARTY_NOTICES.md`/`SBOM.spdx.json` 全部第三方义务，仅确认主许可为 Apache-2.0。
