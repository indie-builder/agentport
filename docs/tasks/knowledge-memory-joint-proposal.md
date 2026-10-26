# 腾讯分层记忆与 PACE 知识库：联合集成结论

> 2026-10-25。静态调研完成，未部署、未运行候选、未接入真实模型/企业数据。保留已确认的知识闭环、Wiki/Feeds和飞书/GitLab同步目标，本轮仅增加记忆集成探索。

## 1. 找到的项目与分层事实

用户记忆中的“腾讯Agent Memory DB”最接近 [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)；旧Tencent路径重定向到该仓库。用户尚未逐项确认仓库身份，不把近似名称当确定指认。

| 候选 | 原文层次 | 真实含义与限制 |
|---|---|---|
| TencentDB Agent Memory | L0 Conversation → L1 Atom → L2 Scenario → L3 Core/Persona | 原始对话＋三层提炼记忆；L1含事件/画像/指令类型，L2场景组织，L3稳定核心画像。Proxy另有层级说法，不与Core枚举混用 |
| Tencent Hunyuan Hy-Memory | 官网模型/框架/应用三层；Chat数据模型L0–L7 | 官网三层不是短/中/长期算法；数据类型有八层且L5 Knowledge注释未实现。Working/Coding另有场景化结构 |
| WeKnora 自身记忆 | profile/preference/fact/task/interest | 五类内容＋常驻/按需召回，不是五层存储；还含推断确认、手工修正和删除抑制 |
| PACE 已有 | SDK transcript + 专家原生auto-memory | 会话执行历史与长期Markdown笔记已分开；尚缺真实模型跨run记忆验收，不能视为一无所有或已达标 |

腾讯候选源码：TencentDB `6a4bb55ea54834d8265ce52024d3e3c75db30d38`（默认分支feat/server_team），Hy-Memory `fcb1bcd8665322c3500027dae096f8749a61b071`；均晚于部分release，不据main直接承诺发行版功能。

证据：[TencentDB分层与接口](tencentdb-agent-memory-research.md)、[Hy-Memory管线与部署](hy-memory-research.md)、[PACE原生边界](knowledge-memory-boundaries.md)、[WeKnora重合核对](tencent-memory-integration.md)。

## 2. 结论：可联合建设，优先验证 TencentDB Core 的辅助服务路径

**知识管线与记忆管线互补，适合放在同一产品体验中，但不能把几套完整产品叠起来。** 建议先保留PACE原生记忆为基线，独立验证TencentDB MemoryCore的收益，之后再定产品接入。不整体引入其Proxy/Panel/Knowledge，不先把分层算法翻译成自研TS。

理由：TencentDB的Core本身是Node服务，默认SQLite/本地文件，可独立承担提取、场景归纳与记忆检索，不托管Agent循环；这在架构上可以与Claude Agent SDK并存。核心许可MIT，仍需核具体依赖与复用代码声明。它并不要求使用腾讯云数据库，embedding可关，生成提炼仍需要模型。

**不是零适配**：已查MCP只覆盖Wiki/CodeGraph，未发现现成记忆MCP。官方Claude Code自动接入依赖模型Proxy。PACE若只复用Core，需以REST桥接为受控记忆工具或受支持SDK集成点，自己明确身份映射、鉴权、采集、触发、召回及导出；不能改一个URL即宣称完成。

Hy-Memory可以作为另一辅助引擎比较，它提供抽取/reconcile、事实替代链与不同记忆场景；不应因多存储或Python自动淘汰。但其Python/Chroma/Kuzu/SQLite部署、MemHub用户级hooks、按scope数据导出与服务鉴权适配成本更高，暂不优先整套接入。其辅助模型调用并非第二个Agent harness，两者不能混为一谈。

## 3. 知识与记忆的职责

| 内容 | 推荐责任方 | 作用 |
|---|---|---|
| 本轮任务历史、压缩与恢复 | 现有Claude Agent SDK transcript/resume/fork | 保持执行连续性，不重复接管上下文压缩 |
| 专家私有偏好/反馈/项目线索 | 现有原生MEMORY.md/主题文件 | 默认私有、管理员可编辑，先验证原生收益 |
| 企业文档、事实证据 | 已确认WeKnora式知识建设 | 飞书/GitLab/Feeds、解析/OCR、索引、引用、更新删除 |
| 场景经验与结构化长期召回 | 候选MemoryCore，独立验证后决定 | 跨会话提炼与相关记忆召回；不自动把所有对话灌进企业库 |
| 企业Wiki与可共享方法 | 知识内容发布流程＋现有SDK生成 | 有来源、版本、编辑与权限，经验推广需明确授权 |

这里不是要求五个服务或数据库。可共用模型端点、日志、任务基础与部分检索技术；采用MemoryCore时默认SQLite仍会多一份持久数据，不能假称已可直接复用PACE Postgres。

## 4. 一次任务如何配合（设计建议，未实现）

用户问题进入既有SDK会话；原生记忆或获准的记忆工具提供相关偏好/经验，专家据问题调用绑定知识库获取证据，再回答并附来源。无需每轮固定跑两套召回，也不把全部画像/场景常驻塞进system prompt。

任务完成后，只有明确选择的数据进入记忆提炼。提炼结果保留来源、归属与修正途径；个人偏好、模型推测、企业制度分开。需要形成共享Wiki/技能时先按发布权限处理，技能使用官方SKILL.md/supporting files，Wiki内容仍属平台知识资源。

例如：飞书正式制度是知识证据，“我偏好简洁回答”是私有偏好，“上次处理某系统故障的有效步骤”可成为场景经验。新制度替代旧制度时，旧经验仍需看适用版本，不能因记忆召回就覆盖新证据。

## 5. 最关键的集成决策：避免两个写作者争同一事实

候选验证可并行对比，但正式产品需确定每个scope的写入权威。推荐起点：

1. 原生auto-memory继续是专家私有记忆的写入机制；若为其加索引，索引只作派生，不反向擅自改文件。
2. MemoryCore验证使用独立测试scope，不默认采集全部生产聊天、不将原生私有文件自动写入另一数据库。
3. 如选择MemoryCore管理独立场景经验，只对显式划定的记录负责，避免与原生memory重复保存/循环抽取；需验证API能否满足该隔离，不能只靠提示词保证。
4. 若最终决定由外部引擎取代某范围原生提炼，要明确停用/迁移/导出，并取得产品决定，不保留双向双写真相源。当前尚未选择替换。

所有连接配置走官方MCP/文件或SDK支持的边界；不新增私有Agent定义、不接管现有模型代理/会话流。外部服务用数据库存数据本身不违反文件定义原则；私有记忆不应默认随公开Agent包导出，数据需独立备份/有选择导出。

## 6. 联合接入要补的工程内容

- **主体与scope映射**：PACE agent/conversation/run与候选team/agent/user/task映射；现有单管理员不等于所有专家私有记忆共享，不引入无需求的多租户系统。
- **记忆入口**：采集允许的消息或成果、后台提炼、幂等/失败可见；不用Proxy抓全部模型流量，不依赖短超时SessionEnd作为唯一保存点。
- **受控工具**：REST适配到MCP记忆search/read/明确写入管理能力，server端裁决scope；不把客户端传来的userId当身份。
- **原生记忆与管理界面**：复用现有记忆面板，解释原生笔记/场景经验各自来源，不增加互相矛盾的编辑器。
- **来源生命周期**：知识源更新/撤权后，新检索与相应派生知识失效；相关记忆摘录需能定位并复核。向量相似命中不等于有权限。
- **修正和遗忘**：删除一条记忆、清会话、删除源文档是不同操作；验证后续提炼不会无意重新生成已拒内容，勿将逻辑删除说成备份和历史物理清除。
- **基础设施与恢复**：候选服务/SQLite文件/模型费用、备份、升级、导出、删除；知识与记忆可统一导航和引用但不共享无scope的全集。

## 7. 最小验证：先证明增益，再决定产品依赖

**A 原生基线**：真实run A保存明确偏好/项目事实，销毁容器；新session B不传resume召回。另测resume/fork，避免把历史续聊成功误当长期记忆成功。

**B MemoryCore隔离实验**：固定可运行release，只起Core、使用测试scope和获准模型端点，不启Proxy/Panel/Knowledge；记录对话→原子→场景→画像真实输出。检查scope、纠错、去重、删除、提炼重跑、重启与数据导出。

**C 相同任务对比**：只原生、原生+显式场景召回两组，比较中文召回、旧事实纠正、误记/漏记、额外token/延迟。不能只测层数出现，不使用上游默认阈值作为最优参数。

**D 知识协同**：用模拟飞书/GitLab源更新/撤销测试知识/Wiki/记忆摘录传播；无答案不编造，私有记忆不流入公共Wiki。Feeds只是持续知识来源，不是默认用户画像来源。

通过后决定：继续原生＋知识、增加受限MemoryCore、或比较Hy-Memory。借鉴算法自研排在现有/原生/开源可复用能力之后，不在本轮预选自研。

## 8. 未验证项与当前交付

本轮只读官方源码/文档和PACE实现；尚未部署候选、下载模型、实际运行API/MCP、证明跨run召回或删除不重生。SDK与发行镜像、外部项目main与release有版本差异。TencentDB Core/Proxy层级命名不同，Hy-Memory部分层仍未实现，均不能当完整落地承诺。

主稿与三份定向报告已落调研worktree，产品实现未改，未提交/合入。旧知识建设仍按已确认范围保留；记忆项目目前是候选，不因本报告自动替换原生memory或扩大数据采集。
