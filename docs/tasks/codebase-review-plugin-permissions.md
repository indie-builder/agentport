# 插件 ZIP 可执行位闭环

## 目标

让插件目录的 Unix 可执行位在 ZIP 导入、落库、导出、再导入和运行时落盘之间保持不变：

- 导入按 ZIP 中央目录的 Unix 元数据读取真实可执行位，不再按扩展名猜。
- 导出写回 Unix 元数据，导出后再导入仍保持同一可执行位。
- 运行时由 worker 按该位落盘，hook 直接调用无扩展名脚本可以执行。
- 无 Unix 元数据的条目默认不可执行；`.sh` 等普通文件不再被误标为可执行。
- symlink、损坏、超限等既有 ZIP 安全校验继续有效。

验收：真实导入一个「无扩展名但可执行」的脚本，API 返回 `executable: true`；一个「`.sh` 但不可执行」的文件返回 `false`；导出再导入后两者不变；按 worker 现有权限规则落盘后 `stat` 有执行位并能实际运行该可信脚本。

## 方案

- 共享 Seam 放在 `packages/api/src/features/agent-package-zip.ts`：复用现有 `readCentralDirectory` 的中央目录解析与全部安全检查，新增 `decodePackageEntries` / `encodePackageEntries` 暴露/写入 `{ content, executable }`。现有 `decodePackage` / `encodePackage` 的签名与语义不变，前者委托新函数后取 `content`，后者以 `executable: false` 委托新函数；只解析一次，不另写 ZIP 解析器。
- 读取规则：中央目录 `version made by` 高字节为 `3`（Unix）时，取 external attributes 高 16 位；`& 0o111 !== 0` 为可执行。非 Unix 或无 external attributes 的条目一律不可执行。
- 写入规则：fflate 官方文件级选项 `[bytes, { os: 3, attrs: (mode << 16) >>> 0 }]`，可执行文件 `0o100755`，普通文件 `0o100644`。不保存整段 mode，不新增 DB 字段。
- 插件路由的导入/导出改用新 Seam，删除扩展名推断；不复制第二套中央目录解析。
- 依赖：只使用已安装 `fflate@0.8.3` 与 Node 标准库，不新增依赖。

## 基线与范围

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-review-loop`
- 分支：`worktree-codebase-review-loop`
- 基线：`HEAD = e060e3a559633a0d94adb637516a6d577b86b1aa`
- 开工时工作树已有其他作者未提交差异；本任务只改下列边界，不触碰其他文件。
- 允许改动：
  - `packages/api/src/features/plugins/routes.ts`
  - `packages/api/src/features/agent-package-zip.ts`
  - 新增 `packages/api/test/plugin-zip-permissions.test.ts`（插件路由 / ZIP 权限测试）
  - 本记录
- 不改：`packages/api/src/features/plugins/parse.ts`、`plugin-parse.test.ts`、core 渲染源码、其它专家包业务、恢复脚本、主任务记录。

## 当前有效决定

- 本任务执行约束：不派代理、不提交；当前 worktree 为准。该约束只针对本任务作者，不当作全局要求。
- 已验收：独立 Opus `ae3` review 通过；主会话 `b9g1fl3ks` 7 files / 89 passed / 0 skipped。
- 覆盖范围：API 存储、ZIP 往返与 render、按 worker 规则临时落盘执行；不声称真实 worker / SDK hook 调用已验证。
- 可执行位只按 Unix versionMadeBy/externalAttributes 读取，不按扩展名猜。
- ZIP codec 只增加能力，不改变专家包已有 `decodePackage` / `encodePackage` Interface 语义。
- 测试 fixture 由本任务编写且内容明确可信；不执行外来不可信插件。

## 已替代项及原因

- 取代 `routes.ts` 中「按 `.sh|.bash|.py|.js|.mjs|.cjs` 扩展名推断可执行」的 shortcut：该推断把不可执行的 `.sh` 标为可执行，并丢掉无扩展名脚本的可执行位。

## 步骤

- [x] 写任务记录与契约。
- [x] 先写失败测试：真实 ZIP 导入/导出可执行位、无 Unix 元数据默认 false、真实落盘执行。
- [x] 跑测试确认失败原因符合预期。
- [x] 在共享 codec 增加 metadata 读写能力并保持旧 Interface。
- [x] 插件路由改用新 Seam，删除扩展名推断。
- [x] 最小绿：复跑目标套件、api typecheck、biome。
- [x] 独立 Opus review `ae3` 通过（不在本作者范围内）。

## 改动文件

- `packages/api/src/features/agent-package-zip.ts`
- `packages/api/src/features/plugins/routes.ts`
- `packages/api/test/plugin-zip-permissions.test.ts`（新增）
- `docs/tasks/codebase-review-plugin-permissions.md`（本记录）

## 下一步

- 已验收，无后续动作；真实 worker / SDK hook 调用不在本任务验证范围。

## 验证

红（实现前，新增套件）：

```
pnpm exec vitest run packages/api/test/plugin-zip-permissions.test.ts --reporter=verbose
Test Files  1 failed (1)
Tests  4 failed (4)
```

四条失败原因均为预期：无扩展名可执行脚本导入为 `false`；无 Unix 元数据的 `.sh` 被扩展名推断成 `true`；导出再导入丢失无扩展名脚本的可执行位；renderPlugin 输出同样丢失可执行位。

绿（实现后）：

```
pnpm exec vitest run packages/api/test/plugins.test.ts packages/api/test/plugin-parse.test.ts \
  packages/api/test/native-plugins.test.ts packages/api/test/plugin-zip-permissions.test.ts \
  packages/api/test/agent-package-zip.test.ts packages/api/test/agent-package-zip-format.test.ts \
  packages/api/test/agent-package-export-limits.test.ts
Test Files  7 passed (7)
Tests  89 passed (89)
```

- 上述套件为主会话 `b9g1fl3ks` 复跑结果（7 files / 89 passed / 0 skipped）。
- `pnpm --filter @agentport/api typecheck`：exit 0。
- `rtk bypass pnpm exec biome check packages/api/src/features/agent-package-zip.ts packages/api/src/features/plugins/routes.ts packages/api/test/plugin-zip-permissions.test.ts`：无错误。
- 独立 Opus `ae3` review 通过。
- 依赖：仅使用已安装 `fflate@0.8.3` 与 Node 标准库，未新增依赖、未改 package.json / lockfile。
- 落盘用例使用临时目录，按 worker 同一条规则（`executable ? 0o700 : 0o600`）写入后 `stat` 校验执行位并真实执行可信脚本 `printf ran`；未执行任何外来插件内容。
- 范围边界：验证止于 API 存储 / ZIP 往返 / render 与临时落盘执行，不声称真实 worker / SDK hook 调用。

### 限制

- worker 的 `writeWorkspace` 未导出；落盘测试按 worker 现有同一条权限规则（`executable ? 0o700 : 0o600`）写入临时目录，未直接调用该函数。要覆盖到函数入口需改 worker 源码，超出本任务文件边界。
- 只识别 versionMadeBy 高字节为 3（Unix）的条目；macOS 原生打包若写 19 等非 Unix 主机号，按不可执行处理（符合「无 Unix attrs 默认不可执行」的约定）。
