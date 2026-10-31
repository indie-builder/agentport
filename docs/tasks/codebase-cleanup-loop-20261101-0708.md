# 收敛 web 包内两份 `useMediaQuery` 实现（2026-11-01）

## 目标

`packages/web/src/pages/chat.tsx` 与 `packages/web/src/pages/plugin-detail.tsx` 各有一份逐字相同的 `useMediaQuery`，收敛为 web 包内公共 hook，调用逻辑、订阅行为与渲染结果不变。

验收标准：

- 只保留 `packages/web/src/lib/use-media-query.ts` 一处定义，导出 `useMediaQuery(query: string): boolean`。
- 两个页面删除本地副本，改为从 `../lib/use-media-query.js` 引入；断点常量、调用点与渲染逻辑不改。
- `git diff --check`、`biome check`、`@agentport/web` typecheck 与 `pnpm test:web` 全部通过。
- 不新增依赖，不动 `errorText` / `isPgCode` / `hasCode` / connector 网络辅助。

## 方案

- 新建 `packages/web/src/lib/use-media-query.ts`，函数体逐字复制现有版本：`useState` 惰性初始化 `window.matchMedia(query).matches`、`useEffect` 订阅 `change`、卸载时移除监听，依赖数组为 `[query]`。只比实现体多一行说明注释，风格对齐同目录 `use-debounced-value.ts`。
- 两个页面删除本地 `function useMediaQuery(...)`，按该目录现有相对导入习惯（带 `.js` 后缀）从 `../lib/use-media-query.js` 引入。
- `useState` / `useEffect` 的 import 保留：chat.tsx 与 plugin-detail.tsx 在别处仍大量使用，删掉会断。
- 不改任何调用点、断点常量、渲染逻辑、视觉或依赖。

## 基线

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup-loop-20261101-0708`
- 分支：`worktree-codebase-cleanup-loop-20261101-0708`
- 基线提交：`origin/main` `2cc2eff`
- 初始未提交差异：无（`git status` 干净）

## 当前有效决定

- 单次用户任务明确：只做这一项收敛；不 commit、不 push。
- 两份实现外观一致，任务要求先逐行比对；比对结果为逐字相同（见「验证」），无 query 依赖、事件监听或 SSR 分支差异，因此继续按等价搬移执行。
- 仓库现无文件使用 `@/*` 别名，统一采用相对路径 + `.js` 后缀，本次沿用。

## 步骤

- [x] 逐行比对两份实现（`chat.tsx:336-345` 与 `plugin-detail.tsx:42-51`）：`diff` 无输出，逐字相同。
- [x] 新建 `src/lib/use-media-query.ts`，函数体逐字复制。
- [x] 两个页面删除本地副本，改为 `import { useMediaQuery } from '../lib/use-media-query.js'`。
- [x] 核对 `useState` / `useEffect` 仍被文件其他位置使用，保留 import。
- [x] 按 `docs/PITFALLS.md` 先构建 `shared` / `core` / `db` 产物，再运行 typecheck、`pnpm test:web`、`git diff --check` 与 `biome check`。

## 改动文件

- `packages/web/src/lib/use-media-query.ts`（新增）
- `packages/web/src/pages/chat.tsx`
- `packages/web/src/pages/plugin-detail.tsx`
- `docs/tasks/codebase-cleanup-loop-20261101-0708.md`

## 下一步

- 用户审阅后决定是否提交；本任务未 commit、未 push。

## 验证

### 改前：两份实现逐字相同

基线 `2cc2eff` 的真实源码：

```bash
sed -n '336,345p' packages/web/src/pages/chat.tsx > /tmp/a.txt
sed -n '42,51p' packages/web/src/pages/plugin-detail.tsx > /tmp/b.txt
diff /tmp/a.txt /tmp/b.txt && echo "IDENTICAL"
```

```text
IDENTICAL
```

两份内容同为：

```ts
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = (): void => setMatches(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
```

### 改前：搬移型改动没有可先红的断言

本改动不改变行为，只把相同函数体搬到共享模块并删除副本，不存在「改前失败、改后通过」的行为断言。新建的 hook 在搬移前会因模块不存在而报解析错误，这不是可供先红的行为证据，故不伪造红灯。等价证据为上面的逐字比对：新文件函数体与两份原实现完全相同，导入路径替换是唯一语义变化。

### 改后：类型检查

```bash
pnpm --filter @agentport/web typecheck
```

```text
$ tsc -b
```

退出码 0，无诊断输出。首次运行曾因新 worktree 缺 `shared` / `core` / `db` 的 `dist` 报 `Cannot find module '@agentport/shared'`，按 `docs/PITFALLS.md`「真实容器测试可能加载旧 dist」先构建产物后通过，与本次改动无关。

### 改后：全量 web 测试

```bash
pnpm test:web
```

```text
 Test Files  148 passed (148)
      Tests  1841 passed (1841)
```

### 改后：格式与空白

```bash
./node_modules/.bin/biome check packages/web/src/lib/use-media-query.ts \
  packages/web/src/pages/chat.tsx packages/web/src/pages/plugin-detail.tsx
git diff --check
```

```text
Checked 3 files in 47ms. No fixes applied.
```

`biome check` 退出码 0；`git diff --check` 无输出，退出码 0。
