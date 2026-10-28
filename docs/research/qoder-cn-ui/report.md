# Qoder CN 桌面 UI 实地调研

调研日期：2026-10-29。通过 Codex CLI（显式 `-m gpt-6.1-terra`，TUI 确认 GPT-6.1 Terra high）的 unified computer use 访问现有 Qoder CN 窗口，使用无障碍树与窗口截图观察；版本 0.4.11 由主会话实际通过 `ps` 读取进程注记取得，非用户提供。初始页面为编程模式的「自动化」，结束时已返回该页面、恢复编程模式及展开的工作区。未发送消息、创建、保存、安装或修改设置。截图只包含目标应用窗口；部分截图包含已有任务和知识内容，属于工作资料，仅本地暂存，不提交或上传。

## 页面地图

- 主侧栏：工作模式「编程 / 通用」、新的任务、搜索、工作区及已有任务；底部为站点、自动化、扩展、更多和用户菜单。[01](screenshots/01-automation.png)、[02](screenshots/02-more.png)
- 更多 → 知识库、Repo Wiki；用户菜单 → 设置。[02](screenshots/02-more.png)、[11](screenshots/11-knowledge.png)、[13](screenshots/13-repo-wiki.png)、[17](screenshots/17-settings-profile.png)
- 自动化 → 自动化、模板、执行记录；新建自动化弹窗。[01](screenshots/01-automation.png)、[08](screenshots/08-automation-templates.png)、[09](screenshots/09-automation-runs.png)、[10](screenshots/10-automation-create.png)
- 扩展 → 插件、技能、连接器；连接器详情。[04](screenshots/04-plugins.png)、[05](screenshots/05-skills.png)、[06](screenshots/06-connectors.png)、[07](screenshots/07-connector-detail.png)
- 工作区 → 已有任务 → 任务过程、任务监控；全局搜索弹层。[14](screenshots/14-task-chat.png)、[15](screenshots/15-task-monitor.png)、[16](screenshots/16-task-process.png)、[22](screenshots/22-search.png)

## 共通框架与尺度

截图为 2640 × 1600 图像像素；未测显示缩放、CSS 或逻辑像素。以下宽度是按截图视觉估计，不是精确控件规格：左栏约占窗口宽度 19%，主区为余下的大圆角白色工作面；导航、工作区树与底部辅助入口在左栏纵向分布，主区独立承载各页。左栏与白壳靠底色、留白和圆角区分，顶部有侧栏收起及前进后退；无障碍树暴露可调整侧导航宽度的分隔器。[01](screenshots/01-automation.png)

Qoder 的编程模式左侧呈淡黄至灰蓝色过渡，通用模式变为浅灰并带绿色强调；白壳、黑色主操作、灰色次操作及细线图标构成主要层级。这是观察，不建议照搬品牌色或渐变。[01](screenshots/01-automation.png)、[21](screenshots/21-general-mode.png)

## 逐页观察

### 自动化

入口：左侧「自动化」。页面顶部右侧排列刷新、次要的「通过 Qoder 创建」及黑色「新建自动化」；内容在较窄的居中列中，从标题、说明、设备唤醒提示，过渡到视图切换与列表。自动化视图右侧有全部/本地/云端分段筛选和排序；当前是空态图标、标题和指向右上操作的说明。[01](screenshots/01-automation.png)

「模板」为多项示例，包含标题、简述、推荐标记、周期及使用入口；「执行记录」提供按天/周/月分组与自动化、状态筛选，当前无记录。[08](screenshots/08-automation-templates.png)、[09](screenshots/09-automation-runs.png)

新建弹窗居中，左右两列：左侧大面积任务名称与提示词编辑区，底部为上下文、附件、工作区及模型；右侧按执行位置、计划时间、到期、任务输出、执行授权分组；底部取消与禁用的创建。默认授权为开启，说明无人值守调用工具；仅观察并取消，未更改任何选项。[10](screenshots/10-automation-create.png)

### 站点

入口：左侧「站点」。右上刷新与添加站点；内容顶部是图文宣传区，下面左侧「我的站点 / 共享给我的」，右侧卡片/列表视图切换。当前我的站点为空，中央使用票据形插画、标题与下一步说明。[03](screenshots/03-sites.png) 未查看有数据的站点或发布流程。

### 扩展

入口：左侧「扩展」。顶栏左侧按插件、技能、连接器切换，右侧刷新、搜索、已安装及添加。插件市场先显示发现区，再显示新品推荐，随后是全部插件的横向类别与热门/最新排序；条目按两列排列，图标、名称、截断说明为主，详情可点开。[04](screenshots/04-plugins.png) 技能和连接器复用相同顶层结构并换内容、类别与添加操作。[05](screenshots/05-skills.png)、[06](screenshots/06-connectors.png)

连接器详情由面包屑、名称/版本/来源/安装数、安装按钮、简介、MCP 服务分区和说明构成；服务属性以标签和值成组，安装前的工具区明确说明限制。[07](screenshots/07-connector-detail.png) 未安装任何扩展。

### 知识中心与 Repo Wiki

入口：更多 → 知识库。知识库列表有搜索、归属及工作区筛选、卡片/列表切换和创建；当前有一个知识库卡片。[11](screenshots/11-knowledge.png) 进入已有知识库后，应用导航之外还有文件侧栏、可调整分隔器、文档标签和阅读区；阅读区顶部显示格式及更新时间，提供渲染/源码、复制和下载，正文以 Markdown 标题、段落、列表、表格呈现。[12](screenshots/12-knowledge-detail.png) 无障碍树给出的文件侧栏分隔器值为 320，但未独立确认其单位。

更多 → Repo Wiki：顶部搜索及刷新，下面是介绍区、全部/已生成/未生成筛选与视图切换；当前工作区条目提供「去生成」。未生成或修改 Wiki。[13](screenshots/13-repo-wiki.png)

### 已有任务与搜索

入口：工作区中已有任务。任务头部有标题与更多操作，右端有工作区打开方式、任务监控及其他面板按钮。消息流中用户消息右对齐浅灰气泡，Agent 正文左对齐、无气泡；每轮可折叠「已处理」，回复尾部有复制、反馈、分支等操作。底部固定多行输入区域，底行放上下文、附件、权限、模型、语音和发送；其下显示工作区、本地、分支与上下文占用。[14](screenshots/14-task-chat.png)

展开「已处理」可见思考摘要；打开任务监控后出现侧区，含任务回顾、环境信息、产出、来源及相关操作。[15](screenshots/15-task-monitor.png)、[16](screenshots/16-task-process.png) 此任务仅有简单已完成回复，未观察真实工具调用详情、运行中状态或实际产出文件，不能推断其完整表现。

搜索入口打开居中浮层：搜索任务标题、会话 ID 和消息内容，列表展示任务、工作区、模式与日期，并提示键盘上下选择和 Enter 打开。[22](screenshots/22-search.png) 未输入搜索词。

### 设置与工作模式

用户菜单 → 设置。设置替换普通侧栏为可搜索的分类导航：个人（个人资料、常规、模式配置、任务监控、快捷键、外观、语音、模型、桌面宠物、记忆、数据导入）、集成（扩展管理、智能体、智能体团队、钩子、电脑操控、移动端）、编码（Git、Worktrees、连接、安全）、归档管理和其他。[17](screenshots/17-settings-profile.png)

常规页按任务与工具、通知、隐私等分组，行内左侧名称与说明、右侧选择或开关；对话显示设置另开弹窗，分阅读和过程展示，标注更改自动保存，因此只查看并关闭。[18](screenshots/18-settings-general.png)、[19](screenshots/19-settings-dialog.png) 模型页提供个人模型列表与添加，当前空态。[20](screenshots/20-settings-models.png) 各设置项并未逐一打开。

通用模式切换后当前已有对话仍可见，侧栏视觉主题和底部上下文信息变化；随后恢复编程模式。[21](screenshots/21-general-mode.png) 未进入新任务首页，以避免影响已有草稿和启动新任务。

## 对 Agentport / PACE 的参考

1. **把过程、正文和成果分开但保持关联。** 任务流中折叠过程，旁侧监控按回顾、环境、产出、来源组织，适合为复杂任务提供渐进披露；PACE 可沿用已有运行读数和成果面板契约，不必复制 Qoder 的监控内容或默认状态。[14](screenshots/14-task-chat.png)、[15](screenshots/15-task-monitor.png)、[16](screenshots/16-task-process.png)
2. **资源发现与管理分层。** 扩展页把类型切换、搜索及管理操作置于顶栏，分类和排序紧邻列表；详情再展示服务配置与可用性。可借鉴信息位置，资源卡与控件仍遵循 PACE 规范。[04](screenshots/04-plugins.png)、[07](screenshots/07-connector-detail.png)
3. **文档阅读采用可收起目录和独立内容区。** 知识文件列表、渲染/源码切换及复制/下载在阅读上下文就近提供，可参考现有成果阅读；不应把知识库文件树误当会话成果。[12](screenshots/12-knowledge-detail.png)
4. **复杂配置按任务内容和执行条件分区。** 自动化弹窗左右区分内容与计划，危险或授权语义就近可见；实现时仍需遵循 PACE 的固定控件、验证和权限语义，不照搬其默认授权。[10](screenshots/10-automation-create.png)
5. **搜索结果直接带足定位信息。** 标题、工作区、时间与键盘提示同处一个浮层，有助快速定位历史任务。[22](screenshots/22-search.png)

以上仅为布局与交互参考。项目基准仍为 [DESIGN-SYSTEM.md](../../DESIGN-SYSTEM.md)：中性灰语义令牌、shadcn/Base UI、固定控件规格和既定对话及成果契约优先；Qoder 的品牌、渐变、色彩和宣传文案不作为实施决定。

## 未覆盖与限制

新任务欢迎态、真实运行中任务、工具输入输出、实际产物、非空自动化执行记录、非空站点、已生成 Repo Wiki、全部设置子页及其他扩展详情未观察。当前只有一个窗口尺寸，未测试窄屏、深色主题、键盘完整可访问性或动态行为；视觉尺寸仅为估计。以上为本次调研的真实观察边界。
