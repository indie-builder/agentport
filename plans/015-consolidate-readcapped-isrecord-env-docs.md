# Plan 015: 收敛 readCapped 语义、isRecord 副本与环境变量文档

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 321cf491..HEAD -- packages/core/src/http-body.ts packages/api/src/modules/servers/generated.ts packages/core/src/record.ts packages/core/package.json packages/web/src/lib/data-domain-result.ts packages/web/src/components/chat/openui-message.tsx packages/worker/src/knowledge/source-dingtalk.ts packages/worker/src/knowledge/source-ima.ts .env.example docs/OPERATIONS.md packages/api/.env.example`
> On any mismatch with the excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `321cf491`, 2026-11-22

## Why this matters

三处 #646 之后的残留：`generated.ts` 仍有一份本地 `readCapped`，语义与 core 版本不同（静默截断 vs 抛错）；`isRecord` 谓词仍有 4 份内联副本；`GENERATED_PRIVATE_HOST_ALLOWLIST` 不在根 `.env.example` 与 `docs/OPERATIONS.md` 环境变量表，且 `packages/api/.env.example` 是无人加载的陈旧文件。收敛后同类修复只需要改一处，运维也能在标准位置找到内网放行开关。

## Current state

### 1. 本地 `readCapped`

`packages/api/src/modules/servers/generated.ts:87-105`：

```ts
async function readCapped(res: Response, max: number): Promise<string> {
  const body = res.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  while (total <= max) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (text.length > max) break;
  }
  return text;
}
```

调用点 `packages/api/src/modules/servers/generated.ts:177`：

```ts
      const MAX_BODY = 1_048_576;
      const text = await readCapped(res, MAX_BODY);
```

core 版本 `packages/core/src/http-body.ts:1-37`：

```ts
type CapOptions = { onExceeded?: () => never; checkContentLength?: boolean };

export async function readCappedBytes(
  response: Response,
  limit: number,
  label: string,
  options: CapOptions = {},
): Promise<Buffer> {
  const exceeded = (): never => {
    if (options.onExceeded) return options.onExceeded();
    throw new Error(`${label} response exceeds ${limit} bytes`);
  };
  if (options.checkContentLength !== false) {
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > limit) {
      await response.body?.cancel();
      return exceeded();
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > limit) return exceeded();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
```

### 2. `isRecord` 副本

core 已有一份（`packages/core/src/record.ts:1-3`）：

```ts
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

但 core 的 `package.json` 没有 `./record` 导出子路径。副本位置：

- `packages/web/src/lib/data-domain-result.ts:37-39` — `isRecord`
- `packages/web/src/components/chat/openui-message.tsx:98-100` — `isStateRecord`
- `packages/worker/src/knowledge/source-dingtalk.ts:344-348` — `recordOf`（返回 `undefined` 的变体）
- `packages/worker/src/knowledge/source-ima.ts:254-258` — `recordOf`（返回 `undefined` 的变体）

### 3. 环境变量文档

- `packages/api/src/config.ts:42` — `GENERATED_PRIVATE_HOST_ALLOWLIST: z.string().default('')`。
- `.env.example:58-62` — 只列出 `KNOWLEDGE_PRIVATE_HOST_ALLOWLIST`、`MODEL_PROVIDER_PRIVATE_HOST_ALLOWLIST`、`WEBHOOK_PRIVATE_HOST_ALLOWLIST`。
- `docs/OPERATIONS.md:142-144` — 环境变量表只列上述三项。
- `packages/api/.env.example:1-4` — 只有 `PLATFORM_MCP_TOKEN=`，没有任何脚本加载。
- `docs/ARCHITECTURE.md:428` 与 `docs/SECURITY.md:60` 已解释 `GENERATED_PRIVATE_HOST_ALLOWLIST` 的语义，可直接引用措辞。

仓库约定：不新增注释；不为单个修复新增单测；文档用中文。

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install --frozen-lockfile` | exit 0 |
| Build core | `bun run --filter @agentport/shared --filter @agentport/core build` | exit 0 |
| Core typecheck | `bun run --filter @agentport/core typecheck` | exit 0 |
| API typecheck | `bun run --filter @agentport/api typecheck` | exit 0 |
| Web typecheck | `bun run --filter @agentport/web typecheck` | exit 0 |
| Worker typecheck | `bun run --filter @agentport/worker typecheck` | exit 0 |
| Web tests | `bun run test:web` | all pass |
| Docs gate | `bun run lint:docs` | `docs navigation OK` |
| Format/lint (read-only) | `bunx biome check <modified files>` | 0 error |

## Scope

**In scope**:
- `packages/core/src/http-body.ts`
- `packages/api/src/modules/servers/generated.ts`
- `packages/core/package.json`
- `packages/web/src/lib/data-domain-result.ts`
- `packages/web/src/components/chat/openui-message.tsx`
- `packages/worker/src/knowledge/source-dingtalk.ts`
- `packages/worker/src/knowledge/source-ima.ts`
- `.env.example`
- `docs/OPERATIONS.md`
- `packages/api/.env.example`（删除）

**Out of scope**:
- `packages/api/src/modules/market/fetch-body.ts` — 已有自己的错误映射包装，不改。
- `packages/worker/src/knowledge/source-http.ts` — 使用 core 的抛错语义，不改。
- 任何 readCapped 限额数值、超时或重试策略。
- 不新增测试文件、不改 CSP 或其他配置语义。

## Git workflow

- 在 `.claude/worktrees/<slug>` 内工作，分支名用 ASCII slug。
- 建议按 Step 分别提交，例如 `refactor(api): 复用 core 的限长响应读取`、`refactor: 收敛 isRecord 实现`、`docs: 补齐 GENERATED_PRIVATE_HOST_ALLOWLIST`。
- 不推送、不开 PR，除非操作者明确要求。

## Steps

### Step 1: 给 core `readCapped` 增加显式截断选项

在 `packages/core/src/http-body.ts`：

1. `CapOptions` 增加 `truncate?: boolean` 与 `onTruncated?: () => void`。
2. `readCappedBytes` 中，`truncate === true` 时跳过 `content-length` 预检（继续读，最多到上限）：

```ts
  if (options.checkContentLength !== false && options.truncate !== true) {
```

3. 读取循环改为先判断再入列：

```ts
  for await (const chunk of response.body) {
    if (total + chunk.byteLength > limit) {
      if (options.truncate === true) {
        options.onTruncated?.();
        break;
      }
      return exceeded();
    }
    total += chunk.byteLength;
    chunks.push(chunk);
  }
```

`break` 会让异步迭代器自动 cancel 未读完的 body。`readCappedText` 不变。

**Verify**: `bun run --filter @agentport/core typecheck` → exit 0；`rg -n 'truncate|onTruncated' packages/core/src/http-body.ts` → 各至少出现 2 处。

### Step 2: 用 core 版本替换本地 `readCapped` 并保留截断标记

当前本地函数在截断时返回 `` `${text.slice(0, max)}\n…[truncated at ${max} chars]` ``，这是用户可见的 tool result 文本，必须保留同样标记。

在 `packages/api/src/modules/servers/generated.ts`：

1. 增加 `import { readCappedText } from '@agentport/core';`。
2. 删除本地 `readCapped` 函数。
3. 调用点改为：

```ts
      const MAX_BODY = 1_048_576;
      let truncated = false;
      let text = await readCappedText(res, MAX_BODY, 'generated tool response', {
        truncate: true,
        onTruncated: () => {
          truncated = true;
        },
      });
      if (truncated) text = `${text}\n…[truncated at ${MAX_BODY} chars]`;
```

保持「超限时返回已读部分、仍把文本放进 tool result」的既有行为；不要改成抛错。标记文本与当前完全一致，不改成 `bytes`，避免改变用户可见输出。

**Verify**: `rg -n 'function readCapped|readCappedText|truncated at' packages/api/src/modules/servers/generated.ts` → 只有 `readCappedText` 调用与一处标记；`bun run --filter @agentport/api typecheck` → exit 0。

### Step 3: 暴露 core `record` 子路径并删除副本

在 `packages/core/package.json` 的 `exports` 增加：

```json
    "./record": {
      "types": "./dist/record.d.ts",
      "default": "./dist/record.js"
    },
```

然后：

- `packages/web/src/lib/data-domain-result.ts`：删除本地 `isRecord`，改为 `import { isRecord } from '@agentport/core/record';`。
- `packages/web/src/components/chat/openui-message.tsx`：删除本地 `isStateRecord`，导入 `isRecord`，原调用点改为 `isRecord`。
- `packages/worker/src/knowledge/source-dingtalk.ts` 与 `source-ima.ts`：导入 `isRecord`，把本地 `recordOf` 函数体改为 `return isRecord(value) ? value : undefined;`（保留 `recordOf` 名称与返回类型，避免改动 17 处调用点）。

不要从 `@agentport/core` 根入口导入到 web。

**Verify**:

```bash
bun run --filter @agentport/shared --filter @agentport/core build
bun run --filter @agentport/core typecheck
bun run --filter @agentport/web typecheck
bun run --filter @agentport/worker typecheck
rg -n "typeof value === 'object' && value !== null && !Array.isArray\(value\)" packages --glob '!node_modules' -g '*.ts' -g '*.tsx'
```

最后一条只应命中 `packages/core/src/record.ts` 与 `packages/core/dist`（若 `dist` 被扫到可忽略）。

### Step 4: 补齐环境变量文档并删除陈旧示例

1. `.env.example` 在 `MODEL_PROVIDER_PRIVATE_HOST_ALLOWLIST` 之后增加：

```bash
# generated 连接器的内网放行（精确 host 或 host:port）
# GENERATED_PRIVATE_HOST_ALLOWLIST=127.0.0.1:11434
```

2. `docs/OPERATIONS.md` 环境变量表在 `MODEL_PROVIDER_PRIVATE_HOST_ALLOWLIST` 之后增加一行，措辞沿用 `docs/SECURITY.md:60`：

```md
| `GENERATED_PRIVATE_HOST_ALLOWLIST` | 否 | 空 | api | 逗号分隔的精确 `host` 或 `host:port`；仅让显式声明的企业内网 HTTP 服务被 generated 连接器访问，未命中的私网、回环与 link-local 目标仍拒绝；不是用户可配置的通用私网开关 |
```

3. 删除 `packages/api/.env.example`（用 `git rm`；先确认没有任何脚本引用它：`rg -n 'packages/api/.env.example|api/.env.example' . --glob '!node_modules'` 无输出）。

**Verify**: `bun run lint:docs` → `docs navigation OK`；`rg -n 'GENERATED_PRIVATE_HOST_ALLOWLIST' .env.example docs/OPERATIONS.md` → 各至少 1 处；`test ! -e packages/api/.env.example` → exit 0。

### Step 5: 完整验证

```bash
bun run --filter @agentport/shared --filter @agentport/core build
bun run --filter @agentport/core typecheck
bun run --filter @agentport/api typecheck
bun run --filter @agentport/web typecheck
bun run --filter @agentport/worker typecheck
bun run test:web
bun run lint:docs
bunx biome check packages/core/src/http-body.ts packages/api/src/modules/servers/generated.ts packages/web/src/lib/data-domain-result.ts packages/web/src/components/chat/openui-message.tsx packages/worker/src/knowledge/source-dingtalk.ts packages/worker/src/knowledge/source-ima.ts
```

全部通过；`test:web` 无失败。

## Test plan

- 不新增测试（根 `AGENTS.md`）。
- `bun run test:web` 覆盖 `data-domain-result` 与 OpenUI 消息解析，必须全绿。
- worker 的知识源解析由现有 `packages/worker/test/knowledge-source-*.test.ts` 覆盖；可选运行 `bun run test -- packages/worker/test/knowledge-source-dingtalk.test.ts` 与 `knowledge-source-expansion.test.ts`。
- `readCapped` 截断行为由代码结构保证；评审重点是比较 `generated.ts` 调用参数带 `{ truncate: true }`。

## Done criteria

- [ ] `generated.ts` 不再有本地 `readCapped`，调用 core `readCappedText` 且带 `{ truncate: true, onTruncated }`
- [ ] 超限输出仍包含完全相同的 `…[truncated at 1048576 chars]` 标记
- [ ] `packages/core/package.json` 暴露 `./record`，web/worker 副本已删除或委托到 core
- [ ] `rg` 的谓词搜索只命中 `packages/core/src/record.ts`
- [ ] `.env.example` 与 `docs/OPERATIONS.md` 均包含 `GENERATED_PRIVATE_HOST_ALLOWLIST`
- [ ] `packages/api/.env.example` 已删除且无引用
- [ ] 五个 typecheck、`test:web`、`lint:docs`、biome 全部通过
- [ ] `git status --porcelain` 只显示 in-scope 文件与 `plans/README.md`

## STOP conditions

Stop and report back (do not improvise) if:

- `generated.ts` 的本地 `readCapped` 或调用点与 excerpt 不一致。
- 有测试或代码依赖 `generated.ts` 在超限时抛出错误（与「静默截断」相反）。
- 添加 `./record` 导出导致 web 构建把 Node 内建带进 bundle（`bun run --filter @agentport/web build` 失败或产物报错）。
- `packages/api/.env.example` 有实际引用（`rg` 有输出）。
- `docs/OPERATIONS.md` 的环境变量表结构已变化，无法按现有列插入。

## Maintenance notes

- 新增浏览器可达的 core 子路径必须保持无 Node 内建；`record.ts` 是纯函数。
- `truncate: true` 是 `generated.ts` 的特例；其他调用方保持默认抛错语义。
- 删除旧 `packages/api/.env.example` 后，环境变量只维护根 `.env.example` 这一份。
