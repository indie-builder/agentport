# 恢复智能体 Bash 能力

## 目标

查明智能体 Bash 被禁用的历史原因，解除平台固定禁用，确保父智能体与子智能体实际可调用；同时回答现有沙盒镜像与按智能体定制软件环境的现状。

## 方案

Opus 核对历史、官方权限文档与本地 SDK 类型，确定最小完整权限契约，再由 Sonnet 执行实现与行为测试，Opus 独立审查。保留现有 Docker 隔离，不预装用户举例的软件。用户后续明确增加运行环境配置功能，独立契约与实施记录见 `docs/tasks/runtime-environment-config.md`，替代初始“不实现多镜像管理”的范围。

## 基线与范围

- 主 checkout：`/Users/xbjt/Documents/myself/agentport`。
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/enable-agent-bash`。
- 分支：`worktree-enable-agent-bash`。
- 已 fetch；HEAD 与 origin/main 均为 `d26ea00536a59e5de77bb1d963a9c35e39839e62`。
- 初始工作树干净，无他人差异。
- 范围：与 Bash 可用性直接相关的 runner/官方文件渲染/入口校验/权限钩子及对应测试与现状文档；实际清单待设计核对后补齐。

## 当前有效决定

- 用户所提字体、Python、飞书 CLI 仅为自定义运行环境示例，不授权预装这些软件。
- 用户明确表示智能体 Bash 不应禁用，现在期望解除；据此执行权限调整。
- 用户补充功能目标：新增命名的「运行环境配置」，支持自定义依赖与镜像构建；保留构建版本；一个线上版本指针支持历史回退；智能体绑定环境，不绑定版本号、不自动追最新构建。
- 用户进一步明确：线上版本只在创建容器时选择。已存活容器保持旧版本，不因发布/回退或下一轮对话而替换；新 Session 或旧容器已消亡而重建时使用当时的已发布线上版本，对话记录沿用现有恢复机制。这替代主会话先前“下一轮按新image重建”的设想。
- 用户要求构建尽量复用镜像层与缓存，减少重复构建；准确控制构建上下文，不把整个仓库/原始包放进最终镜像；运行层仅保留程序、库和资源，清除安装归档/下载缓存，编译源码与工具通过多阶段构建隔离，不删除真实运行依赖。
- 先核对最小实现契约，不新增独立部署服务。
- 本轮用户已明确授权 commit/push/PR/merge 到 main；只合并代码，不部署、不迁移共享开发库、不重启服务。
- 不重建正在使用的镜像，不重启用户服务。

## 已替代项及原因

- 旧平台固定禁用 Bash 的决定被用户本次明确要求替代；具体历史依据待核实。

## 步骤

- [x] 并行核查镜像构建和运行配置，实测当前镜像依赖。
- [x] 建立隔离工作树，核对基线；安装依赖并构建 shared/core/sandbox 基线产物。
- [x] 查明禁用依据并确定权限契约：最初为 MCP 能力入口收紧默认权限；没有事故、SDK限制或用户单独禁用要求的证据。
- [x] 网页与主架构文档已对齐默认 Bash 与 Docker 挂载边界，待独立 review。
- [x] 并行修正本次调研发现的既有镜像/生命周期文档偏差（6 份文档，diff --check 通过）。
- [x] 确定命名运行环境、构建版本、线上指针与智能体绑定的最小实现契约，已按后续用户决定实现。
- [x] 实际打开 OpenUI desktop 视觉基准，读取加载后的结构；展开侧栏按钮被 img 拦截，未成功展开，不据此猜交互。产品管理页继续复用既有 Page/ResourcePage 与 DESIGN-SYSTEM §9/§10。
- [x] Sonnet 实现权限与入口契约：core/sandbox 36文件373、API相关5文件104测试通过。
- [x] Opus 独立 review 已发现两项提示词P2，Sonnet修复后4文件49测试通过；待最终定点复核与真实SDK结果。
- [x] 最终真实 Bash 镜像与SDK验收：根Dockerfile构建独占镜像 `agentport/sandbox:runtime-env-bash-20261029`，ID `sha256:7f9493cf245e4a81984e401ea46e865962c003a1d10b8bee8ba96ab04df667a0`；GNU bash 5.3.9、poppler25.12.0、uid1000；移除busybox兼容壳后真实SDK10测试通过，镜像契约7测试通过。未覆盖dev。
- [x] 按范围验证与记录交付：权限/提示词Opus复核已过；真Bash镜像与SDK通过。与运行环境功能同一工作树，本轮提交并合并到 main；未部署共享主栈。

## 改动文件

- `docs/tasks/enable-agent-bash.md`。

## 下一步

Bash 已实现并验证，代码与运行环境配置功能一起从 `worktree-enable-agent-bash` 提交并合并到 main。完整运行环境契约、验证与收尾见 `docs/tasks/runtime-environment-config.md`。本轮只合并代码，未部署。

## 验证

只读镜像检查证实：worker 配置 `SANDBOX_IMAGE=agentport/sandbox:dev`；实际镜像为 Alpine 3.24 / Node 24.22.1 / uid 1000；没有 Python、标准字体文件、常见飞书 CLI。当前 Dockerfile 要求 poppler-utils，但本机 sandbox:dev 缺 pdftoppm/pdfinfo，存在源码与旧镜像产物偏差。

- `pnpm install --frozen-lockfile`：通过。
- `pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/sandbox build`：通过。
- 基线 Vitest 初次启动报 `TypeError: code.charCodeAt is not a function`；诊断发现缺少 `packages/db/dist`，Vite 堆栈重写掩盖了模块解析错误。
- 诊断代理执行 `pnpm --filter @agentport/db build` 后，原基线命令 `pnpm exec vitest run --project backend packages/sandbox/test/runner.test.ts packages/sandbox/test/memory-permissions.test.ts packages/sandbox/test/sub-agent-permissions.test.ts packages/core/test/workspace-input.test.ts`：4 文件 / 89 测试通过。这是改动前基线，不作为新功能通过证据。
- 最终需清理本任务测试生成的 tracked `.vitest/json/output.json` 差异（初始为空差异，归属本任务）。
