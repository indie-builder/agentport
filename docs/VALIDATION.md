# Fastify × Zod：schema 即契约

> 2026-10-20。记录为什么把请求校验从「handler 内 safeParse」改为「路由 schema 声明」。

## 结论

**schema 是唯一校验点。** 路由声明 `schema`，Fastify 在 handler 之前完成校验；
handler 直接使用 `request.body` / `request.params` / `request.querystring`，类型由 zod 推导。

## 第一性原理

一个 HTTP 请求的校验有三个天然位置：

| 位置 | 谁来保证 | 缺点 |
|---|---|---|
| 客户端 | 前端表单 | 不可信，绕过 curl 即可 |
| handler 内 | 每个 handler 自己 `safeParse` | 39 处重复样板；漏写即无校验；类型要二次断言 |
| **路由边界** | 框架，声明式 | **必写、必执行、类型自动推导** |

只有第三个位置是不可遗漏的：它在路由声明里，和路径、鉴权一样是路由定义的一部分。
前两个位置都是「可选地做对」，第三个是「结构上无法做错」。

## 改动

```ts
// 之前：每个 handler 6 行样板，且 request.body 仍是 unknown
const parsed = serverInputSchema.safeParse(request.body);
if (!parsed.success) {
  return reply.status(400).send({ code: 'INVALID_INPUT', message: ... });
}
const input = parsed.data;

// 之后：校验与类型都在路由声明里完成
app.post('/api/servers', {
  ...auth,
  schema: { body: serverInputSchema },
}, async (request) => {
  // request.body: ServerInput
});
```

## 错误格式

zod 校验失败由 `plugins/errors.ts` 统一映射：

```json
{ "code": "INVALID_INPUT", "message": "<zod issue message>", "requestId": "req-1", "path": "name" }
```

这条规则是**唯一**的校验失败出口，handler 里不再出现手工 400（业务规则冲突仍用 4xx，但那是业务错误，不是格式错误）。

## 共享文案与通配参数

`packages/shared/src/index.ts` 在入口统一 `z.config(z.locales.zhCN())`；所有从 shared 取 schema 的进程默认输出中文校验文案，`Problem.message` 不必在各路由重复翻译。

Fastify 通配路由的 `*` 段同样属于路由 schema：技能文件写入用 `skillFileInputSchema.shape.path` 校验，`..`、绝对路径和非法字符在进入 handler 前返回 `INVALID_INPUT`（`path: '/*'`），handler 不再对同一输入 `safeParse`。

鉴权的 `requireAuth` 未登录时抛 `AppError('UNAUTHORIZED')` 而不是直接写响应；preHandler 抛出会真正停止后续 handler，401 仍由 `plugins/errors.ts` 统一渲染成 Problem。

## 分工

- **请求校验**：路由 `schema`（body / params / querystring）。
- **业务规则**：handler 内显式返回（slug 冲突 409、引用不存在 404/400、SSRF 400）。
- **响应校验**：可选的 `response` schema；开启后序列化失败返回 500 `RESPONSE_INVALID`，用于尽早发现字段漂移。

## 不接受的做法

- 不写兼容层（例如把两种错误格式都返回）。
- 不在 handler 里保留 `safeParse` 作为「兜底」——那会让唯一校验点重新变成可选项。
- 不为旧响应格式保留 shim；前端与测试按新契约对齐。

## 专家标准岗位

`packages/shared/src/agent.ts` 的 `AGENT_ROLES` 是创建、编辑与导入共用的岗位目录；`agentRoleSchema` 在路由边界拒绝未登记岗位，空值或缺省值规范为「通用助手」。PATCH 未传角色时保持原值，不套用创建默认值。数字分身使用目录中的「数字分身」。扩展岗位需同步共享目录、头像映射及选择器验证。

数据库继续使用 text 存储岗位，默认值为「通用助手」；迁移 `0023_round_black_widow.sql` 只补齐空白岗位，不推断已有专家的职业。读取历史岗位保持原文；回滚遇到缺失或未登记的历史角色时，保留当前岗位，避免旧版本抹掉新配置。旧导出缺少角色时仍可导入，含未登记岗位的文件会明确返回校验错误。

## 唯一例外：导入导出的 `config`

`packages/api/src/features/import/routes.ts` 的 `toServerInput()` 会调用一次 `serverInputSchema.safeParse`。
原因：导入条目的 `config` 是用户提交的**开放 JSON 记录**（远端 MCP server 的 JSON Schema），
它的字段集合在运行时才知道，无法作为路由 `schema` 的一部分声明。这一行是该入口的**边界校验**：
解析失败等价于「格式不合法」，用 `fail('INVALID_INPUT', …)` 返回，仍由 `plugins/errors.ts` 转成统一的
`INVALID_INPUT` Problem，不产生第二种错误格式。

规则因此仍然成立：**路由层面没有 `safeParse`**，唯一的前置校验点仍是路由 `schema`；handler 内的
`safeParse` 只用于把开放 JSON 收窄成已知类型，而不是补路由漏写的校验。新增类似场景时，同样需要
在类型层无法表达的前提下才允许，并在代码注释里写明原因。

## 知识库上传与内容入口

知识库的写入口都在路由 `schema` 上完成校验，不新增第二套解析约定：

| 入口 | 形状 | 边界 |
|---|---|---|
| `PUT /api/knowledge/bases/:id/documents/upload` | JSON `{ filename, mimeType, dataBase64, title?, folderId }` | 路由级 `bodyLimit` 48 MiB；base64 解码后超过 32 MiB 返回 `PAYLOAD_TOO_LARGE`；解码后重新编码比对，非法 base64 不写盘 |
| `POST /api/knowledge/bases/:id/documents/manual` | `{ title, content, folderId, tags }` | 正文最多 200,000 字符，路由级 `bodyLimit` 2 MiB |
| `POST /api/knowledge/bases/:id/documents/url` | `{ url, title?, folderId? }` | URL 先经 `assertSafeUrl`；重定向直接拒绝（要求填最终地址），只接受可解析的文本类 MIME，响应上限 32 MiB |
| `POST /api/knowledge/bases/import` | `application/zip` 二进制 | 路由级 `bodyLimit` 64 MiB；包内路径、条目数、解压总量与 sha256 在解压前/后分别校验，拒绝绝对路径、`..`、链接和重复成员；`manifest.json` 是开放 JSON，由 `package.ts` 在 handler 内 `safeParse` 收窄 |
| 内置知识 MCP 工具参数 | MCP JSON，非 Fastify 路由 | `features/knowledge/mcp.ts` 在 handler 内 `safeParse` 工具参数：这里没有路由 schema 可挂，且必须把非法参数转成工具错误而不是 HTTP 400 |

知识包在文件写入和导入事务前校验清单引用及唯一性：库内标签名、文档内版本号、版本内分块序号、Wiki 页内版本号与版本 ID、同页非空分块引用不得重复；各集合在所属作用域内独立判断。重复值返回 `INVALID_INPUT`，不等数据库约束冲突后再报错。

上传的文件类型不在入口做格式白名单（除 URL 导入按可解析类型过滤）：格式判定在 worker 的解析链完成，不支持的格式以任务失败明确报出；PDF/Office/OCR 需要配置 `DOCLING_URL`，未配置时不会静默降级。知识库连接本身也不走用户 CRUD：`serverInputSchema` 不含 `kind='knowledge'`，内置连接只能由知识库生命周期创建。`knowledgeSourceInputSchema` 的 `ranges` 是 `.min(1)`，所以范围为空在路由校验阶段就返回 `INVALID_INPUT`，handler 不再二次判空。

图片多模态入口复用上述上传与模型配置：库设置 `imageProcessing` 在共享 Zod schema 完成开关、模型、动作与相似度范围校验，启用需模型且 OCR/描述至少一项。profile 的 `embeddingProtocol`/`imageInputEnabled` 有数据库 check，图片输入仅适用于已实现的 Cohere v2 `embed-v4.0` 协议。模型响应严格校验有限数、条数及1024维，不截断/拼接向量。

`knowledge_read_image` 接受 chunkId 和 description/image 格式，不接受任意路径或URL；再按绑定库→当前可见文档/版本→启用chunk→版本图片清单读取。原图以 MCP 原生 image content 返回，MIME与单图5MiB限制独立校验；描述结果仍为JSON text以保存引用。图片metadata导入须与同版本图片清单对应，向量数值不进知识包，图片向量子块身份需保留以恢复索引。

2026-10-25 的实际状态：上传、手写、URL 导入、来源同步与内置 MCP 的**自动**测试已覆盖对应断言；多模态实际SDK/CLI+本地协议夹具及页面链验证见 [实施记录](tasks/knowledge-multimodal-implementation.md)。真实 Docling /视觉模型/ Cohere / embedding / rerank / 飞书 / GitLab 尚未用真实服务或凭证验证，不能用 fixture 通过代替质量验收。
