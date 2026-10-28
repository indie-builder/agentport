# 破坏者复跑：首胜与 B01/B02

- **总结果：FAIL，仍有未发送草稿丢失。** 常规刷新、A/B 草稿隔离、新建会话、发送接受前切走、断网失败后的原稿恢复均通过；发送等待期间重新输入相同文字的新草稿，会在请求接受后失去持久化，刷新后丢失。同文重发交错场景也复现。
- 首胜：PASS，重新登录 → 创建唯一 QA 专家 → 从“开始对话”进入 → 发送任务 → 真实收到“复跑首胜完成”，页面显示完成、1 轮、3.2s。
- 环境：`http://localhost:3000`，桌面中文，1512×838；共享开发数据库。测试的是本轮部署，不能以 brief 中“latest main”断言运行源码的精确版本。本轮未启动、重建或修改服务。
- 日期：2026-10-28，主要截图时段 UTC 10:28:50–10:37:04，约 8 分钟，另含前置阅读/重新登录。约 23 个逻辑步骤，34 张非空截图。
- ego-browser TaskSpace：`rerun-breaker`，ID 8；只有一个页面 `p1`。
- 边界：只用真实 UI 创建/发送/切换；未 mock 或伪造响应。为稳定进入请求待接受窗口，通过本页 CDP Network 临时施加延迟/断网，结束前已解除两种网络模拟。未放宽权限、未删除既有数据、未修改源码/docs/配置、未 commit。
- 凭据由浏览器脚本从指定 0600 文件读取；报告和截图未记录密码或 Cookie。

## 本轮唯一专家和会话

专家：`QA破坏者复跑20261028-1118`，slug `qa-rerun-breaker-20261028-1118`，ID `agt_01m610x8cvfqabc8f1n8nwjg6d`。保持默认权限；提示词只要求一句中文回应且无明确文件要求时不操作外部系统。

A：`http://localhost:3000/chat?agent=agt_01m610x8cvfqabc8f1n8nwjg6d&conversation=conv_01m610xqnffqabc8fr8sjy3b98`

B：`http://localhost:3000/chat?agent=agt_01m610x8cvfqabc8f1n8nwjg6d&conversation=conv_01m6110qk6fqabc8km50yfbja2`

首胜运行：`run_01m610xqnhfqabc8g7p9xxnjqp`。所有后续测试均使用上述唯一专家与 A/B 两个本轮新建会话，保留测试对象。

所有截图位于：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/launch-qa-first-run/.tmp/launch-qa/screens/`。下表/步骤中的名称均以该目录为基准。

## 结果表

| 检查 | 判定 | 实测结果 | 证据截图 |
| --- | --- | --- | --- |
| 正常首胜 | PASS | 可见专家选择；从创建后“开始对话”直接选中本轮专家；真实收到回复 | `rerun-breaker-01-login.png`、`02-create.png`、`03-before-first-send.png`、`04-first-result.png`（后三者完整前缀均为 `rerun-breaker-`） |
| B01：A 未发送草稿 → 刷新 | PASS | `QA-A刷新保留-20261028-1118` 刷新前后输入框完全一致 | `rerun-breaker-05-a-draft-before-refresh.png`、`rerun-breaker-06-a-draft-after-refresh.png` |
| B02：A → 新建会话 | PASS | 新页面 URL 无 conversation 参数，输入框为空，不继承 A | `rerun-breaker-07-new-empty.png` |
| 建立 B | PASS | B 真实收到“B会话完成” | `rerun-breaker-08-b-send.png`、`rerun-breaker-09-b-created.png` |
| B02：A/B 草稿隔离 | PASS | B 为 `QA-B独立草稿-20261028-1118`；切 A 恢复 `QA-A刷新保留-20261028-1118`；回 B 仍为 B 原稿 | `rerun-breaker-10-b-draft.png`、`rerun-breaker-11-switch-a-isolated.png`、`rerun-breaker-12-switch-b-isolated.png` |
| A 发送接受前切 B，接受/完成后返回 A | PASS | 待接受时输入框暂空，但 A 原稿存储仍在；切走后 B 不串稿；回 A 保留 `QA-A接受前切走-20261028-1118-03`，消息历史也确认服务器已处理该条 | `rerun-breaker-17-pending-a.png`、`rerun-breaker-18-pending-left-a.png`、`rerun-breaker-19-return-a-after-pending.png` |
| A 断网发送失败并切 B，再回 A | PASS | 页面提示“连不上 API 服务，请确认它已启动并检查网络后重试。”；A 原稿 `QA-A断网失败保留-20261028-1118` 完整恢复 | `rerun-breaker-20-before-offline-send.png`、`rerun-breaker-21-offline-switch-b.png`、`rerun-breaker-22-offline-return-a.png` |
| 等待期间输入相同文字的新稿 → 接受 → 刷新 | **FAIL / P0 未发送草稿丢失** | 接受后输入框仍显示同文新稿，但 sessionStorage 已无 A 草稿；刷新输入框为空 | `rerun-breaker-23-same-text-before-accept.png`、`rerun-breaker-24-same-text-after-accept.png`、`rerun-breaker-25-same-text-after-reload.png` |
| 切走返回后同文重发，并再写同文新稿 | **FAIL / 同一 P0** | 旧发送与重发均真实执行，历史中有 2 条相同用户消息；接受后新稿仍在输入框但持久化被清，刷新为空 | `rerun-breaker-30-interleaved-old-send.png`、`rerun-breaker-31-interleaved-return.png`、`rerun-breaker-32-interleaved-resend-new-draft.png`、`rerun-breaker-33-interleaved-after-accepts.png`、`rerun-breaker-34-interleaved-after-reload.png` |

## R-B01：新问题，同文新稿被接受回调清掉持久化

严重度按任务规则为 P0（未发送草稿丢失），未阻断本轮首胜。不是已发送消息丢失。

最小复现（会话 A）：

1. 等 A 的上一轮运行完成。
2. 输入 `QA-A同文新草稿-20261028-1118`。
3. 通过本页 `Network.emulateNetworkConditions` 将网络 latency 临时设为 8000ms，不改服务器或应用代码。
4. 点击“发送消息”，页面显示“任务已提交，正在准备”。
5. 在请求仍待接受时，重新在输入框输入完全相同的 `QA-A同文新草稿-20261028-1118`，不要再发送。截图 23。
6. 等待准备状态结束，原请求被接受。截图 24：输入框仍显示新稿。
7. 恢复正常网络，刷新。截图 25：输入框为空。

只读存储观测与 UI 一致：

- 接受前：输入框为上述文本；`pace.chat.drafts` 同时含 A 的该文本与 B 的独立草稿。
- 接受后：输入框仍为该文本；`pace.chat.drafts` 只剩 B，A 键被删除。
- 刷新后：A 输入框 `''`；B 草稿仍在。

期望：用户在发送后重新写的草稿应按“新的一次编辑”保存，即使文字与已发送消息相同。旧发送的接受不应使其仅暂时可见、刷新后消失。

源码只读定位（未修改）：`packages/web/src/lib/chat-store.ts:129` 的 `clearDraft` 只以字符串相等判断清除；`packages/web/src/lib/use-chat-stream.ts:512` 在接受时调用它。实际浏览器复现与该行为吻合，不将代码推断代替实测。

## R-B02：同文重发交错场景

1. A 输入 `QA-A同文重发交错-20261028-1118-02`。
2. 使用本页 CDP `Network.emulateNetworkConditionsByRule`，只对 `http://localhost:3000/api/chat` 施加 12000ms latency，其他会话加载请求正常；不拦截或替换响应。
3. 点击发送，待接受时切 B，再切回 A。A 恢复原稿，截图 30/31。
4. 在前次服务器运行已结束、但待接受响应仍可能交错的窗口，点击发送同文。
5. 在重发的等待期间，再输入完全相同的新稿，不发送，截图 32。
6. 等准备状态结束。截图 33：输入框有新稿，但 A 的持久化键已消失。
7. 解除本页网络规则后刷新，截图 34：输入框为空。
8. 页面历史只读计数确认 2 条正文完全等于该测试文本的用户消息，说明是实际同文再发送；未声称防重行为有问题，因为第二次是用户主动发送。

判定：完整用户路径仍会丢新稿，FAIL。**未保存逐请求网络时序，不能把第 6 步清除单独归因于旧请求还是重发请求的接受回调**；单请求最小复现 R-B01 已独立证实同文编辑会被清持久化。

## 其他观察与工具限制

- `rerun-breaker-13` 至 `16` 及 `26` 至 `29` 是用于校准待接受/会话加载窗口的真实操作截图。部分尝试在下一工具轮前已经接受，或因整页网络延迟导致会话加载超过默认 10 秒；这些尝试不计作独立失败或通过证据，最终结论以上述稳定复现为准。
- 首胜等待条件误写为页面包含“已完成”，实际状态文案是“完成”，因此工具等待超时；后续快照与截图确认 3.2 秒即完成，不判定为首胜超时。
- 断网提示 Toast 曾遮挡发送按钮，ego 报 `<div> intercepts pointer events`。关闭 Toast 后继续。截图 `rerun-breaker-23a-current-layout.png` 保留此时状态；未单独扩大范围调查它是否在不同窗口下持续遮挡，不计为已确认产品问题。
- 部分 UI 查询因按钮与子元素同文/标题附带时间而产生定位歧义，均通过当前快照纠正；不计为产品错误。
- B03 在本次从新建专家进入路径已改善：创建后有“开始对话”，欢迎态可见所选专家。本轮没有专项重跑旧 B04。
- brief 中“latest main”与任务记录中的本 worktree 修复部署描述不是同一精度的环境声明；本报告仅证明当前 `localhost:3000` 的实测行为。未修改文档。

## 未覆盖

- 未单独证明“旧请求”的接受回调在同文重发后的准确到达顺序；没有记录 HAR、请求 ID 或逐请求时间线。
- 未测关闭整个浏览器/标签页后恢复；本轮只测同页刷新、导航切换和 sessionStorage，不能推断跨标签页或跨浏览器保留。
- 未测发送待接受时刷新这一额外分支、存储不可写/配额满、不同文字的新草稿、附件/成果引用草稿。
- 没有文件产出任务，因此未检查生成文件/下载；首胜定义已由真实文本回复满足。
- 未做数据库审计、并发运行防重证明、移动端、权限放宽、既有数据异常操作或无关管理页。

## 收尾

本轮仅新增指定报告和 `rerun-breaker-*.png` 截图；测试专家/会话保留。两类本页网络模拟已恢复，最终 URL 为 A，A 输入框为空（丢稿复现结果），B 独立草稿仍在。

最终浏览器调用已执行并成功返回 `finish({ keep: [] })`，输出 `{ finished: true }`；TaskSpace 8 已结束，不保留浏览器页面。
