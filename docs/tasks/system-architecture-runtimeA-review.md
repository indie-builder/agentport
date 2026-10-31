# 运行边界分区 A：独立 Opus 终审结论

> 日期：2026-10-31。基线 `68241ba`；树 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`。
> 本文只记录独立 Opus 对本分区 R1/R2/R4 与相关 UI 的真实结论，以及控制会话已收的复核证据。本文不改源码，不重审源码，不替代 [运行合同](system-architecture-runtime-contract.md) 或 [分区 A 证据](system-architecture-runtimeA-evidence.md)；证据文件由修复分区维护，本文不触碰。

## 1. 终审结论

- **R2 定向复审通过，runtime A 无剩余阻断。** R1（根 MCP 清单）、R4（超时声明）、timeout UI 与 R2 修复均通过；R3（init 列表 fail-closed）与 R6（绝对路径候选）继续拒绝，结论照旧。
- R2 修复后定向独立 Opus 复审：`115/115` passed、`0` failed、`0` skipped，其中 core 63 + ZIP 52，报告 `/tmp/agentport-architecture-runtimeA-r2fix-review.json`。原始 `START` 输入正文严格逐字相等；独立探测的根 192、子 12、转义 8 组场景通过。
- 先前 `114/114` 的独立复跑与本次 `115/115` 是同一分区不同时点的证据；前者不覆盖 R2，后者覆盖修复后 core+ZIP 范围。两者都只证明 runtime A 范围，不等于整任务通过。

## 2. R2 修复与定向复审

### 原阻断条件与机制

- 条件：`uiFormat: 'openui'`，且某个合法工具描述为多行，其中一行恰为独占的 `<!-- agentport:generated:start -->`。
- 机制：`openuiSystemPrompt` 把该行原样带进 `renderClaudeMd` 的平台生成后缀；`parseClaudeMd` 按 R2 规则取终端 `END` 之前最后一个独占 `START`，于是把 OpenUI 段之前的外层生成内容误当用户正文。
- 原实测影响：原“原始正文”回读为 `35997` 字符并含 `## 任务清单`，用户 systemPrompt 不再逐字保真。

### 修复内容

- 不改官方目录、官方字段或 SDK 加载方式。
- 根生成正文在最终生成后缀的统一入口逐行转义独占保留标记行（在 `<` 前加一个反斜杠），覆盖 `description`/`name`/`inputSchema`/`outputSchema` 以及 server/skill/sub-agent 派生内容；多行与字面量保留。
- 原先 `inlineText` 压平的部分保持不变；用户 `systemPrompt` 原文与外层合法 wrapper 不处理，解析规则不变。
- 子级生成后缀只有 3 行固定文本、不含任何外来值，因此不需要同一 helper。

### 测试与复审

- `packages/core/test/official-files.test.ts` 覆盖 OpenUI 工具描述含独占 `START`、独占 `END`、成对样例，断言 `systemPrompt` 逐字保真且生成区只有渲染器自己的成对标记；真实 ZIP 范围同步回归。
- 定向复审只覆盖本修复与 core/ZIP 范围，未全量重扫已通过的 R1/R4/UI。

## 3. 记忆路径失败复核

- 原 range 共 `183` 项，其中 `2` 项失败均在 `packages/api/test/agents.test.ts`，错误来自未改动的 `packages/api/src/features/agents/memory-files.ts`：目录逐层 `lstat` 拒绝符号链接，而 macOS 测试 `WORKSPACES_DIR` 位于 `/var/...`，`/var` 本身是符号链接；同一路径还使 NUL 字节用例返回 400 而非 500。
- 控制会话通过仅进程级配置把 `TMPDIR` 从 `/var` 换到同目录真实路径 `/private/var`，两项定向用例均通过；original/realpath 报告分别为 `/tmp/agentport-architecture-runtimeA-memory-original.json` 与 `/tmp/agentport-architecture-runtimeA-memory-realpath.json`。
- 两份报告都只跑了这 `2` 项定向用例，`27` 项未运行（`29 total`，original `0 passed / 2 failed / 27 pending`，realpath `2 passed / 0 failed / 27 pending`）；不能据此宣称该套件整体通过。
- `memory-files` helper/tests 相对基线无 diff；这是既有环境路径问题，不是本分区回归，**不改安全检查**来迁就测试路径。

## 4. 证据边界与后续

- 本记录来源是独立 Opus 结论与控制会话已收结果，未重新审查源码；未执行 Git、LoopX 操作或源码修改。
- runtime A 已无剩余阻断；R3/R6 的拒绝结论不因修复改变。
- 联合验证、runtime B 接线与整任务独立终审仍未完成；当前不是整任务实现完成或 review 通过状态。
