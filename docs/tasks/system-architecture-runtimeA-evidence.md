# 运行边界分区 A：官方文件渲染与 roundtrip 证据

> 执行日期：2026-10-31。基线 `68241ba`；树 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`。
> 本文只记录分区 A（R1/R2/R4）的真实执行证据，不改任务主记录或其他文档。

## 改动文件

- `packages/core/src/workspace.ts`：根 `CLAUDE.md` 的工具清单/无 MCP 分支/等待说明只看根 `serverNames`；`undefined` 仍为全集、显式 `[]` 为根无绑定；`.mcp.json` 继续是父子并集。根与子级文件写入成对、末尾锚定的 `<!-- agentport:generated:start/end -->` 生成后缀。子级列表去掉虚假“超时”列，改为真实 `maxTurns`；等待规则改为“自身 `maxTurns` + 主运行总超时”；子级文件不再读取 `timeoutMs` 生成秒数。
- `packages/core/src/official-files.ts`：解析器改为只识别“独占行、成对、结束标记位于文件末尾”的生成后缀；删除 `## 工具使用` 与自然语言委派提示截断。无终端有效后缀的手写文件全文作为正文。
- `packages/core/test/workspace.test.ts`、`official-files.test.ts`：R1/R2/R4 行为测试。
- `packages/core/test/workspace-input.test.ts`：只同步受本修复影响的旧断言（`120s` 列 → `maxTurns`；子级不再含“最多等你”）。
- `packages/api/test/agent-package-zip.test.ts`：真实 ZIP 导出 → 导入新实体 → GET 正文 → 再导出；修正旧注释，新增边界样例 roundtrip。
- 未改 `agent-package.ts`、shared、web、LoopX、其他文档；`timeoutMs` 字段与导出/导入 sidecar 行为保留。

## 红（实现前）

```sh
pnpm exec vitest run --project backend packages/core/test/workspace.test.ts packages/core/test/official-files.test.ts packages/core/test/workspace-input.test.ts --reporter=json --outputFile=/tmp/agentport-architecture-runtimeA-red-core.json
```

结果：61 项，52 通过、9 失败、0 跳过。失败原因与预期一致：

- 根仅绑定 A、子级 B 时根提示仍列出 B；根显式 `[]` 仍生成 MCP 等待段。
- 用户正文含 `## 工具使用` 时 `parseClaudeMd` 截断；正文含委派提示时 `parseChildAgentMd` 截断；无生成后缀的手写文件被当作有边界。
- 子级列表仍显示 `120s`，子级文件仍写“父智能体最多等你 120 秒”。

## 绿（实现后）

```sh
pnpm exec vitest run --project backend packages/core/test/workspace.test.ts packages/core/test/official-files.test.ts packages/core/test/workspace-input.test.ts --reporter=json --outputFile=/tmp/agentport-architecture-runtimeA-green-core2.json
```

结果：62 项全部通过、0 失败、0 跳过。覆盖普通/重复 `## 工具使用`、原委派提示、单独 start/end、完整及多个同标记示例、CRLF、BOM、无生成后缀的手写文件、空子级正文；根/子级 `parse(render(prompt))` 逐字一致。

## 真实 ZIP 往返

```sh
pnpm --filter @agentport/core build
pnpm exec vitest run --project backend packages/api/test/agent-package-zip.test.ts -t "round-trips root and child prompts containing boundary lookalikes" --reporter=json --outputFile=/tmp/agentport-architecture-runtimeA-zip-green4.json
```

结果：1 通过、0 失败。真实流程：API 创建父子专家并设置含同名标题、重复标题、委派提示、完整标记示例的根/子正文 → 导出 ZIP → 改写根 slug 后真实导入新实体 → GET 根与子正文逐字一致 → 再导出：正文仍逐字一致，生成区开始/结束标记各只比正文多一处（无回流、无重复），文件仍以结束标记收尾。同一往返还验证父/子独立运行超时 `456000`/`123000` 毫秒各自保留。OpenUI、skills、rules、memory、sidecar 断言保持通过。

首次运行曾因 `packages/core/dist` 仍是基线构建而失败（API 测试经 workspace dist 加载 core）；重建 core 后通过。**集成测试前必须重建 core。**

## 契约完整范围回归

```sh
pnpm exec vitest run --project backend packages/core/test/workspace.test.ts packages/core/test/official-files.test.ts packages/core/test/workspace-input.test.ts packages/api/test/agent-package-zip.test.ts packages/api/test/agent-package-zip-format.test.ts --reporter=json --outputFile=/tmp/agentport-architecture-runtimeA-range1.json
```

结果：113 项全部通过、0 失败、0 跳过。

```sh
pnpm exec vitest run --project backend packages/sandbox/test/runner.test.ts packages/sandbox/test/sub-agent-permissions.test.ts packages/sandbox/test/memory-permissions.test.ts packages/worker/test/session-sandboxes.test.ts packages/api/test/agents.test.ts packages/api/test/chat.test.ts --reporter=json --outputFile=/tmp/agentport-architecture-runtimeA-range2.json
```

结果：183 项，181 通过、2 失败、0 跳过。两项失败均在 `packages/api/test/agents.test.ts`，错误来自未改动的 `packages/api/src/features/agents/memory-files.ts`：

- PUT 规则返回 `INVALID_INPUT: 记忆目录与文件不允许符号链接`（该目录逐层 `lstat` 拒绝链接，macOS 测试 `WORKSPACES_DIR` 位于 `/var/...`，`/var` 本身是符号链接）。
- 同一路径导致数据库 NUL 字节用例返回 400 而非 500。

两项与本分区改动文件无调用关系；`chat.test.ts`（并行分区改动中）全部通过。

## 类型、格式与构建

```sh
pnpm --filter @agentport/core typecheck
pnpm --filter @agentport/api typecheck
pnpm --filter @agentport/worker typecheck
pnpm --filter @agentport/sandbox typecheck
pnpm --filter @agentport/core build
./node_modules/.bin/biome check <本次改动的 6 个源码/测试文件>
```

全部通过（`tsc -b` 无输出；biome 仅格式化测试换行，复检 0 错误）。最终复跑：core 62/62、真实 ZIP 用例 1/1 通过（`/tmp/agentport-architecture-runtimeA-green-core-final.json`、`/tmp/agentport-architecture-runtimeA-zip-final2.json`）。

## R2 复审阻断修复：OpenUI 工具描述中的独占边界行

> 来源：独立 Opus 终审唯一阻断。基线仍为 `68241ba`；只改本分区文件。

### 阻断与最小复现

- 条件：`uiFormat: 'openui'`，且某个合法工具描述为多行，其中一行恰为独占的 `<!-- agentport:generated:start -->`。
- 现状：`openuiSystemPrompt` 把该行原样带进 `renderClaudeMd` 的平台生成后缀。`parseClaudeMd` 按 R2 规则取终端 END 之前最后一个独占 START，于是把 OpenUI 段之前的外层生成内容（`## 任务清单` 等）误当用户正文，复现为 prompt 35997 字符并含 `## 任务清单`；生成区自身不含独占边界行的契约被破坏。
- 为什么既有测试没拦住：当前 ZIP 导出未传 `openuiTools`，真实 ZIP roundtrip 走不到带工具描述的分支；已有 OpenUI 测试也没有含边界行的工具描述。
- 范围核查：进入生成后缀的外来多行内容不止工具描述——OpenUI 工具 `name`/`inputSchema`/`outputSchema` 的文本、server/skill/sub-agent 派生行都可能带换行。因此修复放在**最终生成后缀的统一入口**，一次覆盖所有外来文本；用户 `systemPrompt` 原文不参与处理，外层合法 wrapper 也不处理。

### 选定修法

- 在 `packages/core/src/workspace.ts` 组装完平台生成后缀正文后，逐行转义独占的保留标记行（`start`/`end`）：在标记前的 `<` 加一个反斜杠，使其不再是独占的 HTML 注释边界，同时保留原文字面量、工具描述能力与用户正文中的任何标记。
- 不改 parse 规则（R2 已确认的“终端有效后缀 + 最后一个独占 START”行为），不删工具描述、marker、unknown 正文，不新增官方字段、sidecar、随机 UUID 或框架。

### 测试与验证计划

- 先在 `packages/core/test/official-files.test.ts` 增加 `parseClaudeMd(renderWorkspace(...).claudeMd)`：OpenUI 工具描述包含独占 START、独占 END、成对样例三种情况，断言 `systemPrompt` 逐字保真，且生成区只有渲染器自己的成对标记。
- 诚实红：先跑新用例确认失败原因正是上述误切；再实现最小修法转绿。
- 绿后复跑 core 全量（workspace / official-files / workspace-input）与完整 ZIP 范围（`agent-package-zip*`）；API 集成前重建 `@agentport/core` dist。vitest 统一用 `rtk bypass ... --reporter=json --outputFile=/tmp/agentport-architecture-runtimeA-r2fix-<stage>.json`。

### 实际红绿

- 红（实现前）：`pnpm exec vitest run --project backend packages/core/test/official-files.test.ts -t "keeps OpenUI tool descriptions"` → 新增 1 项失败，其余 13 项因 `-t` 过滤未执行。失败原因与复现一致：`expected '你是调研员。…\n\n<!-- agentport:generated:start -->…' to be '你是调研员。…'`，即外层生成内容被误当正文。`/tmp/agentport-architecture-runtimeA-r2fix-red.json`。
- 绿（实现后）：同一条聚焦用例 1 通过；`packages/core/test/workspace.test.ts` + `official-files.test.ts` + `workspace-input.test.ts` 共 63 项全部通过、0 失败、0 跳过（比修复前 62 项多新增用例）；`/tmp/agentport-architecture-runtimeA-r2fix-green-core-final.json`。
- 先 `pnpm --filter @agentport/core build` 重建 dist，再跑完整 ZIP 范围 `packages/api/test/agent-package-zip.test.ts` + `agent-package-zip-format.test.ts`：52 项全部通过、0 失败、0 跳过；`/tmp/agentport-architecture-runtimeA-r2fix-green-zip-final.json`。
- `biome check` 覆盖 `packages/core/src/workspace.ts`、`packages/core/src/official-files.ts`、`packages/core/test/official-files.test.ts`：0 错误。
- 实际改动文件：`packages/core/src/workspace.ts`（组装完生成正文后统一转义）、`packages/core/src/official-files.ts`（新增 `escapeGeneratedBoundaryLines`，parser 规则未改）、`packages/core/test/official-files.test.ts`（红绿用例）；本证据文件。未改其他分区、ZIP 测试或 UI。
- 两旧 memory 失败沿用 Opus 已确认结论（`TMPDIR=/var` 符号链接），本修复未涉及，不重复调查。

## 限制与未覆盖

- 未使用付费模型；未执行 Git 提交、推送或发布。
- 未修改 UI 的超时标签（分区 C 负责）；本区只保证生成文件不再宣称子级独立秒数。
- 生成后缀是平台合法产物的 roundtrip 约定，不是权限或 prompt injection 边界。
- `packages/api/test/agents.test.ts` 的 macOS 符号链接失败是当前环境/未改动代码的既有问题，本区未修复也未据此宣称全套通过。
