# 技术栈稳定版本升级

## 目标

按用户 2026-10-28 明确授权，执行技术栈评估中的升级建议，并给出真实验证结果。

## 方案

15 个 npm 直接依赖按已核实版本更新；OpenUI 运行时同步、保留现有 UI 源码与视觉；SDK 更新两个使用方并重建原生 CLI 沙盒。Redis 固定 8.10.3 镜像与 digest；Docling 从 0.8.0 迁至 1.38.2，按官方同步接口修正 nullable 响应、内嵌图片与正文引用。文档按实际代码同步。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/update-tech-stack`
- 分支：`worktree-update-tech-stack`
- 起点：`4979e235d8fad97ecb45d468e05a1e7922a85e63`，等于建树时 `origin/main`。
- 初始 worktree 干净；主 checkout 已有测试报告差异不属本任务。
- 代码、测试、配置由 Sonnet 子代理修改；Opus 独立审查。主会话只做调度、审查、验证及文档记录。
- 不改数据库 schema，不触碰共享开发库数据、用户账号或登录态。集成验证沿用随机测试库与私有 Redis。
- 允许改动 manifest/catalog/lock、compose/CI Redis 引用、Docling 解析与相关测试、技术栈及运维文档。

## 当前有效决定

- 用户已授权按上一轮建议执行升级，并在后续明确要求提交 PR、合并；允许 commit/push/merge，不等待 CI、不自动启动 PR 监控。
- Node 保持 24 LTS，类型包保持 24 系列；不追预发布、不做主框架迁移。
- 宿主 Node 24.22.1 与 Docker Desktop 官方更新已获同一任务授权；保留旧 Node。
- 共享服务在 Docker Desktop 更新后自动恢复，尚未切换为本任务应用/Redis镜像；不自动部署未合入代码。
- 2026-10-28 验证状态：宿主 Node 24.22.1（default）、pnpm 12.15.0 已实测；Docker Desktop 4.97.0 / Engine 29.9.2 / Compose 5.6.1 已实测。backend 在固定 Redis 8.10.3 镜像下跑通 97/97，infra 8/8；web 727/727；静态契约检查 37/37；冻结安装成功（34 条确切版本 release-age 例外，旧过期条目已删）。OpenUI 11 项全 pass、生成物无差异。ErrorItem 及真实响应来源定位缺口已修复；最终解析/适配器 65/65、真实响应回放与 Opus 末轮复核通过。全量 backend 另有 3 项 native-queue 偶发失败，窄诊断尚未定论。

## 已替代项及原因

- 旧 Docling v0.8.0 镜像与 `/v1/convert/file` 调用不一致，切换至官方 v1.38.2，不保留旧 API 兼容。
- 文档中的 JWT/cookie 插件鉴权、未使用 RHF、手写 shadcn 未配置、已安装过载保护、已接入 Bull Board、已配置 coverage-v8 等描述与源码冲突，按 Better Auth/RHF/Base UI/实际依赖修正。
- 文档中的 pnpm/Biome/Vite/TanStack/BullMQ/SDK/MCP/E2E 旧版本与 manifest/lock 冲突，按最终安装版本更新。
- Docling 首次启动下载模型的说明与固定镜像预装模型事实冲突；Redis 预缓存仅 tag 与测试 `--pull=never` 的完整 digest 引用不一致，均已修正。
- 实测图片字段为 `image.mimetype`，删除 `mime_type` 旧字段；官方 ErrorItem 在入口验证 `error_message`，删除旧字符串/`message` 兼容。

## 步骤

- [x] 核对官方版本、发布记录和现有组合约束。
- [x] 建隔离 worktree，记录起点与初始差异。
- [x] 更新 15 个 npm 直接依赖与锁文件。
- [x] 升级宿主 Node 默认版本与 Docker Desktop。
- [x] 构建生产与沙盒镜像，检查实装版本。
- [x] 完成 Docling、Redis 配置与解析迁移：官方 ErrorItem/mimetype/nullable、embedded 图片引用、表格及短 OCR 来源定位、CRLF/同段多项区间均修复；解析/适配器 65/65，Opus 最终窄复核通过，生产镜像包含全部修复。
- [x] 完成真实文档与静态服务验证：PDF 文本/表格/图片、OCR 开关、鉴权、损坏文件与 nullable 已验证；发现的来源定位缺口转入修复与复核，静态服务 37/37。
- [x] 同步文档并完成独立审查：manifest/catalog/lock 通过；Docling/基础设施首轮三项发现均修复，Opus 窄复核明确通过。真实文档验证新发现如有则另列。

## 改动文件

- 依赖：根与 api/core/sandbox/web/worker 的 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`。
- 基础设施：`docker-compose.yml`、`.github/workflows/ci.yml`、`packages/worker/test/global-setup.ts`。
- 解析：`packages/worker/src/knowledge/parsing.ts`、`packages/worker/test/knowledge-parsing.test.ts`、相关 Docling fixtures。
- 文档：`docs/OPENUI-UPGRADE.md`、`docs/PROJECT-BRIEF.md`、`docs/OPERATIONS.md`、`docs/IMPL-CONTRACTS.md`、本任务记录。

- 文档同步（2026-10-28）：`docs/PROJECT-BRIEF.md` §3（语言与工程、前端、后端、智能体与 MCP、沙盒、测试与交付）、§7.3、§9.4、§10.1、§12-2、§15.2、§16.1/16.4 与 `docs/OPERATIONS.md` §2.1/§2.2/§8.1 按实际 manifest、catalog、lockfile 与源码核对更新；删除未使用的 `@fastify/under-pressure`、`@vitest/coverage-v8`、`@fastify/jwt`/`@fastify/cookie` 陈旧条目，鉴权改为 Better Auth；Redis 8.10.3 / Docling 1.38.2 只写当前配置与用法，实际 tag/digest 以 `docker-compose.yml` 为准；Docling 1.38.2 固定镜像已在独立容器中验证真实 PDF 文本、图片、表格及纯图片 OCR 开关，来源定位修复已回放并审查通过；Office 未实测，完整覆盖见本文「验证」。Docker Desktop 与宿主 Node 补丁不写固定快照。

## 下一步

升级和 Docling 迁移已获授权提交 PR 并合并；最新 `origin/main` 已无冲突同步，冻结安装、类型检查、构建和集成回归通过。共享应用与 Redis 尚未切换。已知未解决限制：全量 backend 的 native-queue 偶发 3 项失败，单独 4/4 与相邻模块联合 28/28 通过；窄诊断未形成确定根因，不可将全量标为通过。

## 验证

- `pnpm install --frozen-lockfile`：退出 0。
- `pnpm typecheck && pnpm build`：退出 0；宿主切换 Node 24.22.1 后 `pnpm typecheck` 再次退出 0。
- `pnpm test:web`：首轮 726/727，knowledge-management 编辑来源按钮定位失败；该文件单独 58/58，完整复跑 727/727。
- 定向 backend 12 文件：首轮 native-queue 3 项失败（首项超时后连带断言）；单独 4/4，完整同组复跑 97/97。Node 24.22.1 下 auth/security/native-queue/真实插件 CLI 另跑通过。
- `pnpm lint:focus && pnpm lint:contract`：退出 0。
- `docker build --target sandbox -t agentport/sandbox:tech-stack-20261028 .`：退出 0；镜像实跑 SDK 0.3.311 / CLI 2.1.311 / Node 24.22.1。
- `docker build --target runtime -t agentport/api:tech-stack-20261028 .`：退出 0；实装 Better Auth 1.7.14、BullMQ 6.5.0、SDK 0.3.311、compress 9.3.0、static 10.1.8。
- Docker Desktop 官方 `docker desktop update --quiet`：退出 0；实查 Desktop 4.97.0、Engine/CLI 29.9.2、Compose 5.6.1；现有容器自动恢复。
- nvm 安装 24.22.1 并设 default；新版本 pnpm 12.15.0 可用，旧 Node 保留。
- Redis 8.10.3 固定 digest 镜像已下载，`redis-server --version` 实查 8.10.3。
- Opus manifest/catalog/lock 独立审查：通过；未涵盖尚未完成的 Docling/docs。
- 最终 `pnpm install --frozen-lockfile`：退出 0；`minimumReleaseAgeExclude` 保留 34 条确切版本例外，已删除过期条目。
- backend（固定 Redis 8.10.3 镜像）：97/97；infra：8/8；web：727/727；静态契约检查：37/37。
- `pnpm openui:check`：11 项全 pass，生成物与源码无差异。
- 解析测试：ErrorItem 断言先失败，修复后正常 backend 入口最新运行 62/62 通过；图片引用按 base64 内容归一，允许行间空白且保留最终 Markdown 偏移。worker typecheck、Biome 13 个改动文件及最终生产镜像构建均退出 0。
- Opus 独立复核通过：官方 ErrorItem 入口 schema、图后正文最终偏移及 chunk 图片引用断言、两处 Redis 完整 tag@digest 预拉命令；未发现限定范围的新确定问题。
- 最终正常 backend 入口解析测试 62/62，通过图片错序 mutation 的红绿验证；最终生产镜像构建退出 0，并在镜像内确认官方 error schema 已打包、旧 message 分支已删除。
- 最终 Node 24.22.1 下 web 727/727，OpenUI 解析/库对照 20/20。
- Docling 1.38.2 固定镜像独立容器：真实 PDF 文本/图片/表格、正确 key 200/错误 key 401/损坏文件 failure、md/json 单格式 nullable、纯图片 PDF OCR 开关对照均通过；默认使用已预装 rapidocr/onnxruntime，没有运行时模型下载。临时容器已清理。
- 实测来源定位缺陷已修复并回归：最终解析/适配器 65/65（含 CRLF 原文 `[0,11)`、同段 JSON 项不重叠认领），下游摄取与知识队列 45/45，完整文档链路阶段合跑 108/108；全仓 typecheck、契约检查通过。保存的真实 Docling 响应回放通过：table chunk `pageFrom=2`，pageMap `[280,375)` 覆盖原表格，短文本 `1` 不再侵入 `1234`，图片引用与字节保留。Opus 最终文本偏移窄复核通过，最终生产镜像已包含 locateBlock 与真实结束边界。
- 补跑全量 backend（195 文件/1720 项）：1717 通过、native-queue 3 项失败。观察为首项等待20秒超时，随后断言收到首个 worker 的旧输出；窄诊断未确定根因且未修改代码，已停止扩大排查。最终 native-queue 单独 4/4、插件队列/路由/worker/真实CLI四文件联合 28/28 通过，仍不宣称偶发问题已根除。
- 官方图片字段已修正为 `image.mimetype`，相关 fixtures 同步；`pages` 是对象且当前不消费，不新增平台解析。下游知识摄取回归 `knowledge-ingestion.test.ts` 36/36 通过，知识队列 `knowledge-queue.test.ts` 9/9 通过（真实 BullMQ 重试、游标与关闭取消）。
- 提交 PR 阶段同步最新 main（`6db7a98`，基线后 20 个提交），无冲突；Opus 集成复核通过。Node 24.22.1 下冻结安装、全仓类型检查、生产构建通过；前端 81 文件 794/794，解析/插件路由/worker/队列/真实 CLI 联合回归 6 文件 93/93。未触发 CI、不启动监控。
