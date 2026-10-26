# 参考 WeKnora 的 PACE 核心知识库能力方案

## 目标

将 Tencent/WeKnora 源码下载到独立目录，基于源码对照 PACE 建设知识核心能力。2026-10-25 用户已确认完整闭环、Wiki与Feeds、外部同步全部属于建设目标，飞书/GitLab为首批必需来源。本轮继续修订整体方案、同步范围与依赖顺序，尚未开始产品代码实现，未授权提交。

## 基线与范围

- PACE：`797edfeaabd39b040d01736c49273da18347ea92`，沿用 `knowledge-base-research` worktree。
- 初始未提交成果：七份 `knowledge-base-research*.md` 均为此前本会话调研，不覆盖或提交。
- WeKnora：下载到 worktree 内 gitignored `.tmp/references/` 下的新建独立目录；下载后记录 commit、来源与许可。不执行下载仓库的脚本、安装器或构建。
- 本轮产出：本记录及后续分工报告。产品源文件与配置不变。

## 当前有效决定

- 用户确认参考项目核心能力均要建设：完整技术闭环、Wiki与Feeds、外部同步；首批必须支持飞书与GitLab。不再重复询问是否只做第一阶段。
- 外部知识源是主要输入，来源身份、权限范围、增量与删除、人工改动冲突须在基础模型中提前考虑，不能先限定成本地上传再后补。
- Feeds 暂按参考项目的 RSS/Atom/JSON 订阅源理解，不与 FAQ 混同；未把自动日报、推送等尚未提出的功能算作已确认。
- 单一 Claude Agent SDK 运行底座；智能体定义继续用官方文件，界面继续用本项目设计体系。
- 现有 Agent、聊天、技能、记忆、MCP优先复用。基础/Wiki/同步是完整目标的交付顺序，不是删减。
- 已有目标授权可继续细化契约和实施准备；尚无企业账号凭据、生产操作或提交授权，本轮不执行迁移、不调整安全策略、不接入真实企业数据。

## 方案与分工

1. 下载并记录固定源码快照。
2. 并行读取：文档管理/解析索引；检索/引用/模型；Wiki/同步/前端产品流程。
3. Opus 结合 PACE 现有模块给统一边界与能力映射，主会话汇总用户确认清单。
4. 独立核对方案与证据，检查文档链接与产出范围。

## 步骤

- [x] 下载及记录源码
- [x] 并行源码能力盘点与PACE边界设计，三份报告均返回
- [x] 核心范围、依赖与实现顺序，汇总见 [待确认方案](weknora-core-proposal.md)
- [x] 独立Opus复核：通过，可交用户确认；未发现必须修正的主稿问题
- [x] 文档相对链接、下载归档校验和与参考目录隔离校验通过
- [x] 用户确认完整闭环、Wiki/Feeds、外部同步全部建设；飞书/GitLab必需
- [x] 更新D-9与主方案，将外部来源提前纳入基础契约
- [x] 完成飞书/GitLab/Feeds范围核对与文档静态校验
- [ ] 按真实依赖继续组件验证与实施准备；真实企业连接等待实例/凭据/授权信息

## 下载快照

- 来源：https://github.com/Tencent/WeKnora
- commit：`e1f9a6166a593a4804a2f99f1d942919c9cc8ea7`（2026-10-24）
- 独立目录：`.tmp/references/weknora-ycXjpOdz/source/WeKnora-e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/`
- GitHub codeload 归档：88,660,139 字节、6,076 条目。
- 归档 SHA-256：`5cc4120384ff28c5b5911bc714dee445c01d678dfc6a82b1fbb513ab45094aaf`
- 使用 Python 标准库 data filter 解压，拒绝链接/特殊条目；没有执行仓库程序。git clone 在 worktree 隔离检查下被拒，改用固定提交归档下载，不改隔离设置。

## 许可与参考方式

已读取下载源码的 `LICENSE`、`THIRD_PARTY_NOTICES.md` 与 `licenses/rapidocr-MODEL_LICENSES.md`。WeKnora 自有代码为 MIT；若复制或实质改写相关源码须保留版权及许可。第三方组件有独立许可（通知中包含 MPL-2.0 的 Go 模块、Apache-2.0 的 OCR 代码及所列权重等），不能把整套依赖视为 MIT。当前只参考功能和调用链，未复制实现、模型或素材；具体采用的开源组件仍须单独核对版本与许可。

功能复刻不等于移植整套 Go/前端/Agent：优先复用 PACE 的 Claude Agent SDK、认证、MCP、队列、页面骨架与现有资源管理；视觉按 `docs/DESIGN-SYSTEM.md` §9–10，而非复制 WeKnora 皮肤。未实际操作 WeKnora 页面，本轮源码流程与截图只能支持方案，不能视为交互实测。

## 验证与限制

下载解压成功，源码目录约 148 MiB；`git check-ignore` 确认 `.tmp/references/` 不入库。归档 SHA-256 已记录，入口无下载代码执行。无产品代码改动，不跑应用构建。UI 本轮先从路由/组件及源码确认状态，未实际操作的交互会标明，不能当视觉实现验收。

## 本轮产出

- [用户待确认方案](weknora-core-proposal.md)：完整功能、交付顺序、依赖分叉和影响范围。
- [PACE边界设计](weknora-core-pace-boundaries.md)：官方文件、SDK、MCP凭证、引用与备份调用方。
- [文档入库盘点](weknora-core-ingestion.md)：上传/解析/切块/编辑/任务/清理。
- [检索与Wiki同步盘点](weknora-core-retrieval-wiki.md)：召回、引用、Wiki、FAQ、图谱和数据源。

## 下一步

用户已明确确认完整范围，最新方案见 [已确认范围与建设方案](weknora-core-proposal.md)。旧版Opus审查通过不代表新版已审。后续无需再询问是否全部建设；按共同来源契约细化、样本验证与实施准备推进。Feeds语义暂按订阅源，企业实例与凭据仅阻塞真实连接验证，不能把静态源码盘点当质量验收。本轮未部署、未执行数据库迁移或生产操作，未提交。
