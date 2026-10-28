# 破坏者最终定点复跑：R-B01

**本轮结果：PASS。** 旧 FAIL R-B01 的单请求最小复现已在原 A 会话及新建会话各实测一次：发送 X 后，待接受期间重新输入完全相同的 X；接受后输入框与 sessionStorage 均保留，解除延迟后刷新、切 B 再返回也保留。普通发送后没有再输入时，接受后及刷新后输入框为空，已发送稿没有恢复。

这是破坏者一人的指定场景复跑，不代表其他用户重跑，也不代表全部破坏场景通过。旧报告 `rerun-breaker.md` 的 FAIL 原样保留，不覆盖、不改判。

## 环境与范围

- 日期：2026-10-28；截图 UTC 10:45:13–10:47:41；10:48:02 UTC 解除网络模拟并成功 finish，另含前置阅读与重新登录。
- 浏览器：ego-browser，TaskSpace `launchqa-breaker-final`，ID 12，仅 `p1`；桌面截图 1512×838。
- 应用：`http://localhost:3000`。用户说明此实例刚切至最终镜像，包含接受回调的 ownsRequest 先行与最新 input 非空时不 clearDraft。本轮验证当前实例行为，没有读取镜像摘要或独立证明具体源码版本。
- 先从工作台真实 UI 退出，再从登录表单重新登录。用户名/密码仅在浏览器脚本中读取指定 `auth.json`，未打印凭据、未在填密码时截图。
- 所有输入、发送、新建会话、A/B/C 切换均经真实 UI；只读 DOM / sessionStorage 辅助核验，没有写存储、mock、替换响应或直接调用业务 API 创建数据。
- 仅在本页通过 CDP `Network.emulateNetworkConditionsByRule` 对 `http://localhost:3000/api/chat` 施加 latency 8000ms，吞吐不限；其余请求不节流。A 和新会话各一次，刷新前均解除。
- 只用原破坏者唯一 QA 专家与 A/B；按本次要求新增一个同专家的 QA 会话 C。未操作非 QA 对象，未改源码、docs、配置、服务或权限，未派生代理，未 commit/push/merge。共享开发库中保留本轮测试消息及新会话。

## 对象与 URL

唯一专家：`QA破坏者复跑20261028-1118`，ID `agt_01m610x8cvfqabc8f1n8nwjg6d`。

- A（原会话）：`http://localhost:3000/chat?agent=agt_01m610x8cvfqabc8f1n8nwjg6d&conversation=conv_01m610xqnffqabc8fr8sjy3b98`
- B（原会话）：`http://localhost:3000/chat?agent=agt_01m610x8cvfqabc8f1n8nwjg6d&conversation=conv_01m6110qk6fqabc8km50yfbja2`
- 新建会话接受前：`http://localhost:3000/chat?agent=agt_01m610x8cvfqabc8f1n8nwjg6d`
- C（本轮新会话，接受后）：`http://localhost:3000/chat?agent=agt_01m610x8cvfqabc8f1n8nwjg6d&conversation=conv_01m611xc79f68veqpq3fz7k9c5`
- 收尾 URL：B。

截图目录绝对路径：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/launch-qa-first-run/.tmp/launch-qa/screens/`。下表中的截图文件名均相对于该目录。

## 实际阶段与结果

| 阶段 | URL | 判定 | 实测 | 截图 |
| --- | --- | --- | --- | --- |
| 应用可用与重新登录 | `/` → `/login` → `/` → A | PASS | 工作台正常加载；UI 退出并登录成功；A 历史可读 | 后续 A 截图可见真实应用；未截密码表单 |
| 普通 A 草稿刷新 | A | PASS | `QA-final-A普通草稿-20261028` 刷新后完整保留 | `rerun-breaker-final-01-a-normal-reload.png` |
| 普通草稿切换隔离 | A → B → A | PASS | B 写 `QA-final-B独立草稿-20261028`，返回 A 为 A 原稿；sessionStorage 同时含各自草稿 | `rerun-breaker-final-02-a-return-isolated.png` |
| R-B01：A 待接受期间重新输入同文 X | A | PASS | 点击发送起约 1198ms，页面仍显示“任务已提交，正在准备”，输入与 A 存储均为 X | `rerun-breaker-final-03-a-before-accept.png` |
| R-B01：A 接受后 | A | PASS | 约 9121ms 准备状态结束，出现本轮 run；输入与 A 存储仍为 X，B 独立草稿也保留；实际回复“A定点复跑完成” | `rerun-breaker-final-04-a-after-accept.png` |
| R-B01：解除网络延迟后刷新 A | A | PASS | 输入及 A 存储仍为完整 X | `rerun-breaker-final-05-a-reload.png` |
| R-B01：切 B 再回 A | B → A | PASS | B 为其独立草稿，回 A 仍为 X，未串稿 | `rerun-breaker-final-06-b-isolated.png`、`rerun-breaker-final-07-a-return-after-accept.png` |
| 新建会话初态 | 无 conversation 参数 | PASS | 输入为空，没有继承 A/B | 后续截图 08 属于发送后的待接受阶段，不冒充空态截图 |
| 新会话待接受期间重新输入同文 Y | 无 conversation 参数 | PASS | 约 1182ms 仍准备中，输入为 Y；存储暂存在空字符串会话键下 | `rerun-breaker-final-08-new-before-accept.png` |
| 新会话接受后 | C | PASS | 约 9094ms 接受，URL 获得 C；输入仍为 Y，存储转为 C 的键且删除空字符串键；实际回复“新会话定点复跑完成” | `rerun-breaker-final-09-new-after-accept.png` |
| 新会话解除延迟后刷新 | C | PASS | 输入与 C 存储完整保留 Y | `rerun-breaker-final-10-new-reload.png` |
| 新会话切 B 再返回 | C → B → C | PASS | B 仍为 B 原稿，返回 C 仍为 Y，存储含 A/B/C 各自草稿 | `rerun-breaker-final-11-new-return.png` |
| 普通发送，不再输入 | B | PASS | 发出测试消息后未再编辑，真实收到“普通发送完成”；输入为空，B 草稿键被清，A/C 草稿保留 | `rerun-breaker-final-12-normal-before.png`、`rerun-breaker-final-13-normal-after.png` |
| 普通发送后的刷新 | B | PASS | 输入仍为空，存储没有 B 键，没有把已发送稿恢复 | `rerun-breaker-final-14-normal-reload.png` |

## R-B01 证据明细

A 的 X（发送内容与等待期间重新输入内容逐字相同）：

`QA-final-A同文新稿-20261028：请只回复“A定点复跑完成”，不要创建文件。`

新会话的 Y（同样发送后重新输入逐字相同内容）：

`QA-final-新会话同文新稿-20261028：请只回复“新会话定点复跑完成”，不要创建文件。`

只读观测的存储键为 `pace.chat.drafts`：

- A before：`conv_01m610xqnffqabc8fr8sjy3b98` 对应 X，准备状态 true。
- A after / reload / 切 B 返回：同一键始终对应 X，接受后准备状态 false；与旧报告“输入仍在、A 键却被删”的 FAIL 不同，本轮持久化未丢失。
- 新会话 before：空字符串键对应 Y，准备状态 true；A/B 原键仍在。
- 新会话 after：新键 `conv_01m611xc79f68veqpq3fz7k9c5` 对应 Y，空字符串键已移除，准备状态 false。
- 新会话 reload / 切 B 返回：C 键及输入仍对应 Y。
- B 普通发送 after / reload：输入为 `''`，存储仅保留 A 的 X 与 C 的 Y，没有 B 键。

真实运行 ID：

- A：`run_01m611vkfrf68veqnrtyn12vsb`。
- C：`run_01m611xc7af68veqpr676yb3h5`。
- B 普通发送：`run_01m611yrfyf68veqqjb91kbwkh`。

本轮指定范围未发现新的 P0/P1/P2 问题；旧 R-B01 在以上两次单请求路径中通过。不推断未执行的交错分支。

## 工具过程与未覆盖

- 某次返回 A 定位失败，当前快照显示切 B 后历史侧栏已收起；随后重新展开并通过 UI 返回。属于脚本对当前状态判断不准，不计作产品 FAIL。
- 部分长 heredoc 浏览器调用被 worktree 守卫拒绝，未执行；改为单个 `ego-browser nodejs -e` 调用继续。未更改任何守卫或配置。
- 不重跑旧 R-B02 的旧请求/重发接受交错，没有逐请求 HAR 或回调顺序证据，因此不能单独声称 ownsRequest 对全部交错路径均正确。
- 未覆盖其他三位用户、全部破坏场景、待接受时刷新/切走、断网恢复、双击/防重、不同文字新稿、附件与成果引用、存储不可写或配额满、跨标签/关闭浏览器恢复、文件产出与下载、移动端、数据库/安全审计。
- 当前实例的实测不能证明未来镜像或所有网络时序。本轮没有源码修改或固定测试套件执行需求。
- brief/task 中“latest main”属于原基线，本次按用户说明验证最终修复实例；未独立核验镜像与 Git 提交对应关系，未修改 docs。

## 产物与收尾

仅新增本报告与 14 张 `rerun-breaker-final-*.png` 截图，所有截图均非空；旧报告仍保留 FAIL。旧报告 SHA-256（收尾读取）：`629309398cda968967ff361632275b4f1cad0acc87792f725601d43db4baddcc`。

结束前两项 CDP 恢复均成功返回：

- `Network.emulateNetworkConditionsByRule({ offline: false, matchedNetworkConditions: [] })` → `{ ruleIds: [] }`。
- `Network.emulateNetworkConditions({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })` → `{}`。

随后 `await task.finish({ keep: [] })` 已完成，输出 `{ finished: true }`，TaskSpace 12 不保留页面。最终 B 输入为空；A/C 未发送同文新稿保留至该标签页的会话生命周期结束。未声称关闭 TaskSpace 后可恢复 sessionStorage。
