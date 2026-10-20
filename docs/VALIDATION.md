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

## 分工

- **请求校验**：路由 `schema`（body / params / querystring）。
- **业务规则**：handler 内显式返回（slug 冲突 409、引用不存在 404/400、SSRF 400）。
- **响应校验**：可选的 `response` schema；开启后序列化失败返回 500 `RESPONSE_INVALID`，用于尽早发现字段漂移。

## 不接受的做法

- 不写兼容层（例如把两种错误格式都返回）。
- 不在 handler 里保留 `safeParse` 作为「兜底」——那会让唯一校验点重新变成可选项。
- 不为旧响应格式保留 shim；前端与测试按新契约对齐。
