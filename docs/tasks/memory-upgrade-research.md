# 记忆升级：腾讯方案研究与 Agentport 现状映射（证据报告）

> 状态：研究证据与映射参考，不是实现契约，不构成交付声明。本文记录研究时的现状快照（基线 `522182f`），不随后续实现回写成“已完成”。
> 最终升级范围、字段与验收由 [执行契约](memory-upgrade-contract.md) 确定；实现状态以 [任务记录](memory-upgrade.md) 为准，本文不猜字段、不自行划定范围。
> 腾讯仓根：`/Users/xbjt/Documents/myself/TencentDB-Agent-Memory`，HEAD `ecc01a545da0b2ac6cae2f0f0af0d39d41469793`，`git status` 干净。本文只读代码与文档，未运行测试、未安装、未部署，未修改腾讯仓任何文件。

## 1. 腾讯能力矩阵

| 能力 | 腾讯做法 | 关键证据（腾讯根相对） | 迁移判断 / 风险 |
| --- | --- | --- | --- |
| L0 对话 | 对话原文与 checkpoint 原子记录，供核对原话、时间、来源 | `MemoryCore/src/core/hooks/auto-capture.ts:96`（checkpoint）、`:108`（captureAtomically） | 原始消息 Agentport 已有，但“完整上下文”与实现不完全一致，见 §2.1 |
| L1 原子 | 从最近 10 条新消息 + 5 条背景中单次 LLM 抽取事实、偏好、约束、事件 | `MemoryCore/src/core/record/l1-extractor.ts:149`、`:177`、`:184` | 抽取窗口与成本可参考；不要照搬单次抽取的可靠性假设 |
| L2 场景 | 按项目/场景聚合 L1 为知识块；增量按游标读取新 L1 | `MemoryCore/src/utils/pipeline-factory.ts:751`；`MemoryCore/src/core/persona/persona-generator.ts:110` | 场景层是 Agentport 当前主要缺口；是否引入由契约定 |
| L3 画像 / 团队原则 | 画像或团队 Operating Doctrine；已有内容 + 增量场景，无变化则 skip | `MemoryCore/src/core/persona/persona-generator.ts:110`；`MemoryCore/src/core/prompts/persona-generation.ts:144` | 代码模式生成 SOP/原则，不是个人私有画像；团队共享语义需单独设计 |
| 提取触发 | 默认每 5 轮或 idle 600s 触发 L1；L2 延迟 10s、最短 900s、最长 3600s；L3 每累计 50 条 | `MemoryCore/src/config.ts:681-686`、`:662` | 自动触发会产生后台 LLM 成本；Agentport 需先有成本预算与可见性 |
| 去重 / 冲突 | LLM 判 store/update/merge/skip；冲突候选用混合召回；失败回退“全部新增” | `MemoryCore/src/core/record/l1-dedup.ts:118`、`:190`；`MemoryCore/src/core/record/l1-extractor.ts:311` | 失败回退会放大重复；可借鉴动作集合，不照搬静默回退 |
| 检索 | FTS/BM25 与向量并行，RRF（k=60）融合；搜索先取 `limit*3` 再按类型筛 | `MemoryCore/src/core/tools/l1-candidate-recall.ts:62`、`:154`；`MemoryCore/src/core/tools/memory-search.ts:134` | 无时间衰减、无用户反馈重排；Agentport 若做检索需明确排序信号 |
| 注入 | L3 稳定注入（最多 6000 字）；L2 只给路径索引；L1 由 LLM 通过 Bash curl 按需取 | `MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts:107`；`MemoryProxy/src/injection/index.ts:388` | 注入预算思路可参考；透明代理 + Bash curl 通道不迁移 |
| Scope / ACL | L2/L3 按 team+agent 共享，忽略 user/session；L0/L1 保留 user/session/task；资产 ACL 含 Owner、团队、private、restricted | `MemoryCore/src/core/profile/profile-scope.ts:34`；`MemoryCore/src/metadata/service/permission-checker.ts:43` | 团队共享不是个人私有记忆；Agentport 已有 RBAC/businessId 边界，不能直接套用 |
| 跨 Agent 借用 | 最多借入 2 份同队 asset，并发搜索 | `MemoryProxy/src/memory/memory-bridge.ts:468` | 借用上限与来源标注可参考；Agentport 当前没有等价的授权共享检索 |
| 来源 / 版本 | L1 记录来源消息、generation 日志；skill/资产有版本 | `MemoryCore/src/core/record/l1-extractor.ts:235`（`source_message_ids`）、`:300`（generation 日志）；`MemoryCore/src/core/skill/skill-versioning.ts:117` | Agentport 的 `memory_changes` 覆盖个人偏好、专家 `MEMORY.md` 与专家规则；主题文件的手工编辑/删除和 SDK 原生写入没有完整版本账本，不能据此宣称专家记忆全量可回滚，也不能假设腾讯行级版本模型可直接复用 |
| 删除 / 遗忘 | TTL 默认关闭，仅 L0/L1 按自然日清理；单层删除，不重算上层；clear 清 L0-L3 内容但保留资产 ACL | `MemoryCore/src/utils/memory-cleaner.ts:69`；`MemoryCore/src/gateway/v2-router.ts:1293`；`MemoryCore/src/gateway/chat-memory-handlers.ts:193` | 不是认知遗忘/反馈学习；不迁移“未证实的遗忘反馈” |
| 过程经验 Skill | 从工具调用过程抽取 `SKILL.md` + 资源文件，带版本；阈值 10 次工具调用，归档 40KB，最多 16 轮迭代 | `MemoryCore/src/core/skill/skill-extractor.ts:148`；`MemoryCore/src/core/skill/skill-config.ts:238`、`:164`、`:240` | 与 Agentport 官方 skill 文件体系同向；是否做自动生成由契约定 |
| 知识库 / offload | Wiki 由文档派生，CodeGraph 由代码索引；它们是知识资产，不是对话记忆 | `MemoryKnowledge/src/engines/wiki/ingest-v2/index.ts:114`；`MemoryKnowledge/src/engines/code/bridge.ts:106` | 知识库与对话记忆必须分开建模；不要用记忆表承载文档/代码图谱 |

## 2. 关键证据与风险

### 2.1 L0 并非总是“完整原文”
README_CN.md:246 写 L0 保存“原始对话与完整上下文”，但 Proxy 实际 `MemoryProxy/src/tdai/recorder.ts:21-38` 只取最后一条 user 的真实提问（去掉 harness 噪声）加当前 assistant 内容，不是完整原始上下文。评估“回看原话”能力时以代码为准。

### 2.2 去重的失败模式
`MemoryCore/src/core/record/l1-dedup.ts:190` 在批量判重失败时把所有候选标为 `store`，会制造重复；`MemoryCore/src/core/record/l1-extractor.ts:361-363` 同样 warn 后全部新增。可借鉴动作集合（store/update/merge/skip），但不应把“失败即新增”当作默认。

### 2.3 写入一致性风险
`MemoryCore/src/core/record/l1-writer.ts:275` 对 update/merge 先删除目标旧记录，再写入新记录；删除成功而写入失败会留下空窗。该风险不迁移到 Agentport，Agentport 已有事务 + 变更账本/回滚语义。

### 2.4 游标推进与 success
`MemoryCore/src/utils/pipeline-factory.ts:615-669` 对每组调用 L1 抽取后直接 `markL1ExtractionComplete`，未见对 `l1Result.success` 的检查；若抽取返回失败但不抛错，游标仍可能前移。迁移时必须把“成功才推进游标”写成显式契约。

### 2.5 检索排序
`MemoryCore/src/core/tools/l1-candidate-recall.ts` 的 RRF 只按排名融合，没有时间衰减、使用频次或用户反馈重排；`l2MinInterval` 等参数也不等于检索反馈。不要把 L2/L3 的 `heat` 当成“检索命中次数”：`MemoryCore/src/core/prompts/scene-extraction.ts:159-185` 只在生成/更新/合并场景时按旧 heat 累加。

### 2.6 注入与代理边界
`MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts` 稳定注入 L3（6000 字截断）与 L2 路径索引；L1 自动召回注入器已下线，改由 LLM 通过 Bash curl 走代理。Agentport 不迁移透明代理和 Bash curl 通道，应走官方 hook / 文件 / 工具能力。

### 2.7 删除与遗忘
`MemoryCore/src/utils/memory-cleaner.ts:69` 的 TTL 默认关闭；`MemoryCore/src/gateway/v2-router.ts:1293` 是单层删除；`MemoryCore/src/gateway/chat-memory-handlers.ts:193` 清内容但保留资产与 ACL。没有看到基于用户反馈的认知遗忘闭环，因此本报告不把“遗忘反馈”列为可迁移能力。

## 3. 基准与测试边界

- README_CN.md:271 宣称 PersonaMem 48% → 76%（+59%）；本次未复现，不作为选型依据。
- `MemoryCore/src/core/store/__contract__/memory-store.contract.ts` 覆盖 CRUD、BM25、过滤，不证明向量检索质量。
- `MemoryCore/scripts/e2e-memory-prompt-vdb-cos.ts:338` 关闭去重，`:400` 附近 L2/L3 溯源为手工构造，不代表完整 worker 闭环；本次未运行。
- 以上边界意味着：腾讯代码可证明“有哪些机制”，不能证明“效果优于 Agentport”。

## 4. 与 Agentport 现有能力的映射（研究时现状，仅列已核实）

| 能力 | Agentport 现状 | 证据（本仓相对） | 结论 |
| --- | --- | --- | --- |
| 原始消息 | 会话/消息已存 DB；SDK transcript/resume 是运行恢复，不等于长期记忆 | `packages/db/src` 会话消息仓储；`packages/worker/src/session-workspace.ts` | 不需要新建 L0 存储 |
| 主 Agent 长期记忆 | 官方 auto-memory：`agent-memory/` 读写挂载 `/mnt/agent-memory`，`MEMORY.md` + 主题文件 | `packages/sandbox/src/runner.ts:443`、`:489`；`packages/api/src/features/agents/routes.ts:928` | 已有，不另造第二套定义 |
| `MEMORY.md` 索引 | 官方只加载前 200 行 / 25KB（先到者为准）；当前仅审核采纳校验该上限，手工编辑/上传只受 200000 字节上限 | `docs/PITFALLS.md:324`；`packages/api/src/features/memory-reviews/routes.ts:33-48`、`:478`；`packages/api/src/features/agents/memory-files.ts:10` | 索引与详细主题文件必须分开；手工入口尚未执行 200 行 / 25KB 校验 |
| 个人记忆 | DB 中按 `businessId` 单行存储（`user_preferences`）；文件目录用 `sha256(businessId)`，只读投影 `CLAUDE.md` 并由 `UserPromptSubmit` 每轮注入 | `packages/api/src/features/memory/personal.ts:37-46`；`packages/worker/src/personal-memory.ts:12-40`；`packages/sandbox/src/memory-permissions.ts:35-74` | 已有；单次上限 9000 字符 |
| 子智能体记忆 | 官方 `memory: project`，只接 `.claude/agent-memory/<slug>/`；user/local 未纳入 | `packages/core/src/workspace.ts:186`、`:420`；`packages/core/src/official-files.ts:62` | 已有；不要扩成自定义记忆目录 |
| 历史回顾 / 审核 | 整篇完整替换提案、证据须为原文连续子串、用户采纳/拒绝、请求 hash 幂等、变更账本 + 回滚 | `packages/shared/src/memory.ts:44-90`；`packages/worker/src/memory-review.ts:113-139`；`packages/api/src/features/memory-reviews/routes.ts:435`；`packages/api/src/features/memory/changes.ts:544` | 已有完整闭环 |
| 详细主题回顾 | 当前审核目标只有 personal、`agent_memory`（写 `MEMORY.md`）、`agent_rule`；不能直接选择某个主题文件 | `packages/shared/src/memory.ts:8-19`；`packages/api/src/features/memory-reviews/routes.ts:477` | 已知缺口；由契约决定是否补 |
| 自动提炼 / 去重 / L2 | 主要依赖 SDK 原生 auto-memory；没有平台侧 L1/L2/L3 管线、冲突合并、检索重排 | 同上 | 是潜在升级点，不是既定范围 |

## 5. 明确不迁移 / 不做

- 不新增独立记忆服务、透明代理或第二套 DB 定义；优先官方文件 + 已有 DB 能力。
- 不迁移云服务适配、多节点队列、多向量后端搬迁。
- 不引入未证实的“遗忘反馈”“热度命中”机制。
- 不把腾讯的团队共享默认值直接套到 Agentport 的业务/个人边界。
- 不在本文确定字段、表结构、接口或验收；这些只由 `memory-upgrade-contract.md` 决定。

## 6. 发现的文档冲突

1. 腾讯 README 的“L0 完整上下文”与 Proxy 实际只存清洗后的最新问答不一致，以代码为准。
2. 若把 `heat` 描述为检索命中/使用频次，与 `scene-extraction` prompt 的“生成/更新/合并时累加”不一致。
3. 旧研究中的 SDK `0.3.303`、子智能体记忆不支持/过期等说法已过期；`memory: project` 已接通，见 `docs/tasks/memory-upgrade.md`。
4. 本地 SDK `0.3.311` 类型注释仍写 `autoMemoryDirectory` 在 project settings 中会被忽略，与官方当前“有条件允许”不一致；D-61 已于 2026-10-31 按官方更正，本地类型注释未改，见 `docs/tasks/memory-upgrade.md`。

## 7. 下一步

1. 范围已由 Opus 在 [执行契约](memory-upgrade-contract.md) 固定；实现进行中，状态见 [任务记录](memory-upgrade.md)，本文不作为通过证据。
2. 契约必须给出：触发与成本上限、成功/失败与游标语义、去重冲突动作、注入预算、scope/ACL、来源与版本、删除/回滚、验收命令。
3. 实现前先核对官方 SDK/Claude Code 当前文档与本仓 `sdk.d.ts`，不凭本文推断。
