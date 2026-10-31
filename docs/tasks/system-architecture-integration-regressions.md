# API 删除/记忆路由套件全仓失败（测试隔离回归）

- 基线：`68241ba`
- 范围：仅测试侧 `packages/api/test/agents-access.test.ts`、`output-shares.test.ts`、`memory-routes.test.ts`、`outputs-routes.test.ts`；生产 `src` 未改动（锁合同、会话关闭信道、记忆校验均保持原样）。
- 证据 JSON：`/tmp/agentport-architecture-integration-api-{agents-access,output-shares,memory-routes}-{red,green}.json`、`...-concurrent-green.json`、`...-final-green.json`；`/tmp/agentport-architecture-output-timeout-{single-before,repro-before,single-after,parallel-after,parallel-full-after}.json`。

## 1. agents-access：owner delete 期望 204 实得 503

**现象**：全仓 `vitest run` 中 `deletes only when the owner holds the delete leaf` 返回 503；单独跑该套件 11/11 通过。

**定位**：

- 与 `delete-lifecycle.test.ts` 同轮复现（同一共享测试库），失败不变；日志为 `无法取得数据库锁，操作未执行: canceling statement due to statement timeout`。
- `withAdvisoryLock` 在取锁前把 `statement_timeout` / `lock_timeout` 设为 5s；`delete-lifecycle` 的「worker 迟迟不 ACK」用例会持有 `AGENT_BINDINGS_LOCK_KEY` 约 10s。全仓并行时其它套件的删除在共享库上等锁超过 5s，被统一映射为可重试 503。
- 这是测试间共享库的锁争用，不是生产删除逻辑或锁合同回归。

**修复**：套件模块加载时 `createIsolatedDatabase('agents_access')` 独享随机库，显式用返回的 `url` 启动 app；`afterAll` 关闭连接后只删本套件创建的库。未放宽断言、未改 503→204、未改生产锁超时。

## 2. output-shares：删除会话期望 204 实得 503

**现象**：`treats bad tokens, sibling files and deleted conversations as plain 404s` 返回 503；日志为 `等待会话容器关闭确认超时，删除未执行`。

**定位**：该套件此前未接关闭信道应答者，删除事务发出的关闭请求无人 ACK，10s 后按设计返回 503。

**修复**：

- 接入 `startSessionCleanupResponder`（与生产同一个 worker 信道 handler）+ `FakeSessionCloser`，真实经过 Redis 请求/ACK，不 mock 路由回调；
- 同时使用 `createIsolatedDatabase('output_shares')` 独享库，避免与同轮删除套件的绑定锁长等待互相超时；
- 未修改 `expected 204`、未绕过关闭确认。

## 3. memory-routes：超限期望 413、符号链接 PUT/DELETE 期望 400 实得 500

**现象**：`returns 413 for oversized UTF-8 memory content` 与两条 `returns 400 for links without leaking their private path` 返回 500；GET 用例通过。

**定位**：记忆 PUT/DELETE 现在通过 `withMemoryTargetLock` → `withAdvisoryLock`。真实 helper 需要 `client.on/removeListener`、`query` 读取/设置 `statement_timeout`、`lock_timeout` 并 `pg_advisory_lock/unlock`；测试的 fake pool 只提供 `query` + `release`，在进入记忆校验前抛出 `.on is not a function`，被统一包装成 500。

**修复**：仅补 fake pool 的会话形状（`on`/`removeListener`/`release`、`current_setting`、`set_config`、`pg_advisory_lock`、返回 `unlocked: true` 的 `pg_advisory_unlock`）。超限与符号链接校验仍走生产路径，未放宽安全限制、未吞错。

## 4. outputs-routes：选择成果的消息用例 20s 超时

**现象**：all3 中 `persists the selected output on the user message without changing OpenUI fields` 耗时 20004ms 后超时；单独跑该套件通过。

**定位**：

- 单跑该用例 49.8ms；同轮与 `delete-lifecycle.test.ts` 并行时，目标用例耗时 19987ms（20s 上限内险些失败），聊天准入两次 POST 被 `AGENT_BINDINGS_LOCK_KEY` 挡住。
- `delete-lifecycle` 在共享 `globalSetup` 库中，「无 worker 应答」与「worker 不 ACK」两条用例各持 session 绑定锁约 10s；`outputs-routes` 的两条聊天准入在共享库等同一把锁，合计约 20s。与 §1/§2 同根，不是生产锁或聊天逻辑回归。
- 共享 Redis 不参与该阻塞：删除套件使用独享 Redis，锁冲突只发生在共享 PG 库。

**修复**：套件模块加载时 `createIsolatedDatabase('outputs_routes')` 独享随机库，`startApp({ DATABASE_URL: isolated.url })` 显式使用；`afterAll` 先 `app.close()` 再删除本套件创建的库。保留真实 Redis responder 与全部断言，未提升超时、未加固定 sleep、未跳过用例、未改 `process.env` 回落共享库。

## 验证

| 阶段 | 命令 | 结果 |
| --- | --- | --- |
| 修复前单跑 agents-access | `vitest run --project backend packages/api/test/agents-access.test.ts` | 11/11 passed |
| 修复前单跑 output-shares | 同上，`output-shares.test.ts` | 7/8，删除会话 503 |
| 修复前单跑 memory-routes | 同上，`memory-routes.test.ts` | 5/8，三条 500 |
| 修复前并发复现 | agents-access + delete-lifecycle 同轮 | agents-access 删除 503（取锁超时） |
| 修复后单跑 | 三个套件各自单独跑 | agents-access 11/11、output-shares 8/8、memory-routes 8/8 |
| 修复后并发 | 三个套件 + delete-lifecycle 同轮 | 40/40 passed |
| 修复前 outputs-routes 单跑 | `vitest run --project backend packages/api/test/outputs-routes.test.ts` | 12/12 passed，目标用例 49.8ms |
| 修复前同轮复现 | outputs-routes + delete-lifecycle（仅两条 10s ACK 用例） | 14 passed/12 skipped，目标用例 19987ms |
| 修复后 outputs-routes 单跑 | 同上 | 12/12 passed，目标用例 46.6ms |
| 修复后同轮复现 | 同「修复前同轮复现」选择 | 14 passed/12 skipped，目标用例 49.3ms |
| 修复后完整并行 | outputs-routes + delete-lifecycle 全量、`--maxWorkers=2` | 26/26 passed，目标用例 49.3ms |
| 静态检查 | `pnpm --filter @agentport/api typecheck`；`pnpm exec -- biome check packages/api/test/outputs-routes.test.ts` | 通过 |

## 未覆盖

全仓其余失败套件（subagent-export、reconcile-queue、run-pending-finish 的 error-only 结果、session-sandbox-sdk 等）不在本任务范围，未处理。
