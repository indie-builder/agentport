# 成果图片预览：按版本读取文件元数据

## 目标

为会话成果的图片预览补齐“按版本取元数据 + 鉴权取字节 + 解码成功才显示”的完整能力：

- API：`GET /api/conversations/:id/outputs/:runId?path=...` 返回 `{ file: OutputFile }`，让前端在列表分页之外按 `runId + path` 精确取得某一版文件的元数据（大小、类型、sha256、创建时刻、状态与消息锚点）。
- Web 会话成果面板：图片通过鉴权下载端点取 Blob，只有浏览器真正 decode 成功才显示；列表未覆盖的旧版先取真实元数据再决定预览方式；版本选择按倒序位置命名并具备单选语义。
- Web 公开分享页：图片分享同样走 Bearer 下载 + `BlobImage`，解码失败保留原件下载。
- 元数据接口仍只返回 `file` 元数据，不返回正文；下载与正文接口语义不变。

验收：

- 未登录 401；未知会话 404（`CONVERSATION_NOT_FOUND`）。
- 正确版本返回完整 `OutputFile`，含既有 `userMessageId`/`afterMessageId` 锚点。
- 已被列表分页排除的旧版本，仍按 `runId + path` 返回该版元数据。
- 缺成员、跨会话、非法路径与不存在的版本按现有 `INVALID_INPUT`/`NOT_FOUND` 契约拒绝。
- 响应体只有 `file` 元数据，不含 `content` 或正文；文件字节只在 handler 内被读取用于校验 manifest 成员，不会出现在响应里。
- 不泄露其他会话或其他路径的文件。
- 会话成果与公开分享页的图片在 decode 前不显示；损坏字节给出真实错误并保留下载。
- 同一秒内的多版图片可通过版本菜单的可访问名区分，选中旧版后 URL、Blob、下载、分享与“基于此版本修改”引用都指向该版。

## 能力文件域（真实）

- `packages/api/src/features/chat/outputs.ts`：新增认证元数据路由，复用 `readOutputFile`。
- `packages/api/test/outputs-routes.test.ts`：元数据路由的成功、鉴权、错误映射与不泄露正文断言。
- `packages/web/src/components/conversation-outputs.tsx`：会话成果的图片预览、分页外旧版元数据回退、版本选择与位置标签。
- `packages/web/src/components/blob-image.tsx`：Blob 解码成功才显示，换图/卸载释放对象 URL，失败给出可下载提示。
- `packages/web/src/lib/api.ts`：新增 `outputFile` 与 `outputBlob` 请求。
- `packages/web/src/lib/queries.ts`：新增 `useOutputFile` 与 `useOutputBlob`。
- `packages/web/src/routes/s.$shareId.tsx`：公开分享图片改用 `BlobImage`。
- `packages/web/test/chat-outputs.test.ts`：图片预览、版本切换、旧版元数据、版本标签与各动作绑定。
- `packages/web/test/public-share.test.ts`：公开分享图片 decode 成功/失败与 Bearer 下载。
- `docs/tasks/image-output-preview-20261030.md`：本任务记录。

## 方案

### API

- 路由放在 `packages/api/src/features/chat/outputs.ts` 的 `registerOutputRoutes` 内，复用现有 `ownerParams`/`fileParams`/`fileQuery`、`requireAuth`、`getConversation`/`agentSlug`、`conversationNotFound`、`selectionProblem` 与 `readOutputFile`。
- handler 复用 `readOutputFile`，但只返回其中的 `file`；该函数本身会整份读取所选文件字节以校验 manifest 成员（与既有 `checkOutputSelection` 同一代价），handler 不回正文、不追加大小/类型限制或缓存头，这些仍属于 `content`/`download` 路由。这条“整份读取仅返回元数据”的既有代价作为事实保留，本轮不改 core 读取入口。
- 路径为 `/outputs/:runId`，与既有 `/outputs/:runId/content|download` 是不同静态尾段，不冲突。
- 不新增共享 schema：`OutputFile` 已存在；不新增 core 读取入口，`readOutputFile` 已按 manifest 成员白名单返回元数据。
- 不新增 db schema/迁移、不改分享权限、不新增公开无鉴权入口。

### Web 会话成果

- 列表元信息命中选中版本时直接按 `mediaType` 决定预览；列表分页外再启用 `useOutputFile` 取真实元数据，拿到类型前不猜文本、不预取正文。
- 图片走 `useOutputBlob` → 鉴权 `download` 端点，`BlobImage` 在 decode 成功前保持占位，并按当前 Blob 绑定对象 URL。
- 版本菜单复用 `DropdownMenuRadioGroup`/`DropdownMenuRadioItem`，`value = selection.runId`，由原语提供 `role="menuitemradio"` 与 `aria-checked`；触发器保留 `aria-label="选择版本"`。
- 版本标签按已加载数组倒序位置生成：`最新 · 时间` / `上一版 · 时间` / `前 2 版 · 时间`，时间文本仍用现有 `formatDateTime`；分页只追加更旧版本，已有位置不变。当前版本不在已加载列表时触发器只显示已取得的真实 `createdAt`，不编造位置，加载到后再给位置标签。
- 不改全站时间精度、内部 `runId` 展示、API 或 schema。

### Web 公开分享页

- 公开分享图片使用 Bearer 下载的 Blob 交给 `BlobImage`；文本仍走内容接口，PDF 与其它非图片格式沿用既有行为。
- 本轮仅把公开页图片换成共享 `BlobImage`，原有 PDF iframe 预览未改；公开 PDF 旧行为保留，但本轮未重新验收。
- 解码失败显示“图片无法解码，请下载原件查看。”并保留再次下载。
- 私有会话成果只新增 PNG/JPEG/GIF/WebP 预览，PDF/Office 等仍下载；不声称全站 PDF 只下载。

## 基线与范围

- 起始 commit：`5546502`（`main`，PR #120 动效合并后的当前基线）；当前分支 `loop-capability-image-preview-01`。
- 工作区初始干净。
- 本能力允许改动的文件即上文「能力文件域（真实）」列出的 10 个文件。
- 不改：`packages/core`、`packages/shared`、`packages/db`、`packages/worker`、迁移、分享路由权限；本轮执行子代理的源码写域仅为 `packages/web/src/components/conversation-outputs.tsx`，测试写域为 `packages/web/test/chat-outputs.test.ts`，文档为本文件。

## 当前有效决定

- 用户本轮授权实现、验证与 review；执行子代理不 commit。
- 元数据接口复用 `readOutputFile` 并只返回 `file`；读取函数会整份读取所选文件字节以校验 manifest 成员，但响应不含正文，也不改变下载与正文语义。代价与既有 `checkOutputSelection` 一致（core 目前没有只查索引的入口），当前单管理员按需选择可接受；若未来大文件实测有问题，再评估 core 元数据索引，不在本轮扩大范围。
- 错误映射沿用 `selectionProblem`：core 的 `NOT_FOUND` 对入口视为选择无效（`INVALID_INPUT`），与「基于此版本修改」一致。
- 版本标签按倒序数组位置生成，不使用 `v1/v2` 全局序号；分页追加不重排已有标签。
- 菜单使用单选原语而不是可点击文本项；触发器显示与菜单一致的当前版本标签。
- 格式范围：私有成果仅新增 4 种图片预览，PDF/Office 仍下载；公开页原有 PDF iframe 预览未改，本轮只替换 image 为共享 `BlobImage`。
- 交付状态：三轮 review 与最终浏览器验收均通过；源码已提交 `e4d414d` 并推送到 `origin/loop-capability-image-preview-01`，未合并 `main`；本文档微调未提交。`nextDue` 由主线程在实际合并后计算，不创建 cron/state，不改源码。

## 已替代项及原因

- 原版本下拉用纯 `formatDateTime` 文本项：同一秒内的多版时间文本相同，无法区分，也没有 checked 语义；已替换为位置标签 + `DropdownMenuRadioGroup`/`DropdownMenuRadioItem`。
- 原公开分享页图片用 `<img src=objectURL>` 直接显示：损坏字节仍会挂载图片；已替换为 `BlobImage` 的解码门控。

## 步骤

- [x] 先写 API 行为测试并确认因路由缺失而失败（3 条新断言均为 404 Route not found）。
- [x] 在同一路由文件新增认证 GET 路由，最小实现。
- [x] 补齐 Web 会话成果与公开分享的图片预览、旧版元数据回退与 `BlobImage`。
- [x] 按 review2 必修先写版本标签/单选行为测试并确认失败，再实现位置标签与 radio 菜单。
- [x] 跑 outputs 相关测试、web typecheck 与 biome，记录真实结果。
- [x] 完成第三轮 Opus 独立复核 `a9c2e499b17d5672d`，无 mustfix。
- [x] 版本菜单新 UI 的真实浏览器验收 `a7090b402c75b1cb1` 通过。

## 独立评审

- 第一轮：API 与 Web 两个 Opus 独立评审均通过，无 mustfix。
- 第二轮：Web 侧提出版本选择 mustfix——同一秒内多版标签相同、菜单项缺少单选 checked/aria、触发器未显示版本位置标签。本轮已按固定契约修复：位置标签、`DropdownMenuRadioGroup`/`RadioItem`、`value=runId`、触发器同标签，并补先红后绿行为测试。
- 第三轮：Opus 独立复核 `a9c2e499b17d5672d` 通过，无 mustfix；86 条定向用例复测通过。
- 三轮 review 均已完成；源码已提交 `e4d414d` 并推送到分支 `loop-capability-image-preview-01`，未合并 `main`；本文档微调未提交。最终浏览器验收通过后仍未合并，`nextDue` 由主线程在实际合并后计算。

## 验证

- 本轮红：`pnpm vitest run --config packages/web/vitest.config.ts packages/web/test/chat-outputs.test.ts -t "labels versions by position"` → 1 failed，失败原因为触发器仍是纯时间 `10/28 18:00`，且菜单没有 `menuitemradio`/“上一版”标签。
- 本轮绿：同一命令 → 1 passed。
- 本轮回归：`pnpm vitest run --config packages/web/vitest.config.ts packages/web/test/chat-outputs.test.ts packages/web/test/public-share.test.ts packages/web/test/output-share.test.ts` → 3 files / 86 passed（chat-outputs 74、public-share 7、output-share 5），0 failed。其中包含同一路径分页追加更旧版本后，已有两项仍为「最新」「上一版」、新项为「前 2 版」的断言。
- `pnpm --filter @agentport/web typecheck`（`tsc -b`）→ exit 0。
- `node_modules/.bin/biome check packages/web/src/components/conversation-outputs.tsx packages/web/test/chat-outputs.test.ts` → `Checked 2 files … No fixes applied.`，exit 0。
- `git diff --check` → 无输出，exit 0。
- 第三轮复核后主线程回归：full web 118 个文件 / 1396 条用例通过，39.32s；API 与 Web typecheck、build 通过；backend 18 通过。
- 第一轮历史结果（评审记录，不累加）：web 定向 79、full 1394、backend 18。
- 真实浏览器验收（`a7090b402c75b1cb1`）通过：两 PNG 同秒间隔 62ms，按可访问名区分「上一版」，菜单唯一 checked，触发器显示上一版；选中旧版后 URL、图片 64×64 红像素、下载 168B `sha=ca96adb5…` 均指向旧 run；UI 分享 POST 旧 run/path，公开页旧图红色且 hash 一致；「基于此版本修改」引用 Zustand 精确旧 run/path 且不发送模型，取消引用后清理；菜单与分享关闭回焦；6 次快速切版共 32 采样 0 不一致；临时 conversation/messages/runs/shares 全 0，workspace 清理、agent 保留 enabled；公开清理后 404。
- 保留项：元数据接口仍整份读取文件字节；坏图、大图/超大图与 HTML 在真实浏览器中的表现未测（大图内存表现作为后续观察点）；列表分页外旧版由单测覆盖，未在浏览器重测。

## 限制与待办

- 元数据接口仍整份读取文件字节，代价与既有 `checkOutputSelection` 相同；未做只查索引的 core 入口。
- 历史 full 1394 不再作为本轮结果；以本轮 full web 118 文件 1396 用例 39.32s、API/Web typecheck/build 与 backend 18 为准。
- 版本菜单新 UI 的真实浏览器验收 `a7090b402c75b1cb1` 已通过；源码提交 `e4d414d` 并推送分支，未合并 `main`；本文档微调未提交；`nextDue` 由主线程在实际合并后按完成时刻 + 30 分钟计算，不创建 cron/state，不改源码。
- 坏图、大图/超大图与 HTML 在真实浏览器中的表现未测；列表分页外旧版由单测覆盖。
- 格式范围：私有会话成果仅新增 PNG/JPEG/GIF/WebP 预览，PDF/Office 仍下载；公开页原有 PDF iframe 预览未改、本轮未重新验收，不声称全站 PDF 只下载。
- 源码已提交 `e4d414d` 并推送分支；本文档微调未提交，未合并 `main`。
