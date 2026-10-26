# 手写逻辑简化：第二轮

## 目标

基于现有代码和依赖寻找能提高稳定性、响应速度并减少维护逻辑的调整。用户授权修改、提交 PR 并合并，确认合入后删除任务 worktree、更新主 checkout 的 main。

## 方案

Opus 按知识处理与前端订阅两个文件域并行只读探索；确定收益与契约后由 Sonnet 实现，交独立 Opus 评审，按范围验证并交付。不新增等价执行框架，不为抽象而改造。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/native-logic-round-2`
- 分支：`refactor/native-logic-round-2`
- 起始提交：`c8cf1fd5dc13f9c5520953defe150db0eb64760f`（创建时最新 origin/main）。
- 初始未提交差异：空。
- A 域（知识源 feed 解析）固定为：`packages/worker/src/knowledge/sources.ts`、`packages/worker/test/knowledge-sources.test.ts`、本任务记录。其他文件不改；前端候选如实施由另一代理改独立文件。
- 前端引用弹窗候选本轮不采用：维持每次打开的权限复查、取消和错误展示需要额外查询选项，收益不足以抵消复杂度。
- 第一轮 PR #48 已合并，取消等待、IPv4 BlockList、useAgent select 不重复改造。
- `skill-provenance` worktree 属其他任务，不修改或清理。

## 当前有效决定

- 用户已授权本轮 commit/push/PR/merge，无需再次确认。本次评审修复轮按要求不提交，复核通过后按既有授权处理。
- 主会话仅定契约、派发、审查与验证；源码和测试由 Sonnet 执行子代理完成。执行子代理不再派发、不自行提交；这些是任务分工，不改变用户的提交合并授权。
- 独立评审通过才提交；CI 仅手动，不触发、不等待、不监控。
- 不改共享服务、数据库、配置和登录态。若需集成测试使用本轮独立实例。
- A 域只保留一处格式分派：`source.trimStart().startsWith('{')` 时直接 `parseJsonFeed(source)`，其余交 `parseFeed(source)`；仍不信任 `Content-Type`，之后按 `format` 判别联合 `json | atom | rss | rdf` 直接读库字段。删除 `contentType` 参数与读取、`feedText` / `feedLink`、自造类型断言，保留原生字段联合。
- 该分派是库已知限制下的例外，不是恢复旧的按响应头手工分派：3.0.1 的通用 `parseFeed` 先按正则扫描 XML 标签，合法 JSON 条目的 `content_html` / `content_text` 里出现 `<rss>` 等示例代码时会被误判为 XML 并抛 `ParseError`；官方 https://feedsmith.dev/parsing 也建议已知格式用专用解析器。不能用对象输入绕过（官方未文档化 `parseFeed` 接受对象）。
- 必须保真的行为：externalId 计算（含 RSS 空 link 不回落 title、JSON 数字 id 转字符串）、链接优先级、正文/summary 回退、凭证只发源 origin、重复文档路径与游标策略。
- RDF 类型以已安装 3.0.1 `dist/feeds/rdf/common/types.d.mts` 为准：item 有 `title?`、`link?`、`description?`、`content?.encoded?`、`rdf?.about?`，没有 `guid`；保真沿用现有 `link` 决定 id 的语义。

## 已替代项及原因

- A 域旧实现：按 `Content-Type` / 首字符手工分派 `parseJsonFeed`，再对 `parseFeed` 结果做自造类型断言并用 `feedText` / `feedLink` 兜底。已替代为只按内容首字符识别 JSON、其余交 `parseFeed`，再按 `format` 判别联合直接读库字段；旧做法会在响应头与内容不一致时选错解析器（错误 Content-Type 的 RSS 直接失败），且重复维护库字段映射。保留首字符分派仅因通用 `parseFeed` 会误判正文内嵌 XML 的合法 JSON，见上条。

## 步骤

- [x] 同步 origin/main，创建隔离工作区并记录基线
- [x] 安装锁定依赖，构建 shared/core/db
- [x] 只读探索并固定 A 域范围
- [x] 补假 HTTP 服务测试并确认旧实现为红
- [x] A 域实现（JSON 首字符分派 + 判别联合）
- [x] knowledge-sources / knowledge-connector 定向测试、worker typecheck、格式
- [x] 独立 Opus 评审（首轮发现 JSON/XML 误判；修复后独立复核通过，无阻断项）
- [x] 范围验证
- [ ] 提交、创建 PR 并合并
- [ ] 清理任务 worktree、更新 main

## 改动文件

- `docs/tasks/native-logic-round-2.md`
- `packages/worker/src/knowledge/sources.ts`（+25 / -68，净 -43）
- `packages/worker/test/knowledge-sources.test.ts`（+127）

## 下一步

实现、最终验证与 Opus 独立复核均通过，无阻断项。按用户授权提交、创建并合并 PR，随后清理本树并更新 main；实际合并和清理结果以 GitHub/Git 状态为准。

## 验证

- `git rev-parse HEAD`：上述基线提交；创建时 `git status --short` 无输出。
- `pnpm install --frozen-lockfile` 与 shared/core/db build：通过，退出码 0。
- 主会话复验：两文件 30 项测试通过；worker build、typecheck、两文件 Biome 与 `git diff --check` 通过。
- 测试通过本地假 HTTP 服务覆盖实际请求和解析，不连接数据库或共享服务；未做完整产品 E2E 或真实外部订阅源验收，不声称量化提速。
- 本轮未发现涉及的产品代码与文档冲突。
- 红：`pnpm exec vitest run packages/worker/test/knowledge-sources.test.ts` → 1 failed / 22 passed；失败点为新增 `detects the feed format from content when Content-Type disagrees`，旧实现 `parseJsonFeed` 抛 `DetectError: Invalid feed format`（sources.ts:398）。
- 绿：同一文件 → 23 passed。
- 评审阻断复现红：`-t "parses JSON feeds whose content embeds XML markup"` → 1 failed，通用 `parseFeed` 对正文含 `<rss><channel><title>Example</title>` 的合法 JSON 抛 `ParseError: Invalid feed format`（sources.ts:371）。
- 修复后绿：同一用例通过；`knowledge-sources.test.ts` + `knowledge-connector.test.ts` → 2 files / 30 tests passed。
- `pnpm --dir packages/worker build`（`tsc -b`）与 `pnpm --dir packages/worker typecheck` → 退出码 0，无输出。
- `biome check` 两个改动文件 → 通过，无修复项。
