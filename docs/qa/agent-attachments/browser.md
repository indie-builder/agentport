# 聊天附件桌面浏览器真实验收

- 日期：2026-10-28
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/agent-attachments`
- 隔离服务：`http://127.0.0.1:57718`（独立 PostgreSQL / Redis / workspaces；未触碰 `localhost:3000`）
- 浏览器：ego-browser，TaskSpace `attach-live-browser`，视口 1512 × 838（桌面 1512 宽）
- 夹具：`.tmp/attachments-live/fixtures/data.csv`、`login.png`
- **总判定：附件链路 PASS；内容断言 FAIL。**
  - 上传、发送、附件标签、运行期禁用、下载字节校验、刷新持久化全部通过。
  - `report-ui.md` 可读且含 `128`，但图片品牌写成 `FACE`，未含 `PACE`，违反“确认含 128 与 PACE”的验收断言。夹具图片本身是 `PACE` 登录页，模型读图错误，不是附件串包（存量 `login.png` sha256 与夹具一致）。

## 关键标识

| 项 | 值 |
| --- | --- |
| 专家 | `agt_01m6199bd1enatec3z4v9ekrg8`（附件真实验收专家） |
| 会话 | `conv_01m619xhgyenateccdgb0dampb` |
| 真实 runId | `run_01m619xhhnenateccjzsxha47d` |
| 会话 URL | `http://127.0.0.1:57718/chat?agent=agt_01m6199bd1enatec3z4v9ekrg8&conversation=conv_01m619xhgyenateccdgb0dampb` |
| 运行耗时 | 32.3 s（UI 首读）/ 32.1 s（刷新后回读）；worker 记录 32.1 s，4 轮，$0.085 |
| 附件 A | `data.csv`，21 B，id `631486e1-d9e8-4da8-b8fa-753f31309ca9` |
| 附件 B | `login.png`，21 KB，id `f53ff330-8ddc-4e82-bf0f-9e8914590ac0` |

## 逐步结果

| 步骤 | 实测 | 结果 |
| --- | --- | --- |
| 真实登录 | 用户名取 `state.json` 的 `adminUser`，密码取 `secrets.json` 的 `adminPassword`；表单提交后进入工作台 | PASS |
| 新建对话 | `/chat` 欢迎态，专家自动选中“附件真实验收专家” | PASS |
| 真实文件选择 | 点击“添加资料”触发文件框，`setFiles` 选择 `data.csv` 与 `login.png` | PASS |
| 输入区显示 | 两枚 Badge：`data.csv 21 B`、`login.png 21 KB`；各有 `移除 <文件名>` 按钮 | PASS |
| 空正文可发送 | 正文为空、`textarea.value === ""` 时发送按钮 `disabled === false` | PASS |
| 发送 | 输入指定提示词并点击发送；用户消息立即出现，含两个附件标签与下载链接 | PASS |
| 运行期禁用 | `button[aria-label="添加资料"].disabled === true`，发送位切换为“停止运行” | PASS |
| 运行完成 | 三个工具行 Read/Read/Write 完成；状态“完成 · 4 轮 · 32.3s · $0.085” | PASS |
| 下载 data.csv | 用户消息附件标签触发真实下载，`suggestedFilename=data.csv`，21 B | PASS |
| 下载字节校验 | `sha256=6fce2f15fdca0b86270b4faf6780cdaa551fb360b05f89ed9e2e30a7dd8e84a8`，与夹具一致 | PASS |
| 会话成果 | 右侧“会话成果”列出 `report-ui.md`（25 B），可读，正文 `华东,128` / `品牌：FACE` | 可读 PASS；含 `128` PASS；含 `PACE` **FAIL** |
| 刷新持久化 | 刷新后用户消息两个附件标签和下载链接仍在；成果预览仍可打开 | PASS |

`report-ui.md` 全文（原始字节）：

```text
华东,128
品牌：FACE
```

`data.csv` 下载落盘校验：

```text
6fce2f15fdca0b86270b4faf6780cdaa551fb360b05f89ed9e2e30a7dd8e84a8  docs/qa/agent-attachments/data.csv
```

存量附件文件交叉校验（排除串包）：`login.png` 的 sha256 为
`3920b650b3d9592a390d4624c7647f53fd383b4292873eab2927597c6f005b79`，与夹具一致。

## 错误与偏差

1. 首次登录 401：从 `secrets.json` 中按“非 adminPassword / appSecretKey”推断用户名的做法取到了 43 字符的第三个密钥，而非用户名；用户名实际在 `state.json.adminUser`。改读 `state.json` 后登录成功。属验收脚本取数错误，不是产品缺陷。
2. 内容断言失败：模型把 `login.png` 中风格化的 `PACE` 识别为 `FACE`。工具链（Read 两个附件、Write 成果、下载、持久化）均正常；这是模型视觉读取质量问题。

## 未覆盖

- 未点击“移除”验证移除后的实时行为，只确认两个移除按钮存在。
- 未覆盖上传拒绝路径（不支持类型、单文件/合计超限、伪签名、超限正文）。
- 未覆盖 PDF、分支会话附件、删除会话后的下载、多轮历史附件重读（API 定向验收已覆盖其中部分）。
- 未覆盖移动端（项目仅桌面）。
- 仅执行一轮真实模型运行；未做并发上传或运行中切会话。
- `login.png` 未按其下载链接触发下载校验，仅校验了磁盘存量文件与夹具一致。

## 截图

均位于 `docs/qa/agent-attachments/screens/`，已逐张打开确认非空：

| 文件 | 内容 |
| --- | --- |
| `01-login.png` | 登录页 |
| `02-chat-welcome.png` | 登录后 `/chat` 欢迎态，1512 宽 |
| `03-attachments-added.png` | 已选两个附件，名称/大小/移除按钮，空正文发送可用 |
| `04-sending.png` | 发送后立即出现用户消息附件标签；添加按钮禁用；运行中 |
| `05-complete.png` | 运行完成，Read/Read/Write 与耗时 |
| `06-outputs.png` | “会话成果”打开，`report-ui.md` 预览 |
| `07-download.png` | 下载触发后的页面状态（下载前已保存并校验字节） |
| `08-refresh.png` | 刷新后用户消息附件标签、下载链接与成果预览仍在 |

## 结束状态

- TaskSpace 已 `finish({ keep: [] })`。
- 按任务要求未 `down` 隔离环境；API 57718、worker、独立 PG/Redis 保持运行。
- 未修改任何产品源码。
