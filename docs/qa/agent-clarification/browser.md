# 真实浏览器验收：原生澄清提问与同 run 继续

验收时间：2026-10-28。环境为本工作树的隔离服务 `http://127.0.0.1:63479`，独立 PG/Redis/workspaces；桌面浏览器（ego-browser TaskSpace `clarify-live-browser`）。未改源码、未派生代理、未停止隔离服务。

## 对象

- runId：`run_01m615835wend8jchq4n0rqmfj`（回答前后不变）
- conversationId：`conv_01m615835vend8jch9hqm4xan3`
- agentId：`agt_01m615835cend8jcgqnr0vc80z`
- 专家：`QA clarification e8a23046`（隔离环境内唯一）
- 问题：`这份报告的目标受众是谁？`（header `受众`，单选）
- 选项：`产品经理`（value `0`）、`工程师`（value `1`）、其他
- 实际回答：`产品经理`
- 交付文件：`report.md`（196 B，正文首行 `产品经理`）

agentId 通过页面内只读 `GET /api/runs/:id`（浏览器已登录 cookie）取得，未直接调用写接口；答案只经页面表单提交。

## 步骤与结果

1. 隔离域真实登录（截图 `01-login.png`、`02-workspace.png`）。未登录/登出 `localhost:3000`。
2. 从对话历史进入本 run 会话，待答卡可见，`提交回答` 可用（`04-pending-card.png`）。
3. 刷新页面后待答卡仍在，未变为只读，`提交回答` 仍可操作（`05-after-refresh.png`）。
4. 运行详情页在同一位置显示同一待答卡；当时仅有 1 条「用户消息」步骤，无已落库工具步骤（`06-run-detail-pending.png`）。
5. 返回对话，用键盘聚焦并空格选中 `产品经理`（radio `checked=true`，`07-keyboard-selected.png`），随后真实鼠标点击 `提交回答`（native CDP click，`08-answered.png`）。
6. 卡片变为 `已回答` 且记录 `产品经理`；同一 run 继续，依次出现 `ToolSearch`、MCP 工具、`Write` 步骤（`08-answered.png`、`09-continued.png`）。
7. MCP 审批由后台 withapproval 脚本按其流程等待并自动批准，本会话未手动批准任何非本轮对象。
8. 运行完成：5 轮、206.7 s、$0.088，提示 `report.md` 已写入 `/mnt/outputs/report.md`（`09-continued.png`）。
9. 打开「会话成果」并预览 `report.md`，内容首行为 `产品经理`，含 `接口验收报告`、受众/验收状态/范围与结论（`10-artifact-preview.png`、`11-artifact-content.png`）。

## 对后台脚本的放行

刷新与 UI 回答均成功后，创建了脚本实际等待的 `.tmp/clarification-live/run-mvs1rw6g-d8c2dd/browser-verified`，并按任务用语同时创建空文件 `pending.marker`。主会话未重复回答。

## 截图

均位于 `docs/qa/agent-clarification/screens/`，逐张查看确认非空：

- `01-login.png` 隔离域登录页
- `02-workspace.png` 工作台与运行中 run
- `03-chat-list.png` 新建对话默认专家
- `03-chat-history.png` 唯一会话历史
- `04-pending-card.png` 对话内待答卡
- `05-after-refresh.png` 刷新后待答卡仍可答
- `06-run-detail-pending.png` 运行详情同卡（仅用户步骤）
- `07-keyboard-selected.png` 键盘选中产品经理
- `08-answered.png` 提交后已回答、同 run 继续
- `09-continued.png` MCP/Write 完成、运行完成
- `10-artifact-preview.png` 会话成果列表
- `11-artifact-content.png` report.md 预览内容

## 限制

- 单一 run、单一单选问题、两个正常选项加「其他」；未覆盖多选、多题、拒答、停止、超时与刷新后他人回答等路径。
- 仅桌面 Chromium；未验证移动端（项目本身仅面向桌面）。
- 真实模型与 MCP 审批依赖隔离环境；本轮未重复验证审批 UI 本身，只确认脚本自动批准后工具完成。
- 未运行全量测试，未提交任何源码改动；本文件与截图为本轮仅有的仓库产物。
- 浏览器自动化为 ego-browser 自定义 API；提交按钮使用真实 CDP 点击，选中由键盘完成，未通过 API 伪造答案。
