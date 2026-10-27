# 复用现有依赖替换复杂手写逻辑

## 目标

找出仓库里现有、复杂且手写的逻辑，评估能否用已装依赖或平台原生能力、其次用成熟轻量库替换，减少自维护代码。验收标准：每项替换有明确的现状问题、收益与代价证据；收益不明确的一律不改。

边界：不新增独立服务、云账户、产品功能或兼容层；网段、错误码、错误文案与函数接口策略不变，原生解析会纠正部分特殊 DNS 表示的判断（见「解析差异」）；不做无收益的重写。

## 方案

### 本轮候选：SSRF 私网判断改用 Node 原生 `net.BlockList`

- **现状问题**：`packages/api/src/features/servers/ssrf.ts` 手写 IPv6 展开、内嵌 IPv4 提取和逐段位运算（约 55 行），要同时覆盖 IPv4-mapped、NAT64、ULA、link-local、loopback 多种写法，逻辑脆弱且与平台能力重复。
- **可用能力**：Node ≥24 原生 `net.BlockList.addSubnet()` / `check()`（官方文档 https://nodejs.org/docs/latest-v24.x/api/net.html#class-netblocklist ，核查日 2026-10-27）。实测 `check('::ffff:127.0.0.1', 'ipv6')` 会跨族匹配已登记的 IPv4 网段，无需另登记 `::ffff:0:0/96`；`addSubnet('64:ff9b::10.0.0.0', 104, 'ipv6')` 可用。项目 Node `>=24`，本机 v24.22.0，`@types/node` 24.19.2，无新增依赖/服务/账户。
- **做法**：保留现有 IPv4 网段清单，改为单个 `BlockList`：每个 IPv4 网段同时登记 native `ipv4` 与 `64:ff9b::<network>` 的 IPv6 子网（前缀 96 + IPv4 前缀，依据 RFC 6052 §2.2 的 /96 NAT64 映射）；另登记 `::/128`、`::1/128`、`fc00::/7`、`fe80::/10`。删除手写 `isPrivateIpv4` / `ipv6Bytes` / `embeddedIpv4` / `isPrivateIpv6`；`isPrivateAddress` 按 `isIP` 结果调用 `check`，非法地址仍返回 true。
- **不变量**：`assertSafeUrl` 接口、错误码与文案、开发环境 localhost 例外、DNS 全量地址检查均不变；不扩大禁用网段，不复制 worker 侧策略。
- **收益/代价**：删除约 55 行手写解析，行为交给平台原生实现并有官方依据；网段、错误码/文案与接口策略不变，原生解析会纠正部分特殊 DNS 表示的判断（见「解析差异」），不为此加兼容层。代价是依赖 Node 原生 BlockList 语义，已用表征测试覆盖。

## 解析差异

Opus 独立 review 用 40 万地址差分与边界核对确认：网段、错误码、错误文案、`assertSafeUrl` 接口、开发环境 localhost 例外、DNS 全量检查均不变；差异只出现在 DNS 返回字符串的解析判定上，原生 `net.isIP`/`net.BlockList` 纠正了旧手写解析的缺陷。

- DNS 返回 `0:0:0:0:0:ffff:8.8.8.8` 或 `64:ff9b::8.8.8.8`：旧手写解析拒绝，新原生解析放行；两者都是公共地址，对应私网写法 `0:0:0:0:0:ffff:127.0.0.1`、`64:ff9b::127.0.0.1` 新旧都拒绝。
- DNS 返回 `::ffff:127.0.0.1%en0`：旧实现放行，新实现拒绝；带 zone 的链接本地/映射写法不再被当作公网。
- 普通 URL 的 host 先由 `new URL` 规范化；带 zone 的 IPv6 URL 在 `new URL` 阶段直接拒绝，不进入地址判断。
- 上述差异不做兼容层，由 `packages/api/test/ssrf.test.ts` 的表驱动用例固化当前行为。

### 已评估但不做的候选

- Base UI `unstable` media query：不稳定 API，本轮不优先。
- ZIP 整体换 fflate：现有实现已按安全边界做中央目录/输出长度校验，整体替换会丢边界。
- parse5 / Markdown 解析替换：收益或语义成本不抵本轮。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/sdk-reuse-pass`
- 分支：`refactor/sdk-reuse-pass`
- 起始 commit：`d9fc9773396b78e9a91c6815111dd9a1e16c5b6f`
- 初始 `git status`：空
- 主 checkout 的 `.vitest/json/output.json` 是用户已有差异，不触碰；并行进行的 `backend-test-isolation` 任务测试基建不碰。改动只落在本 worktree。

## 当前有效决定

- 用户授权本轮完成：实现 + Opus 独立评审 + 本地按范围验证 + 提交 PR 合并 + 清理已合并且干净的 worktree + 更新 main；不触发、不等待 CI。
- 替换顺序：现有项目能力 → 已装依赖/平台原生 → 成熟轻量库；自研不作为选项，收益不明确则不改。
- 本轮唯一实现候选：SSRF 私网判断改用 Node 原生 `net.BlockList`（方案见下）。
- 文件边界：实现 agent 只改 `packages/api/src/features/servers/ssrf.ts` 与本记录；`packages/api/test/ssrf.test.ts` 由测试 agent 补边界，`docs/SECURITY.md` 由文档 agent 同步；实现 agent 不改这两处。

## 已替代项及原因

- 原「本轮仅记录文档，不写代码」为候选未定时的临时项，候选已确定并经 Opus 确认，由用户授权进入实现，故删除。
- 其余候选（Base UI unstable media query、ZIP 换 fflate、parse5/Markdown）本轮不做，原因见「方案 · 已评估但不做的候选」。

## 步骤

- [x] Opus 调研并确定候选（附现状、可用能力、收益与代价证据）
- [x] 把候选与方案补入本记录
- [x] 派发实现（子代理，限定文件边界）
- [x] Opus 独立 review
- [x] 按改动范围本地验证
- [ ] 提交 PR、合并、清理 worktree、更新 main

## 改动文件

- `packages/api/src/features/servers/ssrf.ts`（实现 agent）
- `packages/api/test/ssrf.test.ts`（测试 agent 补边界，实现 agent 不改）
- `docs/SECURITY.md`（文档 agent 同步，实现 agent 不改）
- `docs/tasks/sdk-reuse-pass.md`（本记录）

## 下一步

实现、定向验证与 Opus review（含增量复核）已完成，无阻断项；交付待提交 PR、合并、清理 worktree，尚未合并。`docs/SECURITY.md` 的 FakeIP 描述冲突已由文档 agent 修正，生产策略未变。

## 验证

环境：本机 Node v24.22.0，`@types/node` 24.19.2。

- 重构前基线（含测试 agent 已补的边界用例）：
  `pnpm exec vitest run packages/api/test/ssrf.test.ts` → 1 file / 71 tests passed。
- 重构后同命令（补 DNS 解析差异 5 条表驱动用例后）→ 1 file / **76 tests passed**（IPv4 各网段首尾与邻接、IPv6 ULA/link-local 边界、mapped 与 NAT64 内嵌、DNS 全量检查与特殊表示、开发环境例外、URL 校验全部覆盖）。
- `rtk bypass pnpm exec vitest run --project backend packages/api/test/ssrf.test.ts packages/api/test/generated-cancel.test.ts packages/api/test/generated-cancel-http.test.ts --reporter=default` → **3 files / 84 tests passed**（ssrf 76 + generated-cancel 7 + generated-cancel-http 1 条真实 HTTP）。
- `pnpm --filter @agentport/api typecheck`（`tsc -b`）→ 无错误。
- `./node_modules/.bin/biome check packages/api/src/features/servers/ssrf.ts` → Checked 1 file, no fixes applied。
- `./node_modules/.bin/biome check packages/api/test/ssrf.test.ts` → Checked 1 file, no fixes applied。
- Opus 独立 review：通过，无阻断项；40 万地址差分为一致，边界与 `assertSafeUrl` 调用路径已核对，仅提出「特殊 DNS 表示解析差异」的非阻断文档修正，已记录在「解析差异」并补测试。
- Opus 增量复核：通过，无阻断项。
- 源码净减 **51** 行（`ssrf.ts` 新增 11 / 删除 62）。
- 运行时核对（Node v24.22.0）：`check('::ffff:127.0.0.1', 'ipv6')` 与 `check('::ffff:7f00:1', 'ipv6')` 均跨族命中 IPv4 网段；`check('64:ff9b::7f00:1', 'ipv6')` 命中 NAT64 子网；`::ffff:8.8.8.8`、`64:ff9b::808:808` 不命中。带 zone 的 IPv6 literal 由 `new URL` 直接拒绝；DNS 返回带 zone 字符串时 `isIP` 识别为 IPv6 且命中私网，测试已覆盖。
- 测试运行生成的 `.vitest/json/output.json` 已在本树恢复为提交版本，未纳入提交；主 checkout 中用户同名改动未触碰。
