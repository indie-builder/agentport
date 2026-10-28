# 首次用户 QA · 不耐烦（impatient）· 修复后重跑

- TaskSpace：`launchqa-rerun-impatient`（space 9，结束已 `finish({ keep: [] })`）
- 环境：`http://localhost:3000`，桌面 1512×838，中文；从登录页开始（先登出既有 admin 登录态，再用 QA 凭据登录）
- 时间：2026-10-28
- 结论：**PASS（首胜完成，首轮问题 1/2 均闭合）**

## 首胜是否完成

完成。路径（真实浏览器，无 mock）：

1. `/login`：输入 QA 用户名/密码 → 点「进入工作台」，1.1s 落到工作台 `/`。
2. 点右上「新建对话」→ `/chat`（1.4s）。
3. 欢迎态**直接可见专家选择控件**：头像 + 名称 + `chevron`，`aria-label="选择专家"`，默认显示 `md-tools-f307a5e9-4`，位于「今天想完成什么？」标题右侧。
4. 点开选择器：搜索框 placeholder「搜索名称、角色或 Slug…」，列表每项显示「名称 + 角色」。输入 `QA` → 命中 4 个 QA 专家，选择 `QA怀疑者20261028-01`；选择器自动关闭，入口文字更新为该专家名，URL 变为 `/chat?agent=agt_01m60y0m4den99s05e74azhgtb`。
5. 输入生成文件的任务（写 `/mnt/outputs/rerun-impatient-20261028.md`）→ Enter 发送；约 6.8s 完成，回复「已保存到 `/mnt/outputs/rerun-impatient-20261028.md`，点右上角「会话成果」即可预览或下载。」
6. 右上角**有可见文字**「会话成果」（92×32 按钮，x=1080/1400，随面板开关在两态间切换文字为「隐藏会话成果」）。
7. 点击后右侧打开「会话成果」面板，列出 `rerun-impatient-20261028.md`（刚刚）；点文件名后出现 阅读/源码/下载 与渲染后的报告正文（标题「重跑验证报告」、日期、要点列表），URL 带 `outputRun=…&outputPath=…&outputMode=read`。

操作步数：8 次点击/输入；纯操作耗时约 15s（登录 1.1s、进对话 1.4s、发送到完成 6.8s）。

最终 URL：`http://localhost:3000/chat?agent=agt_01m60y0m4den99s05e74azhgtb&conversation=conv_01m610ymfvfqabc8hp5430mvnt&outputRun=run_01m610ymfxfqabc8hr61qhdbd6&outputPath=rerun-impatient-20261028.md&outputMode=read`

## 首轮问题闭合情况

| 首轮 # | 首轮问题 | 本轮实测 | 结论 |
|---|---|---|---|
| 2 | 成果入口是纯图标；文件出现无提示，用户不知道去哪看 | 空态与回复后右上角均常驻**文字**「会话成果」；打开后文件列表 + 可预览；回复正文直接写「点右上角「会话成果」即可预览或下载」 | **闭合** |
| 1 | 对话页无可见专家选择，入口藏在默认收起的「会话历史」里，且只显示机器名 | 欢迎态正中就是专家选择入口并显示当前专家；搜索支持名称/角色/Slug，列表同时显示名称与角色；选择后即时回填 | **闭合（主路径）** |

## 新问题 / 残留观察

| # | 严重度 | 步骤 | 期望 | 实际 | 证据 | 是否阻断首胜 |
|---|---|---|---|---|---|---|
| N1 | P2 | 发送后再看顶部 | 能确认是哪个专家在回答 | 顶部只显示会话标题（首条 prompt 截断）与「会话成果」；专家名不再出现（欢迎态消失）。刷新/从历史进入也无法确认应答者 | `screens/rerun-impatient-10-reply.png` | 否（本轮已在欢迎态主动选过；未选专家直接发送的用户仍无从确认） |
| N2 | P2 | 默认（未搜索）打开专家选择器 | 显示可读名称 | 触发器与列表第一列仍是机器名 `md-tools-f307a5e9-4`，角色「通用助手」作为次级行；共享库中大量同名/机器名专家，默认列表难以区分 | `screens/rerun-impatient-06-expert-picker.png` | 否（可用搜索绕过） |
| N3 | P2 | 回复中的 `/mnt/outputs/...md` | 可点击打开成果 | 仍是普通 `<code>`（不在 a/button 内，cursor auto），只有按钮可点 | `screens/rerun-impatient-10-reply.png` | 否（按钮文字已可发现） |
| N4 | P2 | 会话标题 | 简短名称 | 仍以首条消息全文截断为标题（首轮 #7，本轮未修，与预期一致） | `screens/rerun-impatient-10-reply.png` | 否 |

## 未覆盖

- 未测刷新/切会话草稿（属破坏者）、权限审批（属怀疑者）、新建专家路径（属字面理解者）。
- 未测下载、源码视图、「基于此版本修改」的实际结果。
- 未验证窄屏 → 放大到 lg 时专家选择器是否仍在（首轮独立复核的 3 项之一，属其它 persona 范围）。
- 共享开发库环境：默认专家为历史机器名数据，非本轮代码文案问题。

## 截图

- `screens/rerun-impatient-03-login.png`（/login）
- `screens/rerun-impatient-04-after-login.png`（登录后工作台）
- `screens/rerun-impatient-05-new-chat.png`（欢迎态：可见专家选择 + 可见「会话成果」）
- `screens/rerun-impatient-06-expert-picker.png`（选择器默认列表）
- `screens/rerun-impatient-07-picker-search.png`（搜索 `QA` 命中 4 个）
- `screens/rerun-impatient-08-expert-selected.png`（已选 `QA怀疑者20261028-01`）
- `screens/rerun-impatient-09-sent.png`（发送后等待）
- `screens/rerun-impatient-10-reply.png`（回复 + 右上「会话成果」文字）
- `screens/rerun-impatient-11-outputs-open.png`（成果面板列出文件）
- `screens/rerun-impatient-12-file-preview.png`（文件渲染成功）
- `screens/rerun-impatient-13-conversation-menu.png`（会话操作菜单）
