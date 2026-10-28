# 首次用户 QA · 怀疑者（skeptic）

## 完成情况

- **已完成首次成功**：登录 → 创建 QA 专用专家 → 发送任务 → 收到回复 → 回复写入文件 → 打开「会话成果」并预览 `qa-skeptic-note.md`。
- 最终 URL：`http://localhost:3000/chat?agent=agt_01m60y0m4den99s05e74azhgtb&conversation=conv_01m60y54wgen99s06205xjdgf2&outputRun=run_01m60y6dbqen99s0754zxh7jp8&outputPath=qa-skeptic-note.md&outputMode=read`
- 首胜证据（前序会话已截图）：`screens/skeptic-26-first-reply.png`、`screens/skeptic-28-workspace-panel.png`、`screens/skeptic-29-file-preview.png`。
- 本次为恢复同一 TaskSpace 后的补查：约 10 轮浏览器操作，聚焦权限语义、删除确认、审计入口；未重发任务、未重复已完成的探索。总步数/总耗时未单独计时，不在此虚构。
- 未删除或修改任何现有对象；删除确认均只打开后取消。

## 问题表

| # | 严重度 | 步骤 | 期望 | 实际 | 证据 | 阻断首胜 | 命中估计 |
|---|---|---|---|---|---|---|---|
| S01 | **P1** | 专家 → 权限 → 绑定连接器后理解授权范围 | 明确告诉我「绑定连接器 = 该连接器全部工具自动放行，不逐次审批」 | 页面只在小字写「留空表示全部已绑定工具」；上方黄色警告只讲内置工具（Bash/文件/网络）。运行时会把每个已绑定 MCP server 的 `mcp__<server>__*` 直接加入预批准列表，而默认 `dontAsk` 会拒绝未预批准项，因此绑定连接器实际等于默认放行其全部工具。怀疑者无法从界面判断「我绑定它以后，它能不能直接动我的数据」 | `screens/skeptic-07-agent-permissions.png`、`screens/skeptic-34-permission-mode-options.png`；界面文案 `packages/web/src/pages/agents.tsx:1341-1344`；运行时自动放行 `packages/sandbox/src/runner.ts:249` | 否 | 2/5（怀疑者、需要接连接器的管理员；本次未真实绑定连接器） |
| S02 | **P1** | 专家 → 权限 → 权限模式选「default — 标准权限」 | 「标准权限」意味着有交互审批或至少与「拒绝未预批准」不同 | 文档明确记录：`default` 在沙盒中没有可交互宿主，实际行为接近 `dontAsk`。界面没有任何提示，怀疑者会以为选了「标准权限」就有人在把关，实际仍按预批准列表静默放行/拒绝 | 权限页 `screens/skeptic-34-permission-mode-options.png`；下拉选项经 DOM 读取为 `dontAsk — 拒绝未预批准 / plan — 只规划不执行 / default — 标准权限 / acceptEdits — 自动接受编辑`；依据 `docs/DECISIONS-PENDING.md:216`（D-20 已知边界） | 否 | 1/5（只有主动改权限模式的人；但属于安全期望错位） |
| S03 | P2 | 专家 → 权限 → 看「自定义允许的工具」输入框 | 空框看起来是空的；示例不要伪装成已配置值 | 输入框实际 `value=""`，但占位符是两行 `mcp__jsonplaceholder__get_user`、`mcp__crm__*`，视觉上像已填好的白名单；怀疑者容易误判「这个专家已经放行了两个连接器」 | `screens/skeptic-07-agent-permissions.png`、`screens/skeptic-34-permission-mode-options.png`；DOM 实测 `{ value: '', placeholder: 'mcp__jsonplaceholder__get_user\nmcp__crm__*' }` | 否 | 1/5 |
| S04 | P2 | 专家 → 权限 → 读权限模式名称 | 中文界面用中文解释每个模式的后果 | 四个选项均以 SDK 标识符开头（`dontAsk`、`plan`、`default`、`acceptEdits`），且「自动接受编辑」没有像内置工具那样给出风险提示 | `screens/skeptic-34-permission-mode-options.png`；`packages/web/src/pages/agents.tsx:1341-1344` | 否 | 1/5 |
| S05 | 范围观察（非缺陷） | 查找 pricing / Terms / Privacy / 账户级数据保留与导出 | 首次用户能找到商业与数据条款 | 产品无这些页面；账户菜单只有「退出登录」。审计页有「导出审计」和筛选，但不能按会话导出；这是既有产品范围（单管理员、自部署），按要求只记范围观察 | `screens/skeptic-03-account-menu.png`、`screens/skeptic-31-resumed-audit.png` | 否 | — |

## 已验证通过的关键确认与审计入口

- **专家删除确认**：明确写出「它的会话、消息与绑定关系会一并删除，正在运行的任务不会被自动停止。此操作不可撤销。」；按钮为「取消 / 删除」，未误触。`screens/skeptic-13b-delete-confirm-stable.png`
- **会话删除确认**：明确写出「及其消息、运行记录会被永久删除，无法恢复。」；本次只打开确认后取消。`screens/skeptic-33-delete-conversation-confirm.png`
- **审计入口**：系统 → 审计，支持动作前缀、目标精确筛选、状态筛选、导出审计；明确标注「输入只保存摘要，不落原文」。本次真实看到 `agent.created`、`agent.updated`、`agent.run.requested/started/finished`，展开项含操作者与事件 ID。`screens/skeptic-31-resumed-audit.png`
- **审批待处理入口**：工作台「需要处理」聚合「等待批准的调用或失败运行」，空态文案为「没有等待批准的调用或失败的运行」。`screens/skeptic-02-after-login.png`
- **首胜可追溯**：消息底部「查看详情」可到运行详情；会话成果支持阅读/源码/下载/基于此版本修改。`screens/skeptic-28-workspace-panel.png`

## 未覆盖

- **真实工具审批挂起与恢复**：需要给专家绑定一个 `requiresApproval` 的 MCP 工具并触发调用；本次不修改连接器配置，未执行。无法验证聊天内批准卡片、超时、批准后同一次调用继续。
- **审计导出文件内容与条数范围**：只确认按钮和筛选存在，未下载导出文件。
- **数据保留/清理策略**：未触发维护任务，未验证 `maintenance.pruned` 的实际保留窗口。
- **多用户权限隔离**：产品为单管理员，未测试第二账号。
- **真实破坏性操作**：按要求未执行删除专家/会话/连接器，也未放宽权限。

## 环境限制

- 共享开发库：进入时已有 85 个专家、3329 个连接器、大量历史运行；不是干净的首次安装环境。专家选择器里出现机器名、历史记录混杂属于环境放大，不能全部归因于首次用户流程。
- 本次为恢复被中断的同一 TaskSpace 后续做补查；首胜与大部分截图来自前序会话，报告中未把它们重复计为本次新完成的工作。
