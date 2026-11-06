# HTTP 校验：契约即边界

> 记录请求校验的位置选择。校验点必须在入口，不能散落在 handler；oRPC 过程用 contract input，原生 HTTP 边界单独校验。

## 结论

**输入 schema 是唯一校验点。** oRPC contract 声明 input，框架在 handler 之前完成校验；handler 直接使用 `input.params`、`input.query`、`input.body`，类型由 zod 推导。

原生 HTTP 边界（better-auth、`/mcp`、SSE、文件与 ZIP 下载、知识库上传）不经过 oRPC，由对应的 `http.ts` 在产生副作用前完成校验。两类入口都不在业务 handler 里补一层 `safeParse`。

## 第一性原理

一个 HTTP 请求的校验有三个天然位置：

| 位置 | 谁来保证 | 缺点 |
|---|---|---|
| 客户端 | 前端表单 | 不可信，绕过 curl 即可 |
| handler 内 | 每个 handler 自己 `safeParse` | 重复样板；漏写即无校验；类型要二次断言 |
| **入口声明** | 框架，声明式 | **必写、必执行、类型自动推导** |

只有第三个位置是不可遗漏的：它在契约或原生路由声明里，和路径、鉴权一样是入口定义的一部分。前两个位置都是「可选地做对」，第三个是「结构上无法做错」。

## 契约声明

```ts
export const serversContract = {
  create: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'servers.create' } })
    .route({ method: 'POST', path: '/servers', successStatus: 201 })
    .input(z.object({ body: serverInputSchema }))
    .output(serverSchema),
};
```

handler 只读已校验的值：

```ts
create: os.create.handler(async ({ context, input }) => {
  const principal = requireUser(context);
  await authorize(context, 'servers.create');
  return createServer(context, input.body);
}),
```

- 契约路径不带 `/api`，由 `src/routes/index.ts` 统一挂到 `/api`；对外 REST 方法与路径保持不变。
- oRPC 使用原生 `detailed` 输入结构，字段按实际入口选 `params`、`query`、`body`。没有的项不写。
- 需要限流的入口在 `.meta()` 声明 `rateLimit`，不在 handler 内重复计数。

## 错误格式

zod、oRPC 与 Hono 的校验错误由 `packages/api/src/http/errors.ts` 统一映射成 shared 的 `Problem`：

```json
{
  "code": "INVALID_INPUT",
  "message": "<zod issue message>",
  "status": 400,
  "requestId": "req-1",
  "retryable": false,
  "path": "/name",
  "errors": [{ "path": "/name", "message": "<zod issue message>" }]
}
```

这条规则是**唯一**的校验失败出口。业务规则冲突仍用 4xx，但那是业务错误，不是格式错误。

## 共享文案与通配参数

`packages/shared/src/index.ts` 在入口统一 `z.config(z.locales.zhCN())`；所有从 shared 取 schema 的进程默认输出中文校验文案，`Problem.message` 不必在各路由重复翻译。

技能文件的通配路径 `PUT /api/skills/:id/files/*` 在契约里用 `{+path}` 和 `skillFileInputSchema.shape.path` 校验；`..`、绝对路径和非法字符在进入 handler 前返回 `INVALID_INPUT`，handler 不再对同一输入 `safeParse`。

鉴权的 `requireUser` 未登录时抛 `AppError('UNAUTHORIZED')`，`http/errors.ts` 渲染成 401 `Problem`，不直接写响应。

## 原生 HTTP 边界

不经过 oRPC 的入口在 `http.ts` 注册，按同一原则在 handler 之前校验：

| 入口 | 校验位置 |
|---|---|
| better-auth 登录、账户与会话 | `modules/auth/routes.ts` 用契约导出的 zod schema 解析请求体 |
| `/mcp`、`/mcp/:serverId` | MCP 协议自己解析 JSON-RPC；Bearer 与 run token 在进入 handler 前校验 |
| SSE | 路径参数与查询参数在读取事件流前校验 |
| 文件、ZIP 下载与上传 | `bodyLimit`、`Content-Type`、路径 schema 与包内清单校验先于写盘或入队 |

## 分工

- **请求校验**：oRPC contract input，或原生入口的显式 schema。
- **业务规则**：handler 内显式抛 `AppError`（slug 冲突 409、引用不存在 404/400、SSRF 400）。
- **响应校验**：契约声明 `output`；不符返回 500 `RESPONSE_INVALID`，用于尽早发现字段漂移。

## 不接受的做法

- 不写兼容层（例如把两种错误格式都返回）。
- 不在 handler 里保留 `safeParse` 作为「兜底」，那会让唯一校验点重新变成可选项。
- 不为旧响应格式保留 shim；前端与测试按新契约对齐。

## 专家标准岗位

`packages/shared/src/agent.ts` 的 `AGENT_ROLES` 是创建、编辑与导入共用的岗位目录；`agentRoleSchema` 在契约边界拒绝未登记岗位，空值或缺省值规范为「通用助手」。PATCH 未传角色时保持原值，不套用创建默认值。数字分身使用目录中的「数字分身」。扩展岗位需同步共享目录、头像映射及选择器验证。

数据库继续使用 text 存储岗位，默认值为「通用助手」；迁移 `0023_round_black_widow.sql` 只补齐空白岗位，不推断已有专家的职业。读取历史岗位保持原文；回滚遇到缺失或未登记的历史角色时，保留当前岗位，避免旧版本抹掉新配置。旧导出缺少角色时仍可导入，含未登记岗位的文件会明确返回校验错误。

## 唯一例外：导入导出的 `config`

`packages/api/src/modules/agents/package.ts` 的 `toServerInput()` 会调用一次 `serverInputSchema.safeParse`。原因：导入条目的 `config` 是用户提交的**开放 JSON 记录**（远端 MCP server 的 JSON Schema），字段集合在运行时才知道，无法作为契约 input 的一部分声明。这一行是该入口的**边界校验**：解析失败等价于「格式不合法」，用 `fail('INVALID_INPUT', …)` 返回，仍由 `http/errors.ts` 转成统一的 `INVALID_INPUT` Problem，不产生第二种错误格式。

规则因此仍然成立：**契约层面没有 `safeParse`**，唯一的前置校验点仍是入口 schema；handler 内的 `safeParse` 只用于把开放 JSON 收窄成已知类型，而不是补入口漏写的校验。新增类似场景时，同样需要在类型层无法表达的前提下才允许。

## 知识库上传与内容入口

知识库的写入口都在各自的校验点完成，不新增第二套解析约定：

| 入口 | 形状 | 边界 |
|---|---|---|
| `PUT /api/knowledge/bases/:id/documents/upload` | JSON `{ filename, mimeType, dataBase64, title?, folderId }` | 原生入口 `bodyLimit` 48 MiB；base64 解码后超过 32 MiB 返回 `PAYLOAD_TOO_LARGE`；解码后重新编码比对，非法 base64 不写盘 |
| `POST /api/knowledge/bases/:id/documents/manual` | `{ title, content, folderId, tags }` | 正文最多 200,000 字符，入口 `bodyLimit` 2 MiB |
| `POST /api/knowledge/bases/:id/documents/url` | `{ url, title?, folderId? }` | URL 先经 `assertSafeUrl`；重定向直接拒绝（要求填最终地址），只接受可解析的文本类 MIME，响应上限 32 MiB |
| `POST /api/knowledge/bases/import` | `application/zip` 二进制 | 入口 `bodyLimit` 64 MiB；包内路径、条目数、解压总量与 sha256 在解压前/后分别校验，拒绝绝对路径、`..`、链接和重复成员；`manifest.json` 是开放 JSON，由 `package.ts` 在 handler 内 `safeParse` 收窄 |
| 内置知识 MCP 工具参数 | MCP JSON，非 oRPC 过程 | `modules/knowledge/mcp.ts` 在 handler 内 `safeParse` 工具参数：这里没有契约 input 可挂，且必须把非法参数转成工具错误而不是 HTTP 400 |

知识包在文件写入和导入事务前校验清单引用及唯一性：库内标签名、文档内版本号、版本内分块序号、Wiki 页内版本号与版本 ID、同页非空分块引用不得重复；各集合在所属作用域内独立判断。重复值返回 `INVALID_INPUT`，不等数据库约束冲突后再报错。

上传的文件类型不在入口做格式白名单（除 URL 导入按可解析类型过滤）：格式判定在 worker 的解析链完成，不支持的格式以任务失败明确报出；PDF/Office/OCR 需要配置 `DOCLING_URL`，未配置时不会静默降级。知识库连接本身也不走用户 CRUD：`serverInputSchema` 不含 `kind='knowledge'`，内置连接只能由知识库生命周期创建。`knowledgeSourceInputSchema` 的 `ranges` 是 `.min(1)`，所以范围为空在入口校验阶段就返回 `INVALID_INPUT`，handler 不再二次判空。

图片多模态入口复用上述上传与模型配置：库设置 `imageProcessing` 在共享 Zod schema 完成开关、模型、动作与相似度范围校验，启用需模型且 OCR/描述至少一项。profile 的 `embeddingProtocol`/`imageInputEnabled` 有数据库 check，图片输入仅适用于已实现的 Cohere v2 `embed-v4.0` 协议。模型响应严格校验有限数、条数及 1024 维，不截断或拼接向量。

`knowledge_read_image` 接受 chunkId 和 description/image 格式，不接受任意路径或 URL；再按绑定库、当前可见文档/版本、启用 chunk、版本图片清单读取。原图以 MCP 原生 image content 返回，MIME 与单图 5 MiB 限制独立校验；描述结果仍为 JSON text 以保存引用。图片 metadata 导入须与同版本图片清单对应，向量数值不进知识包，图片向量子块身份需保留以恢复索引。

2026-10-25 的实际状态：上传、手写、URL 导入、来源同步与内置 MCP 的**自动**测试已覆盖对应断言；多模态实际 SDK/CLI + 本地协议夹具及页面链验证见实施记录。真实 Docling、视觉模型、Cohere、embedding、rerank、飞书、GitLab 尚未用真实服务或凭证验证，不能用 fixture 通过代替质量验收。
