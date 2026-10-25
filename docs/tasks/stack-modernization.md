# 技术栈维护与原生能力整合

## 目标

落实 2026-10-25 技术栈调研建议，简化已有功能并补齐实际可用性。用户已授权实施，明确排除 Testcontainers；无需旧接口、旧格式或历史数据兼容，也不迁移旧数据。不清空或覆盖正在使用的数据库与文件卷。

## 方案

- 在独立 worktree 工作，主 checkout 保持干净。
- Opus 确定运行/文件跨模块契约；Sonnet 按互斥文件域并行执行，Opus 独立评审。
- 更新稳定版直接依赖和 Node 24 补丁，pnpm Catalogs 集中共享版本；同步 SDK 独立镜像清单/锁与 CI。
- RHF 表单唯一数据源；Query 原生取消；删除 localStorage 会话兼容索引。
- CodeMirror 6 按需加载，统一 Markdown/JSON 源文本编辑。
- SDK 原生持久化 resume/fork，官方子级 MCP 与授权、前台/深度约束。
- Redis XREAD BLOCK 取代事件 pub/sub 唤醒；保留回放限制、背压和数据库终态对账。
- stdio 试连在相同 Docker 沙盒完成，不调用模型。
- 官方工作区目录 ZIP 导入/导出取代私有 agent@1/@2 定义包；平台元数据放独立 sidecar，不复制正文。
- 完整备份/恢复覆盖数据库、持久记忆、SDK transcript 和必要配置；支持 restic 异机加密备份。
- 删除无业务使用的 Effect 占位服务抽象。

## 步骤

- [x] 用户确认实施边界；创建 stack-modernization worktree。
- [x] 固定跨模块契约。
- [x] 稳定版依赖维护与 Catalogs。
- [x] 前端请求/缓存简化（表单单一数据源、概览兜底删除、Query 取消）。
- [x] CodeMirror 组件与全部接入点（记忆/规则/输出风格/技能正文/支持文件/工具 inputSchema）。
- [x] SDK resume/fork、子智能体 MCP 与原生约束。
- [x] Redis 原生阻塞跟随与 Effect 清理。
- [x] 沙盒 stdio 测试。
- [x] 官方目录包导入导出（含前端 ZIP 切换）。
- [x] 完整备份/恢复及 restic。
- [x] Opus 独立评审与修复（概览、事件流、备份评审完成）。
- [ ] 已改断言的 E2E 未执行（需真实浏览器 + 运行中的全栈）。

## 共享契约

- SDK 会话宿主路径：`WORKSPACES_DIR/<agent.slug>/sdk-sessions/<conversationId>/`，容器挂载到 `/home/node/.claude`，每个 conversation 独立。备份包含该目录与 agent-memory；不是可分享定义包的一部分。
- 新会话全新启动；续聊走 `resume`；分支用官方 `forkSession` 并复制来源 transcript。transcript 缺失时明确失败，不回退文本拼接。
- `shared/chat.ts` 的 `sandboxTaskSchema` 是唯一沙盒任务契约；probe 契约在 `shared/sandbox-probe.ts`。
- probe 队列 `sandbox-probes`；worker 启动时 `registerSandboxProbe(config)`，关停时 `close()`；容器入口 `dist/probe.js`，无模型凭证。
- ZIP：`GET /api/export/agents/:id` 返回 `application/zip`，`POST /api/import/agents` 接收同格式；官方文件是正文唯一来源，根 `agentport.json` 只存平台元数据。
- 备份：`backups/<ts>.tar.gz` 含 `database.dump`/`env`/`workspaces/`/`manifest.json`；恢复目标只来自调用环境。

## 改动文件

108 个已跟踪文件修改 + 30 个新增文件，覆盖依赖清单/锁、CI/Docker、前端页面与组件、后端路由与队列、沙盒 runner/probe、DB schema 与迁移 0032、脚本与文档。

## 下一步

- 已改断言的 E2E 需要真实环境执行：`agent-package-bytes`（ZIP 往返）、`smoke`（CodeMirror 键盘输入路径）、`chat-replay`。
- 待用户决定：Testcontainers 单独讨论；浏览器工具版本更新未执行。

## 验证

### 环境

- 隔离基础设施（普通 Docker，不引入 Testcontainers）：一次性 `stack-verify-pg` / `stack-verify-redis`，库 `stack_modernization_test`；端口由 Docker 随机分配，每次验证通过 `docker port` 取得后显式传入 `DATABASE_URL` / `REDIS_URL`。验证结束即删除容器与临时目录。
- 所有 DB/Redis 验证显式指向上述地址；验收结束已停止进程并清理 `.tmp`。
- 未触碰开发 compose 的 postgres/redis/worker 数据。

### 自动化

- `pnpm install --frozen-lockfile`、7 包 `tsc -b`、`pnpm -r build`：全部通过。
- api 镜像四阶段构建、sandbox 镜像构建（容器内核对 SDK 0.3.310 / MCP 2.4.0 / fflate 0.8.3 / effect 4.0.6 / bullmq 6.4.2）、`npm ci --dry-run`：通过。
- 全量后端：**147 files / 1136 tests passed（0 skipped）**（评审修复后复跑）。
- Web 全量：**35 files / 324 tests passed**。
- `biome check .`：0 error、7 个既有 `noNonNullAssertion` warning。
- 专项：事件流 5 files/34、概览 2 files/6、探测 19、目录包 98、备份脚本 13、upstream 3、效果运行时 9。

### 真实验收

- **续聊**：两轮共用 SDK session，写同一 transcript（58 行含两轮用户消息），输入 token 10464→10968。
- **分支**：从指定用户消息 fork 出新 session，新 transcript 42 行且不含分支点之后的回答。
- **stdio 试连**：经真实路由由 worker 沙盒执行，返回可读失败且无残留容器。
- **浏览器**：记忆/规则/输出风格/技能正文/工具 JSON schema 五类编辑器在真实页面输入并保存，接口回读一致。
- **备份恢复**：1.19MB 包（排除 `run_*`）；旁路恢复后数据库 52 agents / 4 conversations / 4 runs、transcript 行数一致、记忆 600、目录 700、迁移补齐；恢复脚本正确拒绝在应用运行时继续。

### 评审后修复（会话与子级工具）

- **分支 uuid 映射**：不再按两侧位置对齐（压缩会话会整段错位），也不再把映射塞进事件（2000 条上限会静默丢）。改为 worker 从宿主 transcript 的 `forkedFrom.messageUuid` 计算，与消息同事务写库；删除 `forkMessageUuids` 字段与 `session_forked.uuids`。新增 `packages/worker/src/fork-uuids.ts` 与 4 项专项测试（乱序、只映射页面已有、忽略无来源/非法行、文件缺失）。
- **子智能体工具被连带移除**：父会话不再写 server 级 `disallowedTools: mcp__<child>`（子级继承会话权限，会被一起移除）。父级误调用由 PreToolUse 边界 hook 拒绝；测试改为断言“不自动批准、也不 session deny”。

- **删除专家留下孤儿 transcript**：删除时先取 slug，再清理 `<slug>/sdk-sessions/`（数据库仍先删，清理失败只记日志）。`agent-memory/` 按原约定保留为持久资产（同名 slug 手动创建会 409，不会串号）。
- **旧会话分支提示误导**：区分“从未有 SDK 记录”与“本轮未收尾”，直接说明无法分支。
- **授权边界补测试**：新增 `packages/api/test/run-server-scope.test.ts`，覆盖父绑定通过、启用直接子级通过、禁用子级/孙级/兄弟拒绝。

- **MCP 未连上的提示被丢弃**：runner 的 `error` 事件发的是 `msg`，契约要求 `message`，worker 校验失败后只打日志。已改用 `message`，UI 现在能看到真实原因。
- **备份纳入探试连挂载点**：`sandbox-probes/` 只是空挂载目录，已从工作区打包排除，并在备份测试中断言不进包。

### 已核实不成立、未改动的评审项

- “stdio 试连缺 PATH 必然失败”：MCP client 的 `StdioClientTransport` 会先合并默认环境（含容器 `PATH`）再用任务 env 覆盖；此前真实容器里 `node` 命令已成功返回工具目录，故不改。
- “running 且 startedAt 为空的 run 被概览漏掉”：SQL 中 `NULL OR TRUE` 结果为 TRUE，该行仍被选中，`running` 计数不受影响。

### 备份恢复评审后修复

- **swap 失败会删除线上工作区**：回滚分支把线上目录 `mv` 进已有同名内容的 staging，随后 `rm -rf staging` 连带删除。已改为只把 `holding` 里的旧内容放回，绝不移动线上目录。
- **容器客户端模式恢复必失败**：`pg_restore` 传的是宿主临时路径，`compose exec` 看不到。改为从 stdin 读归档（宿主机与容器两种模式都支持），并新增只读 TOC 预检。
- **工作区无内容校验**：manifest 增加 `workspaces.sha256`（路径+内容有序拼接），`verify_tree` 比对；`BACKUP_VERSION` 升到 2。
- **`run_*` 排除跨 tar 不一致**：GNU/bsdtar 的 `./*/run_*` 会误排除 `agent-memory/run_notes.md`。改为打包后按顶层目录精确裁剪（`prune_workspaces`）。
- **restic 保留策略空操作**：默认按 host+paths 分组，每次路径不同导致 keep-last 失效；加 `--group-by host`。
- **工作区为空仍发布**：0 个文件时直接失败（可用 `BACKUP_ALLOW_EMPTY_WORKSPACES=1` 越过），并打印定位到的模式与路径。
- **新机器恢复被 `.env` 卡死**：显式提供 `DATABASE_URL` 时不再要求 env 文件；安全副本的 env 缺失时写空文件。
- **测试可移植性**：越界成员构造加 `tar -P`（GNU tar 否则会把 `../` 改写掉）。
- 另修两处 shell 脚本错误：`/** */` JS 风格注释被 bash 当通配符执行；`workspaces_sha256` 用 `trap RETURN` 会覆盖调用方的 EXIT trap。

### 验收中发现并修复

- Biome 2.6.3 `noComponentHookFactories` 命中既有测试探针 → 仅对测试目录关闭；schema 升到 2.6.3。
- 概览真实库回归测试被专用环境变量变成 skip → 改为从 DATABASE_URL 建随机临时库。
- 慢客户端被 MAXLEN 裁剪时静默丢事件 → 明确记录为已知限制；跟读终止错误现在向 SSE 发 error。
- worker 宿主直跑时模型代理错误改写 loopback 上游 → 仅在容器内改写，新增 3 项测试与 PITFALLS 记录。
