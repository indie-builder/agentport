# Plan 004: 生成式 MCP 长期 token 改为加密/哈希存储（方案确认后实施）

> **Executor instructions**: 这是一份**先确认方案、再实施**的计划。必须先完成 Phase 0（确认调用链与部署事实）并守住 Phase 1 的「维护者确认门」；未获确认不得改存储与鉴权路径。遇「STOP 条件」停止报告。完成后更新 `plans/README.md` 状态行。
>
> **Drift check（先跑）**: `git diff --stat 7166f519..HEAD -- packages/api/src/modules/servers/repo.ts packages/api/src/modules/servers/mcp-endpoint.ts`

## Status

- **Priority**: P2
- **Effort**: L（含约 10 个测试文件的改造）
- **Risk**: MED
- **Depends on**: 维护者确认（见 Phase 1 门）
- **Category**: security
- **Planned at**: commit `7166f519`, 2026-11-14

## Why this matters

生成式连接器（generated）的长期访问 token 目前**明文**存于 `servers.config.mcpToken`（jsonb）。它与平台其余安全姿态不一致：env/headers 走 AES-256-GCM 加密，公开分享 token 只存 `sha256` + 加密副本。任何能读库的路径（备份、副本、排障导出、别处 SQL 缺陷）都能拿到可长期使用的 `/mcp/:serverId` bearer，用于外部调用该连接器的工具（带平台存的上游凭据副作用）。

**重要范围澄清（本次已核实）**：沙盒运行**不用**这个长期 token——`packages/worker/src/index.ts:157-158` 对 generated 走 `generatedMcpEntry({ apiUrl, serverId, runId, runToken }, headers)`，用的是**按 run 的短期 token**（`agent_runs.mcpTokenHash` 机制）。因此该长期 token 仅用于：外部 Host 直接连 `/mcp/:serverId`、以及平台自测连接（`test-connection` 走 `getMcpToken`）。受影响的代码集中在 API server 模块 + 直接 `select config->>'mcpToken'` 的测试；**worker/core 不受影响**。

正因为威胁模型是「单机 + DB 绑 loopback + 暂不对外（D-21）」，本项价值取决于外部 Host 是否真的在用这个长期 token。Phase 0/1 必须先确认；若确认不使用，可评估降级为「暂缓」，或仅记录已知边界。

## Current state（调用链已核实）

写入/读取 `config.mcpToken` 的位置：
- `packages/api/src/modules/servers/repo.ts:96-109` `splitInput` 的 generated 分支：`config: { baseUrl, mcpToken: mcpToken ?? randomToken() }`。
- `packages/api/src/modules/servers/repo.ts:284-288` `updateServer` 里把旧 `row.config.mcpToken` 透传给 `splitInput`（PATCH 沿用旧 token）。
- `packages/api/src/modules/servers/repo.ts:368-373` `getMcpToken`：明文读取，供测试连接与平台内部。
- `packages/api/src/modules/servers/repo.ts:375-387` `rotateMcpToken`：生成明文写回 `config.mcpToken`，返回明文一次。
- `packages/api/src/modules/servers/mcp-endpoint.ts:128-151`：`tokenMatches(row.config.mcpToken, token)` 校验 Bearer。
- `packages/api/src/modules/servers/router.ts:112, 217`：`getMcpToken` 的使用点（自测/预览注入）。
- `packages/api/src/modules/agents/package.ts:1025, 1029`：导出生成 server 配置、导入时省略 `mcpToken`。
- 参照范式（加密/哈希 token）：`packages/api/src/modules/output-shares/router.ts:147-154`（`tokenHash: sha256Hex(token)` + `tokenEncrypted: encryptSecrets({token}, APP_SECRET_KEY)`）。
- 明文解密 helper：`packages/core` 的 `encryptSecrets()` / `decryptSecrets()`（`APP_SECRET_KEY` 派生），见 `packages/core/src/secrets.ts`（core 模块规则要求密钥统一走它）。

直接 `select config->>'mcpToken'` 的测试（改造时都要处理，先 `grep -rn "config->>'mcpToken'" packages/api/test`）：
`generated-mcp.test.ts:81,307`、`agent-package-zip.test.ts:677,728`、`failure-paths.test.ts:290`、`generated-cancel-http.test.ts:84`、`channels-approvals.test.ts:372`、`server-concurrency.test.ts:183,209`、`mcp-capacity.test.ts:132`、`openui-tools.test.ts:694`、`url-credentials.test.ts:97,135`、`agents.test.ts:604-617`、`servers.test.ts:111`、`knowledge-agent-package.test.ts:102-137`。这些用例多数是用明文 token 去实际请求 `/mcp/:id`，改造后需经测试 helper 取得 token（见 Phase 3）。

## 方案选项（Phase 1 选一个并记录理由）

- **A. 仅加密落库（推荐，最小）**：把 token 存为 `config.mcpTokenEncrypted = encryptSecrets({ token }, key)`，删除 `config.mcpToken`。`getMcpToken`/`getServerWithSecrets` 解密返回明文；`mcp-endpoint` 校验时解密后 `tokenMatches`（语义不变）。改动面最小，不新增校验格式。
- **B. 哈希校验 + 加密取回（与分享 token 一致）**：`config.mcpTokenHash = sha256Hex(token)` 用于校验，`config.mcpTokenEncrypted` 用于取回。校验 `tokenMatches(hash, sha256Hex(provided))`。更贴合既有分享模式，但代码更多、常量时间比较需注意。

**推荐 A**，除非评审更看重与分享 token 的一致性（B）。二者都不改 DB schema（`config` 是 jsonb），无迁移文件。

## Commands you will need

| 用途 | 命令 | 成功判据 |
|---|---|---|
| 构建共享包（测试前） | `bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build` | exit 0 |
| 类型检查 | `bun run --filter @agentport/api typecheck` | exit 0 |
| 相关测试 | `bun run test -- packages/api/test/generated-mcp.test.ts packages/api/test/servers.test.ts packages/api/test/agent-package-zip.test.ts` | 全绿 |
| 全量后端 | `bun run test` | 全绿、0 skip |
| 规范检查 | `bunx biome check packages/api/src/modules/servers packages/api/src/modules/agents/package.ts` | 0 error |

## Scope

**In scope**（确认方案后）:
- `packages/api/src/modules/servers/repo.ts`
- `packages/api/src/modules/servers/mcp-endpoint.ts`
- `packages/api/src/modules/servers/router.ts`（若取用方式需调整）
- `packages/api/src/modules/agents/package.ts`（导出省略新字段、导入照旧生成新 token）
- 上述 `packages/api/test/*` 中直接读明文 token 的用例（改走 helper）
- 一次性回填脚本（置 `scripts/` 或 `/tmp`，见 Phase 2）

**Out of scope**（明确不动）:
- `packages/worker/**`、`packages/core/**` 的 `.mcp.json` 渲染（已核实走 per-run token，与本 token 无关）。若你在 worker/core 里发现读 `config.mcpToken`，按 STOP 处理。
- DB schema / 迁移（`config` jsonb，无需迁移）。
- per-run token 机制（`agent_runs.mcpTokenHash`）保持不变。

## Git workflow

- 分支：`advisor/004-generated-mcp-token-encryption`
- 提交：`security(api): 生成式 MCP 长期 token 加密落库` + 回填脚本单独提交
- 不要 push/PR（除非被要求）。

## Steps

### Phase 0: 确认调用链与部署事实（只读）

1. `grep -rn "config\.mcpToken\|config->>'mcpToken'\|getMcpToken" packages` 复核所有读写点，确认与上面清单一致。
2. 确认是否存在真实外部 Host 在用长期 token（问维护者；查 `docs/`/部署记录）。记录结论。

**Verify**: 输出一份「调用点清单 + 是否有外部 Host 使用」结论。

### Phase 1: 方案确认门（必须）

向维护者呈递「Phase 0 结论 + A/B 方案对比」，取得明确选择后再继续。**未确认前不得修改存储/鉴权代码。** 若结论是「无外部 Host 使用、暂缓」，则把本计划标记 REJECTED/暂缓并说明，结束。

### Phase 2: 实施选定方案（以 A 为例）

- `repo.ts` `splitInput` generated 分支：生成 token 后写 `config: { baseUrl, mcpTokenEncrypted: encryptSecrets({ token }, key) }`（不再写明文）。PATCH 沿用：从旧行的 `mcpTokenEncrypted` 透传（不再取明文）。
- `repo.ts` `getMcpToken`：读 `config.mcpTokenEncrypted`，`decryptSecrets(...).token` 返回。
- `repo.ts` `rotateMcpToken`：生成新 token，写 `mcpTokenEncrypted`，返回明文一次。
- `repo.ts:284-288`：改透传 `mcpTokenEncrypted`。
- `mcp-endpoint.ts:148`：`tokenMatches(getMcpToken-like decrypt, token)`（A 方案语义与现相同，仅来源改为解密）。
- `package.ts`：导出时确保 `mcpTokenEncrypted`/`mcpToken` 都不进包（现只 strip `mcpToken`）；导入照旧生成新 token。

**Verify**: `bun run --filter @agentport/api typecheck` → exit 0

### Phase 3: 回填 + 测试改造

- 回填：写一次性脚本，遍历 `kind='generated'` 且 `config.mcpToken` 为 string 的行，计算 `mcpTokenEncrypted`、删 `config.mcpToken`（幂等）。脚本用 Bun + `APP_SECRET_KEY`（从 `.env` 读取，不在命令行出现密钥）。运行前对目标库 `pg_dump` 备份。
- 测试改造：把直接 `select config->>'mcpToken'` 的地方改为调用测试 helper（用测试 `APP_SECRET_KEY` 解密 `config.mcpTokenEncrypted` 取明文），或用创建/轮换接口返回的 token。**保留原断言意图**（这些测试要用真 token 打 `/mcp/:id`），不要删断言凑绿。
- 新增回归：创建 generated server 后，DB 的 `config` 里**不存在**明文字段（`config->>'mcpToken' is null` 且 `mcpTokenEncrypted` 非空）；`/mcp/:id` 仍接受该 token；轮换后旧 token 401。

**Verify**: `bun run test -- packages/api/test/generated-mcp.test.ts packages/api/test/servers.test.ts packages/api/test/agent-package-zip.test.ts` → 全绿

### Phase 4: 全量验证

**Verify**: `bun run test` → 全绿、0 skip；`bunx biome check <in-scope>` → 0 error

## Test plan

- 改造约 10 个直接读明文 token 的测试文件（清单见「Current state」），统一改走 decrypt helper；不得删减原请求断言。
- 新增 3 条回归（见 Phase 3）。安全改动按 `AGENTS.md` 必须附测试或实测记录。

## Done criteria

- [ ] Phase 0/1 有结论记录（含维护者选择 A/B 或暂缓）
- [ ] 若实施：`bun run --filter @agentport/api typecheck` exit 0
- [ ] 若实施：`bun run test` 全绿、0 skip
- [ ] `grep -rn "config->>'mcpToken'" packages/api/src` 无命中
- [ ] 新增回归用例通过（DB 无明文、token 仍可用、轮换失效）
- [ ] worker/core 未被改动；`plans/README.md` 已更新

## STOP conditions

- Phase 1 未获维护者明确选择 → 停，不得实施。
- 在 `packages/worker` 或 `packages/core` 发现读 `config.mcpToken`（说明沙盒路径也依赖它，超出本计划范围）→ 停并报告。
- 回填脚本无法确定目标库/密钥来源，或目标库非本次隔离实例 → 停，不用共享/生产库试跑。
- 测试改动需要放宽鉴权或删除断言才能变绿 → 停。

## Maintenance notes

- 若未来开放对外（D-21 翻转）或引入外部 Host，长期 token 的加密存储与轮换策略需重新评估并与按 agent 发 token 方案对齐。
- 评审重点：确认仅改 API 侧、worker/core 未变；确认回填幂等且有备份；确认测试仍用真 token 请求而非删除断言。
- 明确不做：不改 per-run token、不改 schema、不给 worker 加解密依赖。
