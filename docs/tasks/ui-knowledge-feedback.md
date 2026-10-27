# 知识库文档列表/详情编辑/上传重解析反馈（ui-knowledge-feedback）

## 目标

第八轮界面巡检：处理**知识库文档列表**、**详情编辑**与**上传/重解析**过程中的反馈。

验收方向：
- 反馈符合 `docs/DESIGN-SYSTEM.md`（信息表达 §10、动效 §11）与桌面端约定。
- 文档列表的加载/空/失败、编辑与上传的进行中/成功/失败、重解析的确认与结果，都有可见且可访问的表现，不出现静默失败或无解释的禁用。
- 不新增依赖、不改后端契约与数据模型、不改设计令牌；不破坏既有上传队列、解析轮询、详情编辑与删除语义。

具体缺陷清单尚未确定，须由 Opus 探索后给出证据，不凭截图或记忆猜测、不为凑数扩大改动。

## 方案

- 由 Opus 子代理只读探索上述三个环节，给出可复现的具体缺陷与根因；主会话据此固定契约与改动白名单后，再交 Sonnet 子代理执行。
- 复用现有实现（`components/states.tsx` 的 `LoadingState`/`ErrorState`、`components/page.tsx` 骨架、`lib/toast.ts`、既有的 TanStack Query mutation 反馈），不新造等价组件或第二套数据流。
- 最小完整改动；范围之外的重构不做。

## 基线与范围

- 工作目录：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/ui-knowledge-feedback`（分支 `worktree-ui-knowledge-feedback`）。
- 起点 HEAD `a6ee13ee6f8b004a32855129636fe0528dd7d340`（PR #88 合并后）；`origin/main` 同为 `a6ee13ee6f8b004a32855129636fe0528dd7d340`，与声明起点一致。
- 本 worktree 初始工作区干净（`git status --short` 无输出）。
- 主 checkout 存在 `.vitest` 相关未提交差异：**非本任务产出**，不提交、不还原、不覆盖；本会话隔离在 worktree，未读取或操作主 checkout 状态。
- 前七轮界面巡检 PR #83/#84/#85/#86/#87/#88 已合并并清理 worktree；第五轮无代码改动、无 PR，树已清，本记录不重复其范围。
- 本轮候选改动面（探索起点，非最终白名单）：`packages/web/src/pages/knowledge.tsx`、`packages/web/src/pages/knowledge-detail.tsx`、`packages/web/src/lib/queries.ts` 中知识库相关 hook、相关既有测试、本记录。最终白名单待 Opus 探索后由主会话固定。

## 当前有效决定

1. 用户已完整授权每轮流程：实现 → 按改动范围验证 → Opus 独立 review → commit / push / PR / merge → 清理 worktree，无需重新授权，该授权持续有效；git 交付由主会话执行。
2. 模型分工按 `pstack-models.md`：探索/设计/独立 review 用 Opus，执行用 Sonnet；主会话不亲自改源码，只定契约、派发、审查、合并与验证。执行代理不 commit、不再向下派代理，这只是分工限制。
3. 本轮范围仅知识库文档列表、详情编辑、上传与重解析的错误反馈；具体问题待 Opus 给出证据后固定，不虚构。
4. 动效沿用项目规则：仅局部交互与状态反馈（90–160ms、`--ease-out-soft`、只过渡实际变化的属性），不做页面入场或装饰位移。
5. 实测口径按 `docs/PITFALLS.md`：UI 项交付前读浏览器实际几何、计算样式与焦点行为，数值写入验证段。
6. 个人项目取向：不向后兼容、不为理论风险加防护；验证按改动范围选择，不固定跑全套，不等待 CI。

## 已替代项及原因

无（本记录初建，尚无被覆盖的决定）。

## Opus 探索结论（已完成）

只读探索落在 `packages/web/src/pages/knowledge-detail.tsx`，确认两个可复现缺陷：

1. **未保存输入直接丢失。** `DocumentDialog`（文档属性：标题/文件夹/标签/状态）与 `ChunkDialog`（分块正文）各自用 `useState` 存草稿，但关闭路径（取消按钮、`DialogShell` 的关闭按钮、遮罩、Esc）全部直达 `onClose`，没有 dirty 判定，也没有 `ConfirmDialog` 放弃确认；也没有路由离开阻断。同项目已有成套模式：`SkillDialog`（`packages/web/src/pages/skills.tsx`）+ `useFormBlocker`（`packages/web/src/lib/form.ts`）+ `ConfirmDialog`。`ChunkDialog` 的「重新加载」按钮在冲突后同样会直接丢弃草稿，未接确认。图片向量分块分支只读、无输入，不应引入 dirty。
2. **查看器不跟随列表更新。** `DocumentsTab` 把整份 `KnowledgeDocument` 对象存进 `viewing` 状态，列表从 `pending/currentVersionId=null` 轮询到 `ready/currentVersionId=<id>` 后，查看器仍持有旧对象：正文/图片/分块查询继续以 `null` 版本禁用，必须关闭重开才出现内容。

## 固定契约与白名单（主会话）

- 两个编辑器（文档属性、可编辑分块）的所有关闭入口（取消、关闭按钮、遮罩、Esc）与路由离开统一走放弃确认：继续编辑保留草稿，明确放弃才关闭/离开，保存请求进行中禁止关闭，保存成功直接关闭。基线固定为打开时的值，列表轮询不重置草稿；只读图片向量分块不增加 dirty 与确认。冲突后的「重新加载」属于丢弃草稿，同样先确认。
- 查看器按文档 ID 从当前列表数据取最新对象；列表因刷新/筛选/分页暂时不含该文档时保留最后一次快照，不无意关闭。不引入缓存体系、不新增查询接口。
- 白名单：`packages/web/src/pages/knowledge-detail.tsx`、`packages/web/test/knowledge-management.test.ts`（必要时 `packages/web/test/knowledge-document-polling.test.ts`）、本记录。不改后端、依赖、API、设计令牌。
- 行为测试复用 `knowledge-management` 的真实 Router/QueryClient/MSW fixture，不用镜像用例；能先红则先红。浏览器实测由主会话随后派浏览器代理补齐（见「浏览器实测」小节）。

## 步骤

- [x] 阅读 `docs/DEV-WORKFLOW.md` §3 模板与 `docs/PITFALLS.md` 相关条目，确认记录格式与验证要求。
- [x] 核对基线：HEAD 与 `origin/main` 同为 `a6ee13e`，worktree 干净，并记录主 checkout 既有差异归属。
- [x] 创建本任务记录，固定目标、候选范围与执行分工。
- [x] Opus 只读探索，给出上述两个缺陷与现有可复用模式。
- [x] 主会话固定契约与白名单，写入本记录。
- [x] Sonnet 执行实现与真实相关测试，按改动范围验证。
- [x] Opus 独立 review，发现问题修复并复核（两轮，见「Review 结论」）。
- [ ] 主会话按授权 commit / push / PR / merge，并清理该轮 worktree。

## 改动文件

- `docs/tasks/ui-knowledge-feedback.md`：本记录。
- `packages/web/src/pages/knowledge-detail.tsx`：两编辑器放弃确认与路由阻断；查看器按 ID 取最新文档。
- `packages/web/test/knowledge-management.test.ts`：上述行为的真实 Router/QueryClient/MSW 测试。

## Review 结论

- 第 1 轮（Opus，基线为本 worktree 未提交差异）：发现两项——保存关闭 resolver 与旧 snapshot 展示。均已修复：`finish` 关闭读取最新 `blockerRef`，并在 reset 后调用 `onClose`；查看器 `viewing` 同步最近一次快照（列表暂不含该文档时保留最后快照）。
- 第 2 轮（Opus，a0be）：通过，定向复跑 `knowledge-management` 为 4 passed / 64 skipped（引用事实，不重测全量）。

## 下一步

由主会话按既有授权执行 commit / push / PR / merge 并清理 worktree；是否合并以主会话实际执行为准，本记录不预写合并结果。

## 验证

先红：把 `packages/web/src/pages/knowledge-detail.tsx` 换回 HEAD 版本后跑新增用例，5 个全部失败，失败原因符合预期（4 个「Missing dialog: 放弃未保存的更改？」，1 个查看器仍显示「还没有解析完成的版本」）。恢复实现后：

- `pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/knowledge-management.test.ts packages/web/test/knowledge-document-polling.test.ts` → `Test Files 2 passed (2)`，`Tests 66 passed (66)`。
- 同轮顺跑 `knowledge-citations` / `knowledge-settings` / `knowledge-source-runs` / `expert-knowledge-binding` → `Test Files 4 passed (4)`，`Tests 27 passed (27)`。
- `pnpm --filter @agentport/web typecheck` → `tsc -b` 无输出、退出 0。
- `biome check packages/web/src/pages/knowledge-detail.tsx packages/web/test/knowledge-management.test.ts` → `Checked 2 files`，无修复项。

限制：实现代理未做浏览器实测（按分工优先交付可审查源码与行为测试），后由浏览器代理补齐，见下节；实现阶段未取几何与焦点数值。新增用例覆盖：属性编辑器取消/Esc/关闭三入口的保留与放弃、保存中禁止关闭、路由离开确认；分块编辑器取消/Esc/关闭、冲突后重新加载确认；查看器从 pending 轮询到 ready 后直接呈现正文与分块。图片向量分块仍无草稿与确认。

最终结果（全量，06:15:41）：`Test Files 78 passed (78)`，`Tests 783 passed (783)`；`@agentport/web` typecheck、build、`biome check` 两文件、focus 检查、contract 检查全部通过。

### 浏览器实测（实现代理未测，后由浏览器代理补齐，覆盖上文该限制，其余结论不变）

方式：一次性入口 `packages/web/tmp-browser-verify/`（真实 `KnowledgeDetailPage` 导出 + 真实 `styles.css` + 真实 Router/QueryClient + fetch stub，独立 Vite 端口 5199），不登录、不连真实 DB/模型；该入口在验证后已删除，未改任何配置、依赖或业务源码。浏览器为 ego-browser，space 固定 `ui-knowledge-feedback`（id 107）。数据固定：`kb_1` / `kdoc_1`「上线流程」，1 个已人工编辑分块，正文 markdown 有内容。

范围一：放弃确认（属性编辑器）
- 改标题「上线流程（再改）」→ 点「取消」→ 出现「放弃未保存的更改？」；确认框内点「取消」，属性对话框保持打开、`#document-title` 值仍为草稿值。
- 焦点：继续编辑后焦点仍在 `#document-title`（`document.activeElement.id === 'document-title'`）。
- Esc：聚焦标题按 Esc → 出现同一确认框；在确认框上按 Esc → 确认框关闭、草稿仍在、焦点回到 `#document-title`（INPUT，位于编辑文档对话框内）。
- 明确放弃：点「放弃并关闭」→ 两层对话框均消失、无 PATCH 请求发出。
- 保存中：PATCH 延迟 2s，标题禁用、「保存」变「保存中…」、取消与关闭按钮均 `disabled`；此时按 Esc 及点取消都无反应，对话框不关闭；请求完成后自动关闭、焦点回到行操作按钮。

范围一：放弃确认（分块编辑器）
- 改正文 → 取消 → 确认框；确认框内取消 → 草稿保留、焦点回到 `#knowledge-chunk-content`（TEXTAREA）。
- Esc 一次 → 确认框出现；Esc 第二次 → 确认框关闭、草稿保留、焦点回到正文。关闭按钮（标题栏 X）同样触发确认；「放弃并关闭」后编辑器关闭、焦点回到「编辑分块 1」，全程无 PATCH。
- 冲突后「重新加载」：先确认（取消则草稿保留）→「放弃并重新加载」后编辑器关闭、焦点回「编辑分块 1」。
- 保存中：PATCH 延迟 2s，取消按钮 `disabled`，按 Esc 对话框保持打开；请求完成后关闭。

范围二：查看器跟随列表轮询
- 列表初始 `pending/currentVersionId=null`，打开查看器显示「还没有解析完成的版本」「还没有分块」；把列表数据切到 `ready/kdv_1` 后（文档 createdAt 为当前时间，3s 轮询生效，观测到 3 次文档列表请求），**未关闭重开**，查看器在同一对话框内变为「可检索」并出现「下载原件」、解析正文（“发布前需要产品与研发双方确认。”）、图片区与分块 1（「发布前检查」「人工编辑」「第 2 页」）。

限制与未测：
- 确认框的入场不透明度采样：在 `data-starting-style` 存在期间 `opacity` 采样为 0，约 1s 后动画结束（`data-starting-style` 消失）稳定为 1；`requestAnimationFrame` 在该 ego 会话中约 1s 才推进两次，无法用于 90–160ms 级别的逐帧测量，因此**未做逐帧动效时长核对**。确认框几何未做 200% 缩放检查（本轮不涉及布局改动）。`Page.captureScreenshot` 两次超时，未采用截图，全部结论基于 DOM 文本、属性、`getComputedStyle` 与焦点位置。
- 路由离开阻断（`useFormBlocker`）只在 jsdom 行为测试覆盖，浏览器本轮未验证（验证脚本为内存路由且无其他可跳转目标）。
- 未验证真实后端/真实大文件上传与真实解析；未验证图片向量分块在浏览器中的只读分支（jsdom 用例覆盖）。
