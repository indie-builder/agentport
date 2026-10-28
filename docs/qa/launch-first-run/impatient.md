# 首次用户 QA · 不耐烦（impatient）

- TaskSpace：`launchqa-impatient`（已 finish）
- 环境：`http://localhost:3000`（compose 全栈，最新 main `4b5078b`），桌面 1512×838，中文
- 登录：先用既有 admin 登录态观察，按 brief 先登出，再在 `/login` 用 QA 凭据重新登录（凭据未记录/未截图）
- 结论：**完成首次成功**（登录 → 新建对话 → 发送任务 → 7.6s 收到回复 → 手动打开右侧会话成果看到 `report.md`）
- 实际步数约 6 次操作（登录 → 进入工作台 → 新建对话 → 输入并发送 → 打开工作区 → 点开 report.md），纯操作耗时约 20 秒（不含本 QA 脚本的观察等待）
- 最终 URL：`http://localhost:3000/chat?agent=agt_01m5n53aw1eh0v0z6mzwnzhabw&conversation=conv_01m60x315pen99rzshzvsqz97j&outputRun=run_01m60x315qen99rzsttqrkkty1&outputPath=report.md&outputMode=read`

## 路径事实

1. `/login`：只有「用户名（预填 admin）／密码／进入工作台」，点第一个按钮即进入。
2. 登录后落到「工作台」后台仪表盘（运行次数 61、专家 85、连接器 3329、运行趋势、最近运行），不是聊天起点；右上角黑色「新建对话」是第一个显眼按钮。
3. 点「新建对话」→ `/chat` 空态，只有输入框和「梳理思路／制定计划／整理内容／分析问题」四个建议按钮。**页面上看不到任何“专家”选择控件**，也没有说明会自动用哪个专家。
4. 直接输入任务并发送：左上方出现「未命名会话」，标题很快变成整段用户消息截断；约 7.6s 后回复「报告已生成并保存到 /mnt/outputs/report.md」。
5. 右侧「显示工作区」默认是关闭的，按钮是纯图标（`aria-label`/`title` = 显示工作区），没有文字、没有新成果角标/提示。
6. 我方（知道 aria-label）手动点开该图标后才出现「会话成果」面板，里面 `report.md` 可阅读/源码/下载；点开后能正常渲染周报内容。

## 问题表

| # | 严重度 | 步骤 | 期望 | 实际 | 证据截图 | 是否阻断首胜 / 影响面 |
|---|---|---|---|---|---|---|
| 1 | **P1** | 收到含文件的回复后想打开成果 | 回复里的文件路径可点击，或成果按钮有明显文字/新成果提示 | 路径 `/mnt/outputs/report.md` 是普通 `<code>`，非链接（已验证 cursor=auto、不在 a/button 内，点击无反应）；成果入口是右上角**纯图标**，title 仅悬停可见，且没有角标/红点/toast。不知道图标含义的用户会以为没有成果 | `screens/impatient-08-waiting.png`（回复已出现、工作区关闭）、`screens/impatient-09-workspace.png`（手动点开后才有）、`screens/impatient-33-outputs-after-reload.png`、`screens/impatient-07-sent.png` | 不阻断“收到回复”，但**阻断/严重拖慢“打开成果”这一步**，对不耐烦用户相当于“没拿到东西”。预计命中所有会产生文件的用户（≥2 persona） |
| 2 | **P1** | 想在对话里选/确认专家 | 对话页可见当前专家名，或有一眼可见的专家选择入口 | 空态 `/chat` 完全没有专家控件；专家选择器只在点开「显示会话历史」后出现在左栏，且显示的是机器名 `md-tools-f307a5e9-4`；会话头部只显示截断的用户消息，不显示实际应答的专家。发送前用户无法知道会由谁回答，事后也无法从主界面确认 | `screens/impatient-06-new-chat.png`（空态无专家）、`screens/impatient-30-fresh-chat-history.png`（专家选择器藏在历史面板里）、`screens/impatient-08-waiting.png`（头部无专家名） | 不影响“能发出去”，但用户对“用了哪个专家/会不会用错能力”完全无从确认。命中“字面理解者”等 ≥2 persona |
| 3 | P2 | 打开「选择专家」下拉 | 弹层立即稳定、可读 | 打开瞬间约 150ms 淡入期间与背后会话列表文字重叠、半透明；本次首次打开时 1.2s 截图仍捕捉到重叠（异步加载专家列表导致过渡重播）。稳定后正常 | `screens/impatient-14-expert-picker.png`（重叠）、`screens/impatient-15-picker-transparent.png`（稳定后）、`screens/impatient-34-picker-1.2s.png` | 不阻断；短暂视觉噪音 |
| 4 | P2 | 首次从其它页面进入 `/agents` | 有加载骨架/进度，不应全白 | 有一次直接进入 `/agents` 后**整页全白，body 文本长度 0，持续 >6s**，随后 reload 等待 15s 超时；再下一次读取时已正常渲染。之后 4 次冷/热加载均为 0.4–0.7s 正常，未能复现。当时无骨架、无 spinner、无错误提示 | `screens/impatient-19-agents-page.png`、`screens/impatient-19-agents-page-wait.png`、`screens/impatient-20-agents-after-timeout.png` | 未阻断本次首胜（我没用该页）；若首次访问真实出现即 P1，需主会话确认是否与 dev chunk/网络有关 |
| 5 | P2 | 阅读消息区 | 不在底部时才出现「回到底部」 | 该按钮常驻 DOM，`opacity: 0`、`pointer-events: none`、`tabIndex:-1`，但仍出现在无障碍树（snapshot 中作为 button "回到底部" 暴露） | `screens/impatient-08-waiting.png`（视觉上不可见） | 不阻断；无障碍/读屏噪音 |
| 6 | P2 | 会话标题/历史列表 | 标题是简短可辨识名称 | 自动用用户首条消息原文截断作标题（`把下面三行整理成一份 Markdown 报告并保存到 /mnt/outputs/report.md： - 本周完成登录页改版 - 修复了 3 个 P0 缺陷 -`），历史列表同样展示整段 prompt，噪音大 | `screens/impatient-08-waiting.png`、`screens/impatient-30-fresh-chat-history.png` | 不阻断；可发现性/整洁度 |
| 7 | P2 | 侧边栏导航 | 一眼可读的入口名 | 「专家·技能·连接器·插件·知识库」把 5 个概念塞进一个导航项，一行文字墙 | `screens/impatient-01-landing.png` | 不阻断；首次用户难以定位“专家”在哪 |
| 8 | 环境说明 | 专家列表 | — | 共享开发库里有 88 个专家，大量同名「通用助手」「Portable child」和机器名，非产品文案问题；本轮未新建专家（直接用了默认专家） | `screens/impatient-19-agents-page.png` | 环境限制，非缺陷 |

## 未覆盖

- 未测试 375px / 慢网（属“375px 用户”persona）。
- 未测试权限、审批、审计、数据保留（属“怀疑者”）。
- 未测试双击/后退/刷新等破坏性场景（属“破坏者”）；我只做了正常刷新，成果在刷新后仍存在（`screens/impatient-33-outputs-after-reload.png`）。
- 未创建新专家，未走“新建专家”路径；未测试运行失败/错误态。
- 未验证 `/agents` 全白是否可复现，未抓控制台错误（该页随后多次加载正常）。
- 未测下载、源码视图、基于此版本修改等后续动作。

## 关键结论（给主会话）

最高优先级：#1 成果入口不可发现（路径纯文本不可点 + 纯图标开关 + 无新成果提示），与 #2 对话页看不到/选不到专家（选择器藏在“显示会话历史”里、显示机器 ID）。两者都不是“测试报错”，而是首胜之后“拿成果/确认用了谁”的实际卡点。
