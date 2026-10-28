# 会话成果查看、版本与反馈修改

## 目标

完成用户故事 US-6.1：智能体生成文件后，用户能在当前会话中找到、预览、下载；选择某个版本提出修改，生成新版并保留旧版；刷新/重开历史仍可查看。只补智能体执行与产出查看，不扩展云盘、项目空间、分享发布或多端服务。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/agent-output-viewing`
- 分支：`worktree-agent-output-viewing`
- 起点：`cd95b1921b02d5a7ecdf61eed227082f2c22cd41`（首轮 TodoWrite PR #96 的 merge commit），已与 `origin/main` 对齐后建树。
- 初始差异：无。

## 固定契约

- 智能体定义仍只读挂载到 `/workspace`；每轮另把 `conversation-outputs/<conversationId>/drafts/<runId>` 以 rw 挂到 `/mnt/outputs`，主会话用原生 `Read/Write/Edit` 交付文件；不使用 SDK `additionalDirectories`。
- `WORKSPACES_DIR/<slug>/conversation-outputs/<conversationId>/`：`drafts/<runId>/` 为可写草稿，`runs/<runId>/{manifest.json,files/**}` 为发布后不可变完整快照。没有新增成果表或服务。
- 用户消息可携带 `output: { runId, path }`。草稿始终以最新完整快照为基线，仅把所选历史文件覆盖到草稿；`.base` 记录最新基线。
- 容器停稳且消息保存成功后才发布；重试、容器清理失败或消息未保存时保留草稿、不发布。跨重试的 `drafts/<runId>.blocked` 标记在确认停稳后清除。
- `outputs` API：按版本列出 changed 文件、返回完整 UTF-8 正文（≤1MiB）、原件下载；只接受 manifest 成员，HTML/SVG 仅源码，不执行；HTML/SVG/二进制不伪造预览。
- Fork 只复制历史边界内、两个消息锚点都能映射的快照，并重写锚点；删除会话/专家回收成果，run 保留期清理不删除会话成果。

## 实现文件

- `packages/shared/src/outputs.ts`、`packages/shared/src/chat.ts`：类型与 `output` 引用。
- `packages/core/src/outputs.ts`：快照存储、路径边界、草稿/发布/读取/复制/删除、blocked 标记。
- `packages/core/src/workspace.ts`：交付目录提示。
- `packages/sandbox/src/{memory-permissions,runner}.ts`：`/mnt/outputs` 读写许可与原生工具边界。
- `packages/worker/src/{outputs,index,runner-client}.ts`：草稿准备、挂载、发布门禁、消息边界与清理失败传播。
- `packages/api/src/features/{chat/outputs,chat/routes,chat/cancel-run,agents/routes,servers/mcp-endpoint}.ts`、`packages/api/src/queue/producer.ts`、`packages/db/src/repo/chat.ts`：成果 API、反馈引用、分支/删除、取消语义。
- `packages/web/src/components/conversation-outputs.tsx`、`pages/chat.tsx`、`lib/*`：成果面板、版本/预览/下载、反馈挂引用、URL 恢复、窄屏 Sheet 焦点。
- `packages/db/src/test/integrity.test.ts` 与各域行为测试。
- 文档：`docs/ARCHITECTURE.md`、`OPERATIONS.md`、`DECISIONS-PENDING.md`（D-67）、`USER-STORIES.md`、`DESIGN-SYSTEM.md`、`REMAINING-TODOS.md`、`CHANGELOG.md`。

## 评审历史与修复

- A 存储：首轮发现中间目录软链接越界、旧版整份复制回退、空草稿复活旧文件；修复为逐层物理路径校验、最新快照基线仅覆盖所选文件、空基线发布空快照，独立复核通过。
- B 运行：首轮发现跨重试清理失败标记丢失、消息保存被外部终态拒绝仍发布、权限测试参数失真；修复为持久 blocked 标记、`persisted.written` 门禁、直接路径测试，独立复核通过。
- C API：独立评审除 RFC 5987 `filename*` 未编码 `()*` 外通过；已修复并补测试，API 成果路由 9/9。
- D Web：独立评审先后发现发送等待期间切版本被旧回调覆盖、OpenUI 动作误清引用、窄屏 Sheet 焦点被困、旧响应清除新引用；均已修复并补页面行为测试，独立复核通过。

## 验证

- `pnpm exec vitest run --project backend --no-file-parallelism`：200 文件、1824/1824 通过，exit 0。并行全量曾有一次 `knowledge-wiki` 20s 超时，单独 8/8 通过，判为负载抖动。
- `pnpm exec vitest run --config packages/web/vitest.config.ts --no-file-parallelism`：89 文件、905/905 通过。并行全量曾有一次会话切换时序失败，单文件及串行均通过。
- core/worker/sandbox 相关：27 文件、318/318。
- API 成果路由：9/9；`pnpm typecheck`、`pnpm build` 通过；`lint:focus`、`lint:contract` 通过；本轮 44 个源码/测试文件 Biome 通过。全仓 Biome 仍有知识包既存错误与警告，非本轮范围。
- 真实隔离验收（独立随机 PG 库、Redis 容器、端口、workspace 与管理员，未使用共享服务）：
  - 两轮 **12/12**：真实模型原生 `Write` 生成第一版；列表/content/download 的 size/sha 一致；选择版本后原生 `Read/Edit` 生成新版，旧版下载字节不变。成本约 0.0467 USD。
  - 分支 **8/8**：复制版本可读，删除源会话后分支仍可下载，分支续改产生新版且旧版不变。
  - 停止 **2/2**：run 终态 cancelled 后 `partial.md` 可列出/预览/下载（45 bytes）。
  - 浏览器：分支成果面板显示 `report.md` 210B，下载字节 sha `a22ab4fa68966dc8cb7580fe4204defd43314cf1f2905a169611cbe1644b7ae1` 与证据一致；“基于此版本修改”出现引用 chip，焦点回到消息输入框；单 h1、无横向溢出。
  - cleanup exit 0：隔离进程、库、Redis、workspace 已处理；共享 4 容器未动。专用镜像 `agentport/sandbox:outputs-20261028` 保留供复用。

## 未覆盖与边界

- Office/PDF 不在浏览器预览；二进制只下载。当前模型没有删除工具，多文件中的单文件删除不支持。
- 成果正文是交付内容，不做聊天的密钥脱敏。
- 真实知识库/MCP 检索、真实读屏与原生缩放、成果正确性自动验收未覆盖；本次验收的模型输入由脚本固定提供。
- 一次并行测试时序抖动已记录；单/串行通过，不把它当成产品回归，也不把测试绿当成成果质量通过。

## 下一步

提交、创建 PR 并合并；合并后清理本 worktree。后续故事继续按 `docs/REMAINING-TODOS.md` 核对澄清提问、记忆与运行中干预。
