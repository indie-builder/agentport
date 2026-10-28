# 怀疑者重跑（rerun-skeptic）

## 结论

**PASS：权限文案准确，指定的创建流程检查与首次成功全部通过。**

- 环境：`http://localhost:3000`，真实 ego-browser，桌面视口 1512×838。
- TaskSpace：`rerun-skeptic`，ID `10`；从已有登录态退出后，用指定本地凭据重新登录。未输出密码、cookie 或 token。
- 路径：重新登录 → 专家列表 → 只读查看既有 QA 专家的权限 → 展开权限模式但不更改选择 → 返回列表 → 新建唯一 QA 专家（只填写名称，标识留空）→ 点击「开始对话」→ 发送任务 → 收到完成回复。
- 新建专家：`QA怀疑者复跑20261028-1124`，ID `agt_01m610yc53fqabc8gvtvass2ea`，自动生成标识 `qa-20261028-1124`；保留在环境中。
- 首次任务：「请给我一份三项的今日工作启动清单，每项一句话，直接在对话里回复即可。」
- 真实回复为三项工作启动清单；状态「完成」，1 轮，5.9 s，界面成本 `$0.010`。
- 首胜截图时间：`2026-10-28T10:30:40.738Z`；完整操作总耗时未独立计时，未虚构。
- 最终 URL：`http://localhost:3000/chat?agent=agt_01m610yc53fqabc8gvtvass2ea&conversation=conv_01m610yz1bfqabc8jkjw9mszcx`
- 运行：`run_01m610yz1cfqabc8jxgwy5czkz`。

## 验收项及文案原句

| 检查 | 结果 | 页面原句 / 实测行为 | 证据 |
|---|---|---|---|
| 连接器预批准限定在 SDK 层，同时明确工具服务端审批 | **PASS** | 「平台将绑定连接器的全部工具加入 SDK allowedTools 预批准；工具若设置 requiresApproval，仍须通过服务端审批，可挂起等待批准。请仅绑定可信连接器。」 | `../screens/rerun-skeptic-01-permissions.png` |
| default 不再被描述为完全没有人工审批 | **PASS** | 「default 在沙盒中不提供 SDK 层交互审批宿主；连接器工具仍可能触发服务端审批。」模式列表仍为「default — 标准权限」，但旁边明确区分两层机制，没有声称所有工具无需审批。 | `../screens/rerun-skeptic-01-permissions.png`、`../screens/rerun-skeptic-02-mode-options.png` |
| 自定义工具列表不会限制已绑定连接器 | **PASS** | 「每行一个额外允许的工具名或模式，如 mcp__crm__*；不会限制已绑定连接器的工具。」 | `../screens/rerun-skeptic-01-permissions.png` |
| 名称优先、标识可选 | **PASS** | 第一项为「名称 *」，第二项为「标识（可选）」；提示「留空时由名称自动生成；仅支持小写字母、数字、- 和 _，创建后不可修改。」填写名称后，DOM 读取确认 slug 的实际 value 为 `""`；点击创建成功生成 `qa-20261028-1124`。 | `../screens/rerun-skeptic-03-create-name-first.png`、`../screens/rerun-skeptic-04-created-start-chat.png` |
| 创建后有开始对话 | **PASS** | 创建后进入该专家配置页，右上角可见「开始对话」，通知为「专家已创建」；点击后对话页专家选择器显示新专家名称。 | `../screens/rerun-skeptic-04-created-start-chat.png` |
| 完成一次首胜 | **PASS** | 发送一条任务并收到三项清单，状态「完成」。本次仅要求对话文本，未要求或产生可见文件。 | `../screens/rerun-skeptic-05-first-success.png` |

权限页 URL：`http://localhost:3000/agents/agt_01m60y0m4den99s05e74azhgtb?section=permissions`。查看时原权限为 `dontAsk — 拒绝未预批准`，仅展开选项，未选择其他模式、未保存任何既有对象。

## 原问题闭合与新问题

- **S01 / S02：本轮文案验收已闭合。** 旧报告 S01 使用「全部工具自动放行，不逐次审批」这一笼统期待，本轮已按当前验收要求明确区分 SDK 预批准和 `requiresApproval` 的服务端审批，不能继续把两者等同。
- 本轮未发现新的 P0/P1 或阻断首胜的问题。
- 旧有低优先级观察仍存在：权限列表继续使用 `dontAsk` / `plan` / `default` / `acceptEdits` 标识；自定义工具框仍显示示例占位文字，视觉仍可能让人误以为已经配置。这两项是原报告 S03/S04，未计为本轮新增问题；没有阻断本轮首胜。
- 共享开发库中仍有大量既有专家与连接器，也观察到其他 QA 任务并行创建新专家；本轮只创建自己的唯一 QA 对象，不把列表数量变化判为缺陷。

## 未覆盖与限制

- **未触发真实 requiresApproval 工具调用，也未验证服务端挂起、批准、恢复、拒绝或超时。** 本报告的「权限文案准确」只证明真实页面明确表达了用户要求的两层机制，不以文案通过冒充运行时审批通过。
- 未绑定连接器、未添加允许工具、未更改权限模式，未验证其实际执行差异。
- 本次任务为纯文本回复，没有生成文件，因此未打开成果文件预览、下载或版本修改。
- 未重跑删除确认、审计导出、数据保留策略、多用户隔离或任何破坏性操作。
- 未检查移动端，按任务范围排除。
- 没有修改源码、docs、配置或已有业务数据，没有 commit/push/merge；产物仅为本报告和 5 张指定前缀截图。

## 截图清单

1. `.tmp/launch-qa/screens/rerun-skeptic-01-permissions.png`
2. `.tmp/launch-qa/screens/rerun-skeptic-02-mode-options.png`
3. `.tmp/launch-qa/screens/rerun-skeptic-03-create-name-first.png`
4. `.tmp/launch-qa/screens/rerun-skeptic-04-created-start-chat.png`
5. `.tmp/launch-qa/screens/rerun-skeptic-05-first-success.png`
