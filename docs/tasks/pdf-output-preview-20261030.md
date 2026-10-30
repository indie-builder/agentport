# 成果 PDF 预览：原生浏览器查看器与 header 门槛

## 目标

让会话成果与公开分享页的 PDF 走同一套原生预览入口：

- 私有成果：`application/pdf` 精确命中后通过鉴权下载端点取 Blob，交给共享 `BlobPdf` 用原生 `<iframe>` 预览；请求不落到 `/content`。
- 公开分享页：移除旧的 PDF 对象 URL 分支，改为共享 `BlobPdf`；Bearer token 与 `credentials: 'omit'` 不变。
- 预览前用 `navigator.pdfViewerEnabled === true` 判断原生查看器可用；不可用时不创建 iframe，提示「当前浏览器不支持 PDF 预览，请下载原件查看。」。
- 读取 Blob 前 5 字节，必须为 `%PDF-`；不符时不创建对象 URL/iframe，提示「文件不是可预览的 PDF，请下载原件查看。」。这只是 header 门槛，不声称结构完整验证。
- header 读取本身失败与「header 不符」分开处理，提示「PDF 读取失败，请下载原件查看。」，同样不创建 iframe/对象 URL。
- 通过后以 `blob.slice(0, blob.size, 'application/pdf')` 固定 MIME 创建对象 URL；iframe 只接受组件自身生成的 URL，并带 `title`。
- 原生查看器可能显示损坏或加密 PDF，`load`/`error` 都不作为解码成功证据；下载入口始终可达。

验收：

- 浏览器不支持、header 不符、正常 PDF 三种入口状态均正确，页面无假成功态。
- 换 Blob 后立即停止显示旧 PDF；迟到的 header 读取不得为过期 Blob 创建 URL。
- 卸载/换版/StrictMode 下对象 URL 正确释放，不泄漏。
- 私有 PDF 请求精确使用 `conversationId + runId + path` 的下载端点，不请求正文；同路径旧版、刷新深链、列表外元数据回退均可用。
- 公开页 Bearer/omit、下载、HTML/SVG 源码与 4 种图片预览行为不变。

## 方案

- 新增 `packages/web/src/components/blob-pdf.tsx`，状态按 Blob 身份绑定：`unsupported` 不进入 Blob 状态，直接由 `navigator.pdfViewerEnabled` 渲染提示；`checking` / `invalid` / `readerror` / `ready` 与具体 Blob 一起保存，渲染时只认同一个 Blob。
- header 检查在 effect 内异步读取 `blob.slice(0, 5).arrayBuffer()`；cleanup 置 cancelled 并撤销本 effect 已创建的对象 URL，迟到结果直接丢弃。
- 通过后创建固定 MIME 的 Blob URL，只在 `ready` 且 Blob 身份一致时渲染 `<iframe title={title} src={url}>`。
- 私有成果把 `PreviewKind` 扩为 `pdf`，精确归一化 MIME 等于 `application/pdf` 才算；复用 `useOutputBlob` 的完整三元组 key 与下载端点，`useOutputFile` 的列表外回退逻辑保持不变。
- 公开页把 PDF 与图片都归入下载 Blob 分支，删除旧的对象 URL state/cleanup，改渲染 `BlobPdf`。
- API 在 CSP 上仅新增 `frame-src 'self' blob:`，保留 helmet 默认 `object-src 'none'` 与 `script-src 'self'`；`security.test.ts` 断言 frame-src 只允许 self/blob，且不出现 `*`、`data:`、`http(s):`。
- 仅修正 `api.ts` / `queries.ts` 中把 Blob 下载描述为「图片专用」的注释。

## 基线与范围

- 起始 commit：`85678c712f6d0fca0c369ec4208a795daf84c7b8`（`main`，分支 `loop-capability-pdf-preview-02`）。
- 工作区初始干净；主线程持共用锁。
- 允许改动的文件：
  - `packages/web/src/components/blob-pdf.tsx`（新增）
  - `packages/web/src/components/conversation-outputs.tsx`
  - `packages/web/src/routes/s.$shareId.tsx`
  - `packages/web/src/lib/api.ts`（仅注释）
  - `packages/web/src/lib/queries.ts`（仅注释）
  - `packages/web/test/blob-pdf.test.ts`（新增）
  - `packages/web/test/chat-outputs.test.ts`
  - `packages/web/test/public-share.test.ts`
  - `packages/web/test/run-history-visibility.test.ts`（仅 loading 用例时序修复）
  - `packages/api/src/plugins/security.ts`（仅 CSP `frame-src`）
  - `packages/api/test/security.test.ts`
  - `packages/api/test/outputs-routes.test.ts`
  - `packages/api/test/output-shares.test.ts`
  - `docs/tasks/pdf-output-preview-20261030.md`
- 不改：图片 `BlobImage`、DB、API 下载/分享路由实现（仅补 CSP 与回归测试）、SDK、PDF.js 或任何新依赖。

## 当前有效决定

- 用户本轮授权实现与验证，不 commit/push/merge。
- PDF 预览只用浏览器原生 iframe 查看器；不引入 PDF.js，不机械加 `sandbox` 阻断原生查看器。
- 私有 PDF 走鉴权下载端点取 Blob，不调用 `/content`；header 检查只在展示入口做。
- 公开页移除旧 PDF 对象 URL 分支，与私有页共用 `BlobPdf`。
- 生产隔离浏览器验收已通过（`a46306ac16227d1ce`）：独立随机 PostgreSQL + 独立 Redis、端口 63465、production 静态产物与真实 CSP header；`navigator.pdfViewerEnabled=true`，私有旧/新版实屏文字 `ONE`/`TWO`、切版刷新、下载 sha 一致；公开页在登录退出、无管理 cookie 下仍为 `ONE`/`TWO`，Bearer 下载 hash 一致；伪 PDF 不创建 iframe，引用不发送模型；临时进程/PG/Redis/workspace 清理为 0。非 Chromium 浏览器与大 PDF 未测。
- CSP 仅新增 `frame-src 'self' blob:`；`object-src 'none'` 与 `script-src 'self'` 保持；无新依赖、API、DB 或模型费用。
- `docs/DESIGN-SYSTEM.md` §9、`docs/ARCHITECTURE.md` §3.2、`docs/USER-STORIES.md` US-6.1/US-7.1 与 `docs/REMAINING-TODOS.md` 已在本轮同步 PDF 原生预览与公开页共享 `BlobPdf`，不再保留「公开 PDF 沿用旧 iframe、本轮未复验」的旧描述。

## 已替代项及原因

- 私有成果旧的 PDF 归入「二进制，请下载后查看」：本轮改为精确命中 `application/pdf` 后用原生查看器预览，下载仍保留。
- 公开页旧的 `URL.createObjectURL(blob)` + iframe 分支：没有 header 门槛、URL 生命周期混在请求 effect 中；本轮改由 `BlobPdf` 统一持有与释放。

## 步骤

- [x] 先写 `BlobPdf` 与私有/公开 PDF 行为测试，确认因组件缺失或旧行为失败。
- [x] 实现 `BlobPdf` 的 support/header 门槛、固定 MIME 与 URL 生命周期。
- [x] 接入私有成果与公开分享页，更新仅注释性的 Blob 描述。
- [x] 运行定向 web 测试、web typecheck/build、`lint:focus`/`lint:contract`、biome，记录真实结果。
- [x] API 新增 CSP 与私有/公开 PDF 下载/鉴权/原字节/headers 回归，一审通过（3 文件 26 用例）。
- [x] Web 一审 readerror mustfix 修复（header 读取失败独立提示、不建 iframe/URL），3 文件 97 用例通过；二审通过、无 mustfix。
- [x] 生产隔离浏览器验收通过（独立 PG/Redis、production CSP、私有/公开实屏、伪 PDF、清理 0）。
- [x] 三轮 Opus review 通过（末轮 `a18c436ffd11f7505`，无 mustfix，4 文件 110 用例）；主线程最终复验通过；实现已提交 `ca5cb28`，未 push、未 merge。

## 改动文件

- `packages/web/src/components/blob-pdf.tsx`（新增）
- `packages/web/src/components/conversation-outputs.tsx`
- `packages/web/src/routes/s.$shareId.tsx`
- `packages/web/src/lib/api.ts`（仅注释）
- `packages/web/src/lib/queries.ts`（仅注释）
- `packages/web/test/blob-pdf.test.ts`（新增）
- `packages/web/test/chat-outputs.test.ts`
- `packages/web/test/public-share.test.ts`
- `packages/web/test/run-history-visibility.test.ts`（仅 loading 用例时序修复）
- `packages/api/src/plugins/security.ts`（仅 CSP `frame-src`）
- `packages/api/test/security.test.ts`
- `packages/api/test/outputs-routes.test.ts`
- `packages/api/test/output-shares.test.ts`
- `docs/tasks/pdf-output-preview-20261030.md`

## 下一步

实现、三轮 Opus review、主线程最终复验与生产隔离浏览器验收均已完成；实现已提交 `ca5cb28`，未 push、未 merge。文档已同步 DESIGN-SYSTEM §9、ARCHITECTURE、USER-STORIES 与 REMAINING-TODOS。剩余限制：非 Chromium 未测、加密/坏结构 PDF 的原生查看器兜底未逐一实测、大 PDF 未压测。

## 验证

红（实现前）：

- `pnpm vitest run --config packages/web/vitest.config.ts packages/web/test/blob-pdf.test.ts` → 1 suite failed：`Failed to resolve import "../src/components/blob-pdf.js"`，组件尚不存在。
- `... chat-outputs.test.ts -t "pdf outputs"` → 5 failed：PDF 仍被当作二进制下载，无 iframe、无 header 提示，`outputBlob` 未被调用。
- `... public-share.test.ts` → 1 failed：旧 iframe 分支对任意字节都挂载预览，没有「文件不是可预览的 PDF」提示。正常 PDF 用例在旧实现下已通过（旧 iframe 不校验 header），实现后仍通过。

绿（实现后）：

- `pnpm vitest run --config packages/web/vitest.config.ts packages/web/test/chat-outputs.test.ts packages/web/test/public-share.test.ts packages/web/test/blob-pdf.test.ts` → 3 files / 96 passed，0 failed。
- `pnpm vitest run --config packages/web/vitest.config.ts` → 119 files / 1411 passed，0 failed，38.75s（readerror 与 loading 修复前）。测试输出中的 `Not implemented: navigation to another Document` 是 jsdom 对 iframe `blob:` 地址的已知提示，不影响断言。
- `pnpm --filter @agentport/web typecheck`（`tsc -b`）→ exit 0。
- `pnpm --filter @agentport/web build` → 构建成功（`✓ built in 738ms`），仅有既有的大 chunk 警告。
- `pnpm lint:focus` → 「焦点/边框规约校验通过。」exit 0。
- `pnpm lint:contract` → 「project contract OK」exit 0。
- `node_modules/.bin/biome check <8 个源码/测试文件>` → `Checked 8 files … No fixes applied.` exit 0（任务文档不在 biome 检查范围）。
- `git diff --check` → 无输出，exit 0。

未验证（实现当时）：

- 真实浏览器 iframe 在应用 CSP 下能否加载 `blob:`、原生查看器对损坏/加密 PDF 的实际显示，以及公开页真实域名与下载按钮实屏；当时留待生产环境验收，后续结果见下节。

评审与复验（2026-10-30）：

- API 一审 `a1f97d67a04771d6d` 通过、无 mustfix：新增 CSP 与私有/公开 PDF 下载/鉴权/原字节/headers 回归，3 文件 26 用例通过；api typecheck/build、`lint:focus`/`lint:contract` 通过。
- Web 一审 `a50731efc5390ded9` 要求修复「header 读取失败被误报为 invalid」：新增独立 `readerror` 状态，读取失败不创建 iframe/对象 URL；修复 `ada812d28cc77c763` 后 3 文件 97 用例通过，web typecheck/biome/diffcheck 通过。
- Web 二审 `ab003ecf947f052cb` 通过、无 mustfix（3 文件 97 用例）。
- 第三轮 Opus review `a18c436ffd11f7505` 通过、无 mustfix：4 文件 110 用例通过；独立核对 production 截图 `ONE`/`TWO` 与下载 sha/CSP。
- 作者 full web 在 readerror 与 loading 测试修复后为 119 文件 / 1412 用例通过；此前 1411 是修复前数字。`run-history-visibility.test.ts` 的 loading 用例曾在全量中单独失败、单文件 13 用例通过；最小修复只固定网络 pending 窗口、保留原断言，单文件连续 5 次通过，仅测试改动、无产品源码变化；单测 mock 为固定 pending，不放宽。主线程最终复验 full web 119 文件 1412 用例 39.50s 全部通过，api/web typecheck/build 完整通过，backend 3 文件 26 用例 2.62s 通过。
- 生产隔离浏览器验收 `a46306ac16227d1ce` 通过：独立随机 PostgreSQL + 独立 Redis、端口 63465、production 静态产物；真实 CSP header 为 `frame-src 'self' blob:`，`object-src 'none'` 与 `script-src 'self'` 保持；`navigator.pdfViewerEnabled=true`；私有旧/新版截图实际文字 `ONE`/`TWO`，切版与刷新保持；下载 sha 与旧/新版本一致；公开页在登录退出、无管理 cookie 下仍为 `ONE`/`TWO`，Bearer 下载 hash 一致；伪 PDF 不创建 iframe 并显示「文件不是可预览的 PDF，请下载原件查看。」；引用不发送模型；临时进程/PG/Redis/workspace 清理 0。证据：`/Users/xbjt/.claude/jobs/642ddc7d/tmp/pdf-preview-production/{private-old.png,private-new.png,public-old.png,evidence.json}`。
- 限制：只测 Chromium 原生 PDF viewer；加密或结构损坏 PDF 由原生 viewer 兜底、未逐一实测；大 PDF 未压测；三轮 review 与最终复验已完成，实现已提交 `ca5cb28`，未 push、未 merge。

并发说明：

- 本轮 PDF 任务实际包含 API 侧 CSP 与回归测试（`packages/api/src/plugins/security.ts`、`packages/api/test/security.test.ts`、`outputs-routes.test.ts`、`output-shares.test.ts`）以及 `run-history-visibility.test.ts` 的 loading 时序修复，均属本任务范围，不再记为「域外 API 子代理」改动。工作区仅 `.vitest/json/output.json` 是测试运行产物。
