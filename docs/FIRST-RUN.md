# 首次部署实测记录（2026-10-20）

从零（无 `.env`、无数据卷、无 api/sandbox 镜像）执行 `pnpm run up`，在 macOS + Docker Desktop 上做的一次完整演练。

## 结论

- 本次演练（2026-10-20）中 `pnpm run up` 在空库下于冒烟阶段失败、且工作区卷属主需要手工修复；**这两项此后均已修复**（见各条目的「已修复」），当前版本不应再复现——修复后未重新做整轮空库演练，本记录保留原始实测数据。
- 补齐模型凭据后，核心链路（server → tool → test → agent → chat → run trace → overview → audit → `/status`）全部打通。
- 冷启动（含镜像构建，镜像层已缓存）约 **23 秒**即到达冒烟阶段；从执行 `pnpm up` 到第一条对话成功（含两次失败 run 与手工修复）约 **2 分 45 秒**。镜像层完全未缓存时，镜像构建需额外数分钟。

## 实测耗时

| 阶段 | 实测 |
| --- | --- |
| `.env` 生成 + postgres/redis healthy | 约 4 秒 |
| 沙盒镜像构建 | 约 1 秒（层全缓存；冷缓存时约 1 分钟） |
| api/worker 镜像构建 + migrate + 启动 | 约 15 秒 |
| 等待 `/health/ready` | 约 1 秒 |
| 冒烟 | 首次失败；第二次 `pnpm smoke` 约 0.3 秒 |
| 端到端对话（含工具调用） | 4.5 秒 |

## 遇到的坑

### 1. 空库时 `pnpm run up` 的冒烟失败（已修复）

`scripts/smoke.sh` 在设置了 `PLATFORM_MCP_TOKEN` 时直接调用 `/mcp` 的 `tools/list`。
空库里没有已启用的智能体，平台 MCP server 不注册任何工具，SDK 不宣告 tools capability，
因此未 `initialize` 的 `tools/list` 返回 `-32601 Method not found`，冒烟判失败，`pnpm run up` 以非零退出。

**绕过**（历史记录，现已不需要）：先在页面上创建一个智能体，或临时清空 `.env` 的 `PLATFORM_MCP_TOKEN` 再跑一次 `pnpm smoke`。
**已修复**（`scripts/smoke.sh:66-74`）：smoke 现在先发 `initialize` 再发 `tools/list`；空库时 `tools` 为空数组也算通过。无需再绕过。

### 2. 全新 `workspaces` 命名卷属主是 root，worker 以 node 写入失败（已修复）

`docker compose down -v` 后重建的命名卷挂载点是 `root:root`，而 worker 容器以 `node` 运行，
首次运行直接报 `EACCES: permission denied, mkdir '/workspaces/<agent-slug>'`，run 立即 `failed`。
已有卷（旧部署）不会出现，所以这个问题只在真正的首次部署暴露。

**绕过**（历史记录，无需再手动执行；`up.sh` 已自动完成）：

```sh
docker run --rm -v agentport_workspaces:/w alpine chown -R 1000:1000 /w
```

**已修复**（`scripts/up.sh:78-82`）：`pnpm run up` 在启动 worker 前自动把工作区卷 chown 到 1000，首次部署无需手工处理。

### 3. 生成的 `.env` 不含模型凭据（已修复提示）

`pnpm run up` 只生成密钥，不生成 `ANTHROPIC_*`；不填时对话 run 会以模型错误失败。
**已修复**（`scripts/up.sh:137-140`）：`up.sh` 结束时检测到两个凭证都缺失会明确打印「平台本身可用，但发起对话会失败」。

### 4. E2E chat 用例选择器冲突（已修；Playwright 版本已退役）

`e2e/smoke.spec.ts` 用 `getByLabel('消息')`，同时匹配输入框和「发送消息」按钮，`E2E_FULL=1` 时必然 strict mode 失败。
已改为 `getByRole('textbox', { name: '消息', exact: true })`。

### 5. 小问题

- `pnpm run up` 的 compose 输出较啰嗦，失败时关键信息（`UP FAIL`）埋在构建日志后。
- `pnpm down --clean` 不会删除 `agentport/api:dev`、`agentport/sandbox:dev` 镜像，冷启动复测需手动 `docker rmi`。
- （已修复）空库首次 `tools/list` 的行为与 smoke 假设不一致，曾容易误判为 MCP 端点故障。

## 给下一位用户的建议

1. 先 `pnpm backup`（有数据时），再 `pnpm down --clean`。
2. 执行 `pnpm run up` 前准备好 `.env`（至少模型凭据），其余由脚本完成。
3. （历史）`UP FAIL: 冒烟测试失败` + `Method not found` 属于已修复的问题 1；现在空库冒烟应直接通过。
4. 首次对话前可确认工作区卷属主：`docker run --rm -v agentport_workspaces:/w alpine ls -ld /w`，`up.sh` 已自动 chown 到 1000。
5. 需要完整验证时运行 `pnpm test:e2e`（真实对话链路需要模型凭据），并保证 api+web 在跑（`pnpm dev` 或生产容器 + 5173）。
