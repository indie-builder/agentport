# 收敛 shared 包内四份 `utf8Bytes` 实现（2026-11-01）

## 目标

`packages/shared/src` 内 `utf8Bytes` 有 4 份实现（`chat.ts`、`native-plugins.ts`、`sandbox-probe.ts`、`memory.ts`），收敛为一份包内实现，调用逻辑、限额与错误行为不变。

验收标准：

- 只保留 `src/utf8.ts` 一处定义，四个使用方改为从 `./utf8.js` 引入。
- 不把 `utf8Bytes` 加入 `src/index.ts` 公开 barrel，保持包内实现细节。
- 新增边界测试覆盖空串、ASCII、UTF-8 1/2/3/4 字节边界、emoji 与孤立代理项。
- `git diff --check`、`biome check`、`@agentport/shared` typecheck 与相关测试全部通过。

## 方案

- 新建 `packages/shared/src/utf8.ts`，导出 `utf8Bytes(value: string): number`，函数体与 `chat.ts` / `native-plugins.ts` / `sandbox-probe.ts` 三份逐字一致，使用字面量 `0x80` / `0x800` / `0x10000`。
- `chat.ts`、`native-plugins.ts`、`sandbox-probe.ts`、`memory.ts` 删除本地副本与各自的说明注释，改为 `import { utf8Bytes } from './utf8.js'`；原注释中「shared 不带 Node/DOM lib、按码点手算」的唯一说明移入 `utf8.ts`。
- 删除 `memory.ts` 中只服务本地副本的 `UTF8_BYTES_2` / `UTF8_BYTES_3` 常量。
- 新建 `packages/shared/test/utf8.test.ts`，直接导入真实实现断言，不使用 mock。
- 不新增依赖、不改限额、不改调用顺序与错误文案；`useMediaQuery`、`errorText`、`isPgCode`、`hasCode`、connector 网络辅助按任务边界不动。

## 基线

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup-loop-20261101-0617`
- 分支：`worktree-codebase-cleanup-loop-20261101-0617`
- 基线提交：`origin/main` `808019e`
- 初始未提交差异：无（`git status` 干净）

## 当前有效决定

- 单次用户任务明确：只做这一项收敛；不 commit、不 push。
- `utf8Bytes` 属 shared 包内实现细节，不进入公开 barrel；测试直接从 `../src/utf8.js` 导入。
- 新实现采用三份逐字相同的字面量版本；`memory.ts` 的命名常量被删除，其数值与原常量完全相同，不保留别名。

## 步骤

- [x] 逐字比对四份实现：三份函数体完全相同；`memory.ts` 仅把 `0x800` / `0x10000` 换成 `UTF8_BYTES_2` / `UTF8_BYTES_3`（值分别为 `0x800`、`0x10000`）。
- [x] 新建 `src/utf8.ts`，保留唯一一份说明注释。
- [x] 四个使用方删除本地副本并改为导入 `./utf8.js`；`memory.ts` 删除不再使用的命名常量。
- [x] 新建 `test/utf8.test.ts`，覆盖任务列出的全部边界。
- [x] 运行 typecheck、定向测试、`git diff --check` 与 `biome check`。

## 改动文件

- `packages/shared/src/utf8.ts`（新增）
- `packages/shared/src/chat.ts`
- `packages/shared/src/memory.ts`
- `packages/shared/src/native-plugins.ts`
- `packages/shared/src/sandbox-probe.ts`
- `packages/shared/test/utf8.test.ts`（新增）
- `docs/tasks/codebase-cleanup-loop-20261101-0617.md`

## 下一步

- 用户审阅后决定是否提交；本任务未 commit、未 push。

## 验证

### 改前：搬移型改动没有可先红的断言

本改动不改变任何行为，只把相同函数体搬到共享模块并删除副本，因此不存在「改前失败、改后通过」的行为断言。新增的 `utf8.test.ts` 在实现搬移前会因 `../src/utf8.js` 不存在而报模块解析错误，这不是可供先红的行为证据，故不伪造红灯。

等价证据为改动前 `git show HEAD` 的真实源码（基线 `808019e`）：

- `packages/shared/src/chat.ts:33`、`native-plugins.ts:110`、`sandbox-probe.ts:52` 三份函数体逐字相同：

```ts
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}
```

- `packages/shared/src/memory.ts:202` 语义相同，只是用命名常量代替字面量（`UTF8_BYTES_2 = 0x800`、`UTF8_BYTES_3 = 0x10000`）：

```ts
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < UTF8_BYTES_2 ? 2 : cp < UTF8_BYTES_3 ? 3 : 4;
  }
  return bytes;
}
```

新建 `utf8.ts` 与前三份逐字一致；`memory.ts` 的两个常量值与字面量完全相同，替换后比较表达式等价。

改前定向测试（新 worktree 先按 `docs/PITFALLS.md` 构建 `shared` / `core` / `db` 产物）：

```bash
pnpm exec vitest run --project backend packages/shared/test/memory.test.ts \
  packages/shared/test/chat-events.test.ts \
  packages/shared/test/native-plugins.test.ts \
  packages/shared/test/sandbox-probe.test.ts
```

```text
Test Files  4 passed (4)
     Tests  40 passed (40)
```

### 改后：类型检查

```bash
pnpm --filter @agentport/shared typecheck
```

```text
$ tsc -b
```

退出码 0，无诊断输出。

### 改后：定向测试

```bash
pnpm exec vitest run --project backend packages/shared/test/utf8.test.ts \
  packages/shared/test/memory.test.ts \
  packages/shared/test/chat-events.test.ts \
  packages/shared/test/native-plugins.test.ts \
  packages/shared/test/sandbox-probe.test.ts
```

```text
Test Files  5 passed (5)
     Tests  45 passed (45)
```

新增 5 条用例覆盖：空串 `0`、`'abc'` 为 `3`；U+007F 为 `1`、U+0080 为 `2`、U+07FF 为 `2`；U+0800 为 `3`、U+FFFF 为 `3`；U+10000 为 `4`、`'😀'` 为 `4`；孤立代理项 U+D800 为 `3`。测试直接调用真实实现，无 mock。

`chatRequestSchema` 的另外两个直接使用方（消息字节限额校验）：

```bash
pnpm exec vitest run --project backend packages/shared/test/attachments.test.ts \
  packages/shared/test/outputs.test.ts
```

```text
Test Files  2 passed (2)
     Tests  20 passed (20)
```

### 改后：格式与空白

```bash
./node_modules/.bin/biome check packages/shared/src/utf8.ts \
  packages/shared/src/chat.ts packages/shared/src/memory.ts \
  packages/shared/src/native-plugins.ts packages/shared/src/sandbox-probe.ts \
  packages/shared/test/utf8.test.ts
git diff --check
```

```text
Checked 6 files in 18ms. No fixes applied.
```

`biome check` 退出码 0；`git diff --check` 无输出，退出码 0。
