# 真实运行验收：OpenUI 多轮 + 知识库真实链路

## 目标

在隔离环境中用真实模型、真实解析/OCR/外部来源跑通两类链路并取得可复现证据：

1. OpenUI：多轮生成、输入提交、patch、刷新、分支恢复。
2. 知识库：Docling/OCR/embedding 模型、外部来源（按实际配置与企业可用范围）。

发现问题即修复，行为用例与 Opus 独立 review 同步进行。

## 方案

- 三阶段，按依赖串行；阶段内可并行。
- 阶段 1 先完成资源与隔离，之后才可能产生可信证据。
- 阶段 2 允许通过现有 gateway 调用真实模型；用户已明确「预算不需要考虑核心正确性」，不再等待费用批准，也不设 3 次/1 USD 上限；仍须避免无意义调用，并记录每次真实调用及结果。
- 阶段 3 先核对实际配置与企业可用范围，不假设外部服务可用、不冒用未知企业资源。

### 阶段 1：资源与隔离准备

- 孤立随机命名的 Postgres 库（每次验收新建，不迁移旧数据）。
- 独立 Redis 实例/库号，与开发 worker（db 0）和测试（db 9）都隔离。
- API 使用随机可用端口，模型代理端口同样避开 3426。
- 独立 `WORKSPACES_DIR` / `KNOWLEDGE_DIR`，不复用共享卷。
- 独立管理员登录，不触碰用户当前登录态。
- 不改共享 `.env`、不改登录配置、不改 compose、不改 worker 默认行为、不替换 Claude Agent SDK。
- 不输出任何凭据明文（日志、回复、本记录均不写）。
- main 上已有共享 api/worker；验收只用隔离实例，不与共享进程抢数据。
- 沙盒镜像 `agentport/sandbox:tech-stack-20261028` 已通过 `docker images` 确认存在；是否最新需另行核对，不据名称臆断。

### 阶段 2：真实 OpenUI 链路

- 多轮生成：连续对话下多段 UI 程序推送与合并。
- 输入提交：表单交互值进入提交载荷。
- patch：增量编辑后的程序状态。
- 刷新：页面重载后消息与交互状态恢复。
- 分支恢复：切换/恢复会话分支后状态一致。
- 已知相关缺陷见 `docs/tasks/openui-integration-audit.md`；修复以本阶段真实复现为准，不照搬结论。

### 阶段 3：真实知识库链路

- 按实际 `.env`/compose 配置确认 Docling、OCR、embedding 模型及外部来源的可用性。
- 外部来源需先确认企业授权范围；未经确认不发起对外请求。
- 覆盖：文档导入 → 解析/OCR → 切分与索引 → 检索引用。
- 实际完成范围仅 PDF 的 OCR 解析与 chunk 生成；完整 embedding/rerank、企业来源、Office 格式、compose `--profile docling`、插图导出均未验证，不得据此勾选整条阶段 3 链路。
- 同样发现问题即修复并补行为用例。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/real-runtime-acceptance`
- 分支：`test/real-runtime-acceptance`
- 起始 commit：`d116bd66fa53c5fb52d03208fc87cd7d39ed36ae`
- 初始未提交差异：无（`git status --porcelain` 为空）
- 允许改动：本验收任务范围内的源码、测试、脚本、配置样例与本文档；共享 `.env`、登录配置、compose、worker 默认行为不在范围内。
- 原「本轮记录文档之外不新增其他文件」为准备阶段临时限定，已由验收修复范围替代：真实确认的缺陷可修改 parsing/tests/必要 fixture，临时脚本一律放 `.tmp/`，不纳入提交。

## 当前有效决定

- 用户说「按建议做」，允许准备、验收与修复。
- 用户最新明确「预算不需要考虑核心正确性」：允许现有 gateway 真实模型验收，不再等待费用批准，不限 3 次/1 USD；仍避免无意义调用并逐次记录结果。前轮「无预算不得调用」仅为历史记录，已失效。
- 不得冒用未知企业资源。
- 用户最新明确要求「提交 PR 并合并」，授权提交、推送、创建 PR、合并及清理已合并的干净工作树；不触发或等待 CI。
- 不替换 SDK，不改共享运行配置。
- 当前不需要定时任务（CronList 已确认无任务）。
- 两个资源/设计调查代理已完成，结果以本记录「阶段 3 实际证据」所载为准；不再写为进行中。

## 已替代项及原因

- 「阶段 2 需用户给出费用预算并明确同意」：被用户最新决定替代——预算不作为核心正确性验收的前置条件，改为允许现有 gateway 真实模型调用，避免无意义调用并记录结果。

## 步骤

- [x] 读 `docs/PITFALLS.md` 与 `docs/DEV-WORKFLOW.md` 相关章节（建树、配置启动、撤销、任务记录模板）。
- [x] 建立任务记录（本文件）。
- [x] 阶段 1 资源清点与启停/清理设计完成。
- [x] `pnpm install --frozen-lockfile`、shared core db 准备、`packages/web` 基础构建此前均已真实通过。
- [x] 启动脚本 `.tmp/real-runtime/launch.ts` 准备并校正：停进程改顺序执行、确认退出后才清理资源、失败收集到 `failures`、`rm metadata` 失败也计入；删除重复信号监听；静态类型检查通过。
- [x] 阶段 1：隔离资源就绪（随机库、独立 Redis、随机端口、独立工作区/知识目录、独立登录），并记录可复现的启动四要素（代码根目录、commit、配置路径、URL）。
- [x] 阶段 2：真实 OpenUI 多轮链路（4 次真实 run 全部成功；证据见下「阶段 2 实际证据」）。
- [x] 阶段 3：核对实际配置与企业范围后跑真实知识库链路（仅 PDF/OCR 解析与 chunk 范围完成；范围与未验项见「阶段 3 实际证据」）。
- [x] 两类链路的问题修复 + 行为用例 + Opus independent review 完成；永久 Docling JSON 用例与 fixture 已补入，随 3 个测试文件实跑 76/76 通过。

## 阶段 1 实际就绪参数

- 代码根目录：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/real-runtime-acceptance`
- commit：`d116bd6`（实际 `launch.ts` 写入的短 hash；与本文「起始 commit」一致）
- 配置路径：`/Users/xbjt/Documents/myself/agentport/.env`（只读进内存，不改、不打印值；不含独立 env 文件）
- URL：`http://127.0.0.1:55482`（恒为本验收实例；脚本内硬断言该值，禁止指向共享实例）
- 隔离资源：库 `real_openui_3a763e7ed3cd4bb3`、Redis 容器 `backend_test_redis_ad3f5772a84e4509`、模型代理端口 55483、独立 `WORKSPACES_DIR`/`KNOWLEDGE_DIR`（均在 `.tmp/real-runtime/` 下）
- 沙盒镜像：`agentport/sandbox:tech-stack-20261028`，`docker image inspect` 实际 ID `9a66ecd89a73`

## 启动尝试记录

- 第一次：以相对路径启动失败（module missing），未创建任何资源。
- 第二次：`btbin90lw` 启动成功，隔离资源就绪，URL `http://127.0.0.1:55482`。
- 主会话在真实浏览器中完成 4 次真实模型 run，均成功；分支截图 `/tmp/real-openui-branch.png`（副本：`.tmp/real-runtime/real-openui-branch.png`）。

## 阶段 2 实际证据

- 脚本：`.tmp/real-runtime/acceptance-evidence.ts`（Node 直跑，`main.env` 只在内存 parse；不打印凭据、不改共享 `.env`、不改登录配置）。
- 产物：`.tmp/acceptance-evidence.json`，含两个会话的完整 `messages`（含 `uiProgram`/`uiState`）、`runMetrics`；不含 cookies/headers/token。
- 主会话复跑断言全部 PASS（15/15），产物不含 secret。
- 原会话 `conv_01m60fz7ebe4f9e3m8djc354kq`：3 次 run 全部 `succeeded`，费用 `0.094 / 0.1089 / 0.1143`；4 次 run 合计 `0.3216`，费用仅为观测记录，不是预算约束（用户明确不考虑费用）。
- 原会话真实生成表单与图表；填入 `fullName=林测试`、`people=2人`、`day=2026-10-30`、notes 两行（素食/周五下午出发）、`hiking`/`swim` 均为 `true`，刷新后状态保留；点击动作经真实模型确认全部生效。
- patch 实际只有 2 条 statement 真实合并，canonical 程序保留 `FormBarChart` 与 `[12,18,30]`，图表 data 视图实际为 12/18/30。
- 分支 `conv_01m60g6bp6e4f9e3r6j3dfqhva`：父会话为原会话；复制 state 后改名为 `分支测试`，刷新保留，原会话仍为 `林测试`。
- 分支 1 次真实 run 成功、费用 `0.0044`；真实 SDK resume 仅 header 补丁成功，`[12,18,24]` 保留。
- 消息条数（实际值，不作前置假定）：原会话 6 条、分支 5 条。
- 截图已查看：`.tmp/real-runtime/real-openui-branch.png`、`/tmp/real-openui-final.png`。

## 阶段 3 实际证据

- 隔离实例：本轮新建随机 Postgres 库、独立 Redis 容器、随机 API/模型代理端口、独立 `WORKSPACES_DIR`/`KNOWLEDGE_DIR`；验收结束后库 `exists=false`、Redis 容器已 remove，两轮 Docling/API/worker 容器全部清理无残留；共享 4 个容器仍在运行，未受影响。
- Docling：用固定镜像独立容器直连两轮。corrected fixture 真实 `status=success`、`errors=0`；两表各自 `num_rows=8`（1 header + 7 data），page 2 为 A101..A107、page 3 为 A108..A114，合计完整 14 codes；OCR 第 4 页命中 4207 字符；OCR off 时无该文本。
- 证据文件：`.tmp/real-runtime/docling/acceptance.pdf`、`docling-corrected.json`、`docling-raw.json`、`docling-noocr.json`、`ocr-page.jpg`、`replay.test.ts`。
- `pictures=0` 只说明该 fixture 未返回插图，不证明插图导出失败，也不证明可用。
- 旧表少行 A107/A114 已归因于 fixture 底框缺陷并排除上游/产品丢失，不再列为产品 bug。
- 知识资源：主会话实际汇总 1038 条 embedding 全为 `local_fixture`/`test_model`，39 条 feed 无企业 source；这些是本地协议夹具，不是可用的真实 embedding/rerank 或企业来源，不得写成已接通。

## 阶段 3 修复

- 真实 response 回放（`.tmp/real-runtime/docling/replay.test.ts`）修复后 1/1 通过：OCR chunk 落在 page 4，表格 14 codes、page 2/3。
- 产品缺陷：仅标题的 Markdown（OCR 纯标题页）在 `parsing.ts` 被跳过，chunk 为 0。修复让无正文承接的标题（连续同级/上级标题、文末标题）落成自身内容块，普通标题仍只作面包屑。
- 改动范围仅 `packages/worker/src/knowledge/parsing.ts` + 测试 `packages/worker/test/knowledge-parsing.test.ts`、新增 `packages/worker/test/knowledge-heading-content.test.ts` 与 fixture `packages/worker/test/fixtures/knowledge-parsing/docling-heading-only.json`；adapter 推断正文页码的尝试已移除，最终 adapter 无 diff。
- 实跑：上述 3 个测试文件 76/76 通过（历史 75 条 + 永久 Docling JSON 用例 1 条，含独立标题用例 5/5 与 adapter 用例）。产品修复经 Opus 独立 review 通过；新增的第 76 条永久 Docling JSON 用例与 fixture 也已单独复核通过。
- 真实 response 回放最初 red：OCR chunk count 为 0，Markdown 与 Docling JSON 两个 heading 入口均跳过；现已修复并通过回放。
- Opus 复核确认的真实 bug：仅标题的 OCR 文本在 md 中存在但 chunk 丢失；产品侧已修复（范围见「阶段 3 修复」）。

## 改动文件

- `docs/tasks/real-runtime-acceptance.md`（本文件）
- `packages/worker/src/knowledge/parsing.ts`（产品修复：仅标题/无正文标题落成内容块）
- `packages/worker/test/knowledge-parsing.test.ts`
- `packages/worker/test/knowledge-heading-content.test.ts`
- `packages/worker/test/fixtures/knowledge-parsing/docling-heading-only.json`
- `.tmp/real-runtime/launch.ts`
- `.tmp/real-runtime/acceptance-evidence.ts`（证据脚本）
- `.tmp/real-runtime/real-openui-branch.png`（截图 artifact）
- `.tmp/acceptance-evidence.json`（证据产物）
- `.tmp/real-runtime/docling/`（真实 Docling fixture、响应与回放 test）

## 下一步

- 全部独立服务已清理：随机库 `real_openui_3a763e7ed3cd4bb3` 实测 `exists=false`，Redis 容器 `backend_test_redis_ad3f5772a84e4509` 已 remove；两轮知识库容器无残留，仅共享 4 个容器仍在运行、未改动。
- 修复已在本 worktree 验证通过，尚未合入 main。
- 真实链路下一步卡在缺少真实 embedding 服务配置，不是预算问题；企业来源凭据同样未提供。
- 新增的第 76 条永久 Docling JSON 用例已独立复核通过，无阻断项。
- 本轮未跑性能采样，不保证「全部模型」路径；阶段 3 仅 PDF/OCR 解析与 chunk 范围完成，完整 embedding/rerank、企业来源、Office、compose `--profile docling`、插图导出均未验。
- 用户已授权提交 PR 并合并；验证及独立评审完成，进入提交、PR 与合并收尾。本 worktree 的 `.vitest/json/output.json` 已恢复为原状，不纳入提交。

## 验证

- 真实通过：`pnpm install --frozen-lockfile`、shared core db 准备、`packages/web` 基础构建；`launch.ts` 静态类型检查；阶段 1 隔离资源就绪（metadata 实测）；阶段 2 证据脚本 15/15 断言 PASS（主会话复跑）；隔离资源清理实测（库不存在、Redis 已移除）；corrected fixture 真实 Docling 两表 8 行、14 codes 与 OCR 4207 实测；parsing 3 个测试文件 76/76，真实 response 回放 1/1；worker `typecheck` 与 `build` 均为 0 错误；biome 检查 4 个文件 0 问题。
- 仍未验证：真实 embedding/rerank 与企业凭据链路、Office 格式解析、compose `--profile docling` 路径、完整真实知识检索链路、插图导出。
