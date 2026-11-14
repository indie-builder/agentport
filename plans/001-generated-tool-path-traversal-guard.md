# Plan 001: 拦截生成式 MCP 工具路径参数的 `..` 越界

> **Executor instructions**: 按步骤执行，每步跑完验证命令并确认预期结果再继续。遇到「STOP 条件」立即停止并报告，不要即兴发挥。完成后更新 `plans/README.md` 中本计划状态行。
>
> **Drift check（先跑）**: `git diff --stat 7166f519..HEAD -- packages/api/src/modules/servers/generated.ts`
> 若该文件在计划写出后被改过，先对照下面「Current state」摘录；与现状不符按 STOP 处理。

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `7166f519`, 2026-11-14

## Why this matters

生成式连接器（generated）把用户定义的 `pathTemplate`（如 `GET /api/files/{id}`）与模型/外部客户端提供的参数拼成真实上游 URL。`fillPath()` 用 `encodeURIComponent` 填充参数，但该函数**不转义 `.`**，所以参数值 `..` 会原样写入路径；随后 `new URL(base + path)` 按 WHATWG 规则把 `/api/files/..` 归一化为 `/api/`，因此模型只要传入 `..` 就能让请求越过工具声明的路径段，打到同一上游主机的其它端点，并带上平台为该 server 存储的授权头/凭据。`/` 已被编码，所以单次只能越一级，不能任意跳转，但这仍是「模型可控输入绕过工具路径约定」的信任边界校验缺口。修复：在填充路径参数时拒绝 `.`/`..` 值，返回工具错误而不是发出请求。

## Current state

- `packages/api/src/modules/servers/generated.ts:129-140` — `fillPath()`，用 `encodeURIComponent` 填参：

```ts
function fillPath(
  template: string,
  args: Record<string, unknown>,
): { path: string; rest: Record<string, unknown> } {
  const rest: Record<string, unknown> = { ...args };
  const path = template.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    const value = rest[key];
    delete rest[key];
    return encodeURIComponent(value === undefined ? '' : String(value));
  });
  return { path, rest };
}
```

- `packages/api/src/modules/servers/generated.ts:190-196` — 拼 URL 并发请求（`assertServerEndpoint` 只校验主机，不校验路径段）：

```ts
  const { path, rest } = fillPath(tool.pathTemplate, args);
  const url = new URL(baseUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`));
  await assertServerEndpoint(url.toString(), { nodeEnv, allowlist: privateHostAllowlist });
```

- 同一文件 `:180-188` 已有「参数不合法 → 返回 `isError` 工具结果」的现成写法（`body` 参数不支持时），本计划沿用它作为非法路径参数的处理方式。

## Commands you will need

| 用途 | 命令 | 成功判据 |
|---|---|---|
| 类型检查 | `bun run --filter @agentport/api typecheck` | exit 0 |
| 测试 | `bun run test -- packages/api/test/generated-mcp.test.ts` | 全绿 |
| 规范检查 | `bunx biome check packages/api/src/modules/servers/generated.ts` | 0 error |

> 跑后端测试前先构建共享包：`bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build`。

## Scope

**In scope**（只改这些）:
- `packages/api/src/modules/servers/generated.ts`
- `packages/api/test/generated-mcp.test.ts`（追加用例；若该文件结构不适合，可新建 `packages/api/test/generated-path.test.ts`）

**Out of scope**（不要动）:
- `packages/api/src/modules/servers/tool-arguments.ts`（参数 JSON Schema 校验，与路径填充是两层，不合并）。
- `packages/api/src/modules/servers/ssrf.ts` / `assertServerEndpoint`（主机级校验保持不变）。
- 不要试图“清理”模板里的其它字符或改写 `pathTemplate` 存储格式。

## Git workflow

- 分支：`advisor/001-generated-path-traversal-guard`
- 提交风格跟仓库现有：conventional commits（如 `fix(api): 拦截生成式工具路径参数的 .. 越界`）。
- 不要 push、不要开 PR，除非操作者要求。

## Steps

### Step 1: 在 `fillPath` 拒绝 `.`/`..` 段

把填充逻辑改为对非法值返回一个显式失败标记，而不是静默拼接。建议让 `fillPath` 返回判别联合：

```ts
type FilledPath =
  | { ok: true; path: string; rest: Record<string, unknown> }
  | { ok: false; param: string };
```

规则：某个被填充的参数值 `String(value)` 恰好等于 `.` 或 `..` 时返回 `{ ok: false, param: key }`。（`/`、`\`、`%` 已被 `encodeURIComponent` 处理；只需拦这两个全段值。不要放宽为“值里含点就拒”，那会误伤 `v1.2`、`file.txt` 等合法值。）

**Verify**: `bun run --filter @agentport/api typecheck` → exit 0

### Step 2: 在调用点把失败转成工具错误结果

在 `generated.ts:190` 调用处，若 `fillPath` 返回 `ok:false`，比照 `:180-188` 的既有写法返回 `isError: true` 的 `CallToolResult`，文案类似：`` `${tool.method} 工具「${tool.name}」的参数 ${param} 不能是 "." 或 ".."` ``，并且**不要**构造 `URL`、不要 `fetch`。成功分支保持原逻辑。

**Verify**: `bun run --filter @agentport/api typecheck` → exit 0

### Step 3: 追加回归测试

在 `packages/api/test/generated-mcp.test.ts`（参照该文件已有的 `buildGeneratedServer` 构造 + 调用工具测试模式）新增用例：
1. 模板含 `{id}`，传 `id: '..'` 时工具返回 `isError: true`，且没有发起上游请求（复用文件内既有的 fetch 断言/计数方式）。
2. 传 `id: 'v1.2'` 或 `id: 'file.txt'` 时正常发出请求（保证不误伤合法点号值）。
3. （若成本低）模板 `/a/{x}/b/{y}` 传 `x:'..'` 也返回 `isError`。

**Verify**: `bun run test -- packages/api/test/generated-mcp.test.ts` → 全绿，新增用例通过

### Step 4: 规范检查

**Verify**: `bunx biome check packages/api/src/modules/servers/generated.ts packages/api/test/generated-mcp.test.ts` → 0 error

## Test plan

- 新增 3 条定向用例（见 Step 3），覆盖：`..` 拒绝并短路、合法点号值放行、多段模板。结构参照 `packages/api/test/generated-mcp.test.ts` 既有工具调用用例与 `generated-cancel-http.test.ts` 的真实 HTTP 计数写法。
- 安全类改动按 `AGENTS.md`「并发/安全相关改动必须附测试或实测记录」要求，测试为必交项。

## Done criteria

- [ ] `bun run --filter @agentport/api typecheck` exit 0
- [ ] `bun run test -- packages/api/test/generated-mcp.test.ts` 全绿，含新增用例
- [ ] `grep -n "不能是" packages/api/src/modules/servers/generated.ts` 命中新错误分支
- [ ] 除 in-scope 文件外无其它改动（`git status`）
- [ ] `plans/README.md` 状态行已更新

## STOP conditions

- 「Current state」摘录与现状不符（文件已漂移）。
- 发现 `fillPath` 之外还有第二处路径拼接/URL 构造（例如 test-connection 里也拼 path），需要一并处理——停下来报告，不要扩大改动。
- 测试环境（Docker PG/Redis）不可用导致无法跑 `bun run test`：改为记录「未跑后端测试」并说明，不要用空跑冒充通过。

## Maintenance notes

- 若将来允许 `pathTemplate` 里同一参数跨多段或支持 `*` 通配，需重新审视本拦截是否覆盖新语义。
- 评审重点：确认只拦 `.`/`..`、不误伤合法含点值；确认失败分支未构造 URL/未 fetch。
- 明确不做：不改 `assertServerEndpoint`、不改工具参数 schema 校验层。
