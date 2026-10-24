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

这条规则是**唯一**的校验失败出口，handler 里不再出现手工 400（业务规则冲突仍用 4xx，但那是业务错误，不是格式错误）。

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

## 导入入口的开放 JSON 收窄

`packages/api/src/features/import/routes.ts` 的 `toServerInput()` 会调用一次 `serverInputSchema.safeParse`。
原因：导入条目的 `config` 是用户提交的**开放 JSON 记录**（远端 MCP server 的 JSON Schema），
它的字段集合在运行时才知道，无法作为路由 `schema` 的一部分声明。这一行是该入口的**边界校验**：
解析失败等价于「格式不合法」，用 `fail('INVALID_INPUT', …)` 返回，仍由 `plugins/errors.ts` 转成统一的
`INVALID_INPUT` Problem，不产生第二种错误格式。

同一入口的 zip 归档路由（`POST /api/import/agents/archive`）有第二个同类边界：
`archiveImportBody()` 把 core `parseWorkspaceArchive` 的结果映射成 `agentport/agent@2` 后，
用 `importBodySchema.parse` 收窄一次（再交给同一个导入事务）。归档同样是用户可控输入，
因此不能仅靠 TypeScript 断言；失败统一转成 `INVALID_INPUT`。base64 由路由 schema 限制为
1,500,000 字符，解码必须是标准、规范的 base64（长度 4 的倍数、无空白/URL-safe 字符、
重新编码后与原文一致），否则 `INVALID_INPUT`。压缩包限额与错误语义见 `docs/ARCHITECTURE.md`
「智能体归档（zip）导入导出」。

规则因此仍然成立：**路由层面没有 `safeParse`**，唯一的前置校验点仍是路由 `schema`；handler 内的
`safeParse` / `parse` 只用于把开放 JSON 或文件内容收窄成已知类型，而不是补路由漏写的校验。
新增类似场景时，同样需要在类型层无法表达的前提下才允许，并在代码注释里写明原因。
