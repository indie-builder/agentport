# 对话字体收紧

## 目标与当前决定

2026-10-31 用户批准上一轮评估方案并要求调整。顶部会话标题、消息正文与输入用现有 `text-base`（14/22px）；欢迎标题用 `text-2xl`（20/28px），移除更大断点字号。Markdown 和 OpenUI 默认正文同步，保留内容标题和显式 small/large 层级。全局字号令牌不改。

## 基线与范围

工作树 `qoder-controls-refinement`，分支 `feat/qoder-controls-refinement`，HEAD `e61360e`。已有输入浅线与聊天顶部结构恢复的未提交成果全部保留，无提交/推送/合并授权。

源码边界：`pages/chat.tsx`、共享 `components/markdown.tsx`、OpenUI `components/content.tsx` 与 `layout.tsx`；相应已有测试。共享 Markdown 字号也影响成果、知识库、插件与公开分享的同一阅读组件，保持组件一致，不改这些页面布局。不改 `styles.css`、共享 Textarea 或 Message 原语。

## 方案与分工

- Sonnet A：chat.tsx，顶部 text-lg→text-base，输入 text-mobile-input/md:text-md→text-base，用户消息/超长折叠正文/待办 text-md→text-base，欢迎标题移除 sm:text-3xl，更新过期15px注释。不改布局和行为。
- Sonnet B：Markdown BODY_CLASS与H3–H6 text-md→text-base，SUBHEADING_STYLE下限改现有text-base；OpenUI默认正文/MarkDown/Callout/TextCallout/Steps详情同步，保small13与large16；调整已有相关测试。
- 两包文件互斥并行。规范/快照/sidecar由主会话在实现后协调同步。独立Opus评审后交付未提交差异。

## 验证

按范围跑 markdown、markdown-static、openui-content-markdown、openui-message、chat-ux、chat-outputs；typecheck、build及相关Biome。浏览器沿用space73/5190，检查计算字号、标题/消息/输入/欢迎态、共享Markdown正文和标题继承，以及已恢复顶部布局和浅线。未发新消息，不触发worker。

## 进度

- [x] Opus只读评估与用户批准。
- [x] 并行实现及相关测试。
- [x] 实页/类型/构建验证与规范同步。
- [x] 独立Opus评审，记录结果；未提交交付。

## 实施与验证记录

- A修改chat字号；B修改共享Markdown/OpenUI并适配两个已有测试；C同步规范、设计快照与sidecar。未改全局token或共享Textarea/Message原语。
- 实页发现plain `text-base`被共享Textarea的`md:text-sm`覆盖为13/20，补对话输入调用的`md:text-base`后桌面实测为14/22；未扩散修改共享控件。
- 主会话运行六文件定向测试（上节范围）：6 files / 164 tests通过；`pnpm --filter @agentport/web typecheck`、`pnpm --filter @agentport/web build`退出0；本轮四个源码、两个测试和sidecar的Biome检查通过。A另有130测试、B四文件34测试通过；B还额外执行整包1426测试通过，不把该额外执行当作后续固定门禁。
- 浏览器1480×840实测：会话h1、用户消息、输入14/22；欢迎h2为20/28。历史展开后historyY/headerY均4，输入边线仍rgb(230,230,230)。
- 临时挂载生产Markdown/OpenUI组件验证排版，无持久化数据：Markdown原文H1/H2/H3为18/26、16/24、14/22，p/li14/22；OpenUI small/default/large为13/20、14/22、16/24，large的H3保持16px（22px行高）。临时内容已清除，原会话已恢复，space73已handoff。
- 截图已查看：`/tmp/chat-typography-after-20261031.png`、`/tmp/chat-typography-welcome-after-20261031.png`、`/tmp/chat-typography-render-probe-20261031.png`。组件探针是排版验证，不冒充真实成功回复或端到端验收。
- 未发送新消息，未触发worker；未逐一浏览知识库/插件/公开分享，相关共享Markdown静态内容测试覆盖该渲染路径。当前无提交/合并。
- 独立Opus review `a47c81017ed484cfa`通过，无阻断问题。发现chat/content/styles三处旧字号注释，Sonnet已仅同步措辞，主会话确认样式令牌未变、Biome与diff检查通过。
- 文档冲突已同步：旧15/26对话正文、16/24会话标题、24/32欢迎标题契约替换为本任务数值；TextContent旧注释“行高沿用正文”更正为每档明确行高。共享Markdown影响范围如上，其他页面全局token保持。

## 交付状态（2026-10-31）

- 验证与独立评审均完成；本任务差异随分支 `feat/qoder-controls-refinement` 提交并创建 PR，等待合并，尚未合入 `main`。
