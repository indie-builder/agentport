# 聊天附件与上下文输入

## 目标

补齐完整用户故事的前半段：用户把资料随消息交给智能体，智能体读取后在同一任务中分析、交付，并可继续反馈修改。当前聊天只接受文本（64KB），没有附件通道；知识库适合长期资料，不解决“这次任务就用这份文件”的临时上下文。

范围只含智能体自身：附件进入当前会话运行、被模型读取、历史可见、分支与删除可追溯。不扩展云盘、项目空间、分享发布；不替代知识库。

## 基线与授权

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/agent-attachments`
- 分支：`worktree-agent-attachments`
- 起点：`870b98eaa7d05f4b46b9f862f82d9a1b69c8808c`（origin/main，含 PR #99 澄清提问）。
- 初始代码差异：无；`.env` 从主 checkout 复制，0600，不打印内容。
- 用户已授权实现、验证、独立 Opus 评审、commit/push/PR/merge；CI 不自动触发监控。主会话不改代码。

## 当前有效决定

- Opus 设计核对完成：采用“随消息上传 → 会话文件持久化 → `/mnt/inputs` 只读挂载 → prompt 明列文件并要求原生 Read”。不内联 image/document 块，不接知识库解析流水线；图片/PDF 由 Read 原生处理，沙盒需补 Poppler。
- 不在队列载荷中携带文件字节；文件落持久工作区，消息只存元数据，worker 计算挂载与提示。
- 附件是运行数据，不是智能体定义；不新增智能体定义格式或 second harness。
- 主会话不写代码；契约固定后按文件域拆分执行域并行实现。

## 固定实现契约

### 入口与边界

- `POST /api/chat` 增加可选 `attachments: [{ filename, dataBase64 }]`，最多5个、原件合计≤10MiB，路由 `bodyLimit` 16MiB；`message` 与附件至少一个非空。附件与 `openuiAction` 互斥。`message` 上限按 UTF-8 64KiB 校验（修正现有“字符数冒充字节”的注释/文案）。
- 服务端不信任客户端 MIME：按文件名扩展名映射规范类型，校验规范 base64、真实字节数、文件签名；文本要求合法 UTF-8 且无 NUL。
  - 文本：`.txt/.md/.csv/.tsv/.json/.jsonl`，单文件≤1MiB。
  - 图片：`.png/.jpg/.jpeg/.gif/.webp`，单文件≤5MiB，校验magic。
  - PDF：`.pdf`，单文件≤10MiB，校验`%PDF-`；加密/损坏由原生 Read 明确报错，不另造解析器。
  - 其余类型（Office/ODF/ZIP/音视频/HEIC/通用二进制）入口明确拒绝，提示改用知识库或文本。
- 文件名仅作显示：去控制字符与路径分隔符，≤120字符；磁盘名固定为 `<uuid><规范扩展名>`，与用户输入无关。

### 存储与生命周期

- 目录：`WORKSPACES_DIR/<slug>/conversation-inputs/<conversationId>/<attachmentId><ext>`；目录0700、文件0600；写入用临时文件+rename。
- 消息内容在既有 `{type:'text', text}` 上增加 `attachments: MessageAttachment[]`；元数据 `{id, filename, mimeType, size, sha256}`，不含宿主路径与 base64。可与 `output` 并存。
- 新会话在写文件前由 API 生成 id 并创建，标题取正文前80字、空正文取首个文件名；随后写文件、调用 `admitChatRun` 复用该会话。准入失败删除本次文件；新建会话一并删除。入队失败保留消息与文件，按现有失败 run 展示。
- `conversation-inputs` 不进入 `/workspace`，不改智能体定义；worker 仅在该会话目录存在时把整个目录只读挂到 `/mnt/inputs`。
- 分支：只复制被复制消息引用的附件（源文件复制、不用硬链接），附件 id 与消息元数据保持不变；缺文件回滚分支。删源会话后分支仍可读/下载。
- 删除会话或专家时删除对应 `conversation-inputs`。`pruneRuns` 删除旧 run 前把带附件的用户消息 `runId` 置空并保留；`pruneOrphanMessages` 永不删除带附件的消息。其他保留策略不变。
- 下载：`GET /api/conversations/:id/attachments/:attachmentId/download`，requireAuth；只接受该会话消息实际引用的附件，`attachment + no-store + nosniff`，原名走既有 RFC5987 编码；拒绝跨会话与伪造 id。

### 运行与权限

- worker 从当前用户消息解析附件元数据，prompt 追加受控清单：显示名用 JSON 字符串转义，列出 `/mnt/inputs/<id><ext>`、类型、字节数；要求先 `Read` 再分析，读取失败必须说明；输入只读，交付仍写 `/mnt/outputs`。历史附件路径在后续轮次仍有效。
- 仅主会话可 Read `/mnt/inputs/**`；Write/Edit、子智能体与未挂载路径继续拒绝。runner allow 规则与 `memory-permissions` 同步，沿用逐层 lstat/realpath/硬链接校验。
- 沙盒镜像安装 `poppler-utils`（官方长 PDF 分页读取依赖），构建期校验 `pdftoppm`/`pdfinfo` 存在；不增加其他解析服务。

### UI

- Composer 增加“添加资料”按钮与多选文件框，显示名称/大小/移除；发送时前端读取为 base64。附件随本次发送消费；失败保留本次选择；切换会话/专家/new 不串带。未发送附件不跨刷新持久化（sessionStorage 放不下大文件），已发送附件从历史恢复。
- 用户消息展示附件名称与大小；有服务端 id 时提供下载。空正文但有附件也能发送，气泡只显示附件。发送按钮禁用条件改为“无正文且无附件”。
- 不新建资料面板、PDF 预览器、拖放/粘贴（后续再做）。附件错误在输入区内明确显示。

### 执行域（互不重叠）

- A：`shared/attachments.ts`、`shared/chat.ts/index.ts`、`core/attachments.ts/index.ts`、`db/repo/chat.ts` 只增查询、`db/repo/maintenance.ts`、API chat 路由/下载路由/`outputs.ts` 导出文件名头、相关测试。
- B：`worker/src/index.ts`、新增 worker prompt 拼接、`sandbox/src/runner.ts`、`sandbox/src/memory-permissions.ts`、根 `Dockerfile`、相关测试。
- C：Web composer/store/stream/api/chat-state/chat 页面与测试。
- A 先落 shared/core 合同与导出；B/C 按本合同实现，不改 A 的文件。

## 评审记录

- B 运行侧评审：除宿主直跑 UID 差异外未发现阻断。附件目录沿用记忆目录的 0700/0600 约定，沙盒固定 uid 1000；Compose 三端同为 1000 可读写，Linux 宿主以其他 UID 直跑 `pnpm dev` 时沙盒无法读取附件（与现有原生记忆相同限制）。本轮明确写入 OPERATIONS，不改成 0755 放宽权限，也不声称本地直跑全功能；同步修正 worker 中“三者同一宿主用户”的错误注释。
- C 桌面评审：发现附件读取期间切走仍提交旧请求（P1），以及发送成功后附件缺真实 id/下载链接直到重开会话（P2），正在修复。
- A 数据/API 评审：三项已修复——全新环境首次上传前创建 WORKSPACES_DIR 根（读取不隐式创建）；新会话标题使用净化后的文件名，NUL/控制字符不再触发 500；本地相对 WORKSPACES_DIR 分叉写入 OPERATIONS/.env.example 约定。定向 core 23/23、API 18/18，类型检查通过。
- C 桌面评审：两项已修复——附件读取完成后、请求提交前检查请求归属；202 响应回传不含 base64/宿主路径的附件元数据，Web 接受后立即替换乐观项并生成下载链接。Web 定向 110/110。
- B 运行侧评审仅指出宿主直跑 UID 差异；按 Compose 约束记录，未放宽 0700/0600，worker 注释已改准确。
- 最终修复后：后端附件全链路 110/110（另 4 文件），Web 定向 110/110，类型检查绿。仍待真实模型/浏览器验收。

## 发现的既有冲突


- PR #99 把新建默认权限改为 `default` 后，`packages/core/test/agent-md.test.ts` 的默认值 fixture 仍断言 `dontAsk`；当时只跑了定向测试，未跑 core 全套，main 上留下 1 条红灯。本轮把该 fixture 同步为 `default`，显式 `dontAsk` 场景保留；core 全套 22 文件 227/227 通过。这不是本能力的运行时回归，但说明跨任务收尾需按改动范围补跑受影响包。

## 步骤

- [x] 阅读项目规则与用户故事，确认澄清提问已完成、不重复 PR #96/#97/#99。
- [x] 建立新任务树、配置与依赖。
- [x] 官方接口与现有链路核对，固定最小完整契约。
- [x] 子代理红绿实现，主会话按范围验证。
- [x] 真实沙盒/模型与桌面浏览器验收（隔离环境 PASS；浏览器链路 PASS，模型把 PACE 误读为 FACE，属视觉识别偏差）。
- [x] 独立 Opus 评审、修复复核（A/B/C 三域发现项均已修复并定点复核通过）。
- [x] 提交PR合并、记录证据、清理工作树：[PR #101](https://github.com/indie-builder/agentport/pull/101)。隔离验收环境已 down。

## 真实隔离验收（2026-10-28）

- 环境：独立 PG/Redis/随机 API 与模型代理端口/独立 workspaces/随机管理员；模型 `group/flash`；沙盒使用本分支 Dockerfile 构建的 Poppler 镜像（`pdftoppm`/`pdfinfo` 25.12.0 已实测）。
- PASS：三附件（CSV/PNG/14页PDF）被原生 Read；`report.md` 同时包含 128、PACE、海燕-42，正文/下载/磁盘 sha256 一致；三个附件下载 200 且与夹具哈希一致；同会话第二轮重读历史 CSV 生成 `second.md`；按历史点分支、删源后分支下载 200，并继续读取原附件生成 `branch.md`；跨会话下载 404；伪 PNG/超限 400。
- 浏览器（[报告](../qa/agent-attachments/browser.md)）：真实文件选择、两枚标签、空正文仅附件可发送、运行期禁用、下载字节哈希、刷新后标签/下载/成果仍在全部 PASS；模型把风格化 `PACE` 读成 `FACE`，内容断言偏差属视觉识别质量，附件链路未串包（存量 PNG 哈希与夹具一致）。
- 证据：`docs/qa/agent-attachments/README.md`、`api-run.txt`、`branch.md`、`browser.md`、`screens/`、`data.csv`；源会话按分支验证要求删除，report/second 原件不保留，但其内容与哈希在删除前由脚本核对并记录。

## 验证与限制

- 完整后端 `pnpm exec vitest run --project backend`：exit 0（含既有 NUL 等预期失败日志，无测试失败）。
- Web 全量：95 文件 983/983；附件定向：shared/core 35、API 19、DB 4、worker/sandbox 73（不同轮次汇总）。
- `pnpm typecheck`、`pnpm build`、`lint:focus`、`lint:contract` 通过；本轮改动/新增 29 个源码与测试文件 Biome 通过。
- 沙盒镜像从本分支 Dockerfile 构建成功，容器内 `pdftoppm`/`pdfinfo` 25.12.0 实测可用。
- 真实隔离验收与浏览器证据见 `docs/qa/agent-attachments/`；验收环境已 `down` 并核对无遗留进程/容器/库。
- 限制：Office/ODF、压缩包、音视频不支持（知识库处理）；未内联文档块、无拖放/粘贴；未发送附件不跨刷新；Compose 为完整支持环境，宿主直跑需同一绝对 WORKSPACES_DIR 和兼容 UID；模型对风格化品牌图存在误读，不代表附件链路失败。
