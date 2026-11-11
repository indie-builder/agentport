# 踩坑记录

> 跨任务反复出现的坑统一记在这里，由 `AGENTS.md` 指向。主会话与执行子代理动手前先读，落实相关规避方式；任务范围变化或报错时重新核对，不只在踩坑后追加。
> 不限定类别：遇到值得留存、能避免以后重复犯错的教训就及时整理，运行、实现、沟通、测试只是例子。每条固定「现象 → 原因 → 规避」，不把任务流水账和已有操作说明复制进来。
> 早期条目里的 `pnpm` 命令是当次事件的原始记录；现行命令用 Bun（`bun install`、`bun run <script>`），不要照抄历史命令。

## UI：全站减重把已选定的卡片深度一并压平

- **现象**：统一减轻组件外观时，专家卡片原有的常态投影与立体交互被删除，用户要求恢复旧版。
- **原因**：把外壳、表格与列表的平面规则扩展到共享卡片，并把主题选择扩大成全站组件重设计；又把整卡是否可点击误当成是否保留共享 hover 的条件，造成仅含按钮或表单的卡片漏掉交互反馈。
- **规避**：保留石青配色、主侧栏导航与书签、Bun 与脚手架；恢复视觉时只撤对应提交的视觉差异。所有业务卡片默认沿用 DESIGN.md 的共享常态与 hover 契约，点击和焦点仍只由真实交互语义决定；同步共享入口后扫描现有调用方与自绘卡片，不能只改规范。顶部专家选择位置根据历史源码调查恢复，不从卡片或菜单样式推断新布局。

## 压测：回滚语义夹具仍会改变计时库的物理状态

- **现象**：A/C 逻辑数据签名一致，但只在 A 库执行过整表语义夹具后，接口对照混入了物理数据差异。
- **原因**：`UPDATE` 后 `ROLLBACK` 仍留下死元组和扩大的堆表；`ANALYZE` 不会清除它们。
- **规避**：语义夹具用独立随机克隆库，计时库保持只读；测前核对数据签名、表大小和更新计数。已污染的性能样本标记无效，重新克隆数据库再测，不用回滚冒充恢复基线。

## 验收：临时脚本切 Redis 库号后清库仍会影响共享实例

- **现象**：一次自写 UI 验收脚本从 `.env` 取得共享 Redis 地址，切到 db 13 后执行 `FLUSHDB`，影响范围未确认；此事故不能归因为既有 `visual-shots.mjs`。
- **原因**：把同实例不同库号当成独享环境；同时核实既有截图入口虽建临时 PG 库，API 仍可能从 `.env` 或进程环境继承共享 `REDIS_URL`，原入口缺少 Redis 生命周期。
- **规避**：使用补齐隔离后的 `visual:shots`：本轮独享 Redis 容器、loopback 随机端口，API 显式注入本轮 URL，清理只认成功创建返回的容器 ID；不换共享库号、不执行 `FLUSHDB`/`FLUSHALL`、不读真实 Redis 内容。复用模式 `--base-url` 不创建或销毁外部服务，需确认目标栈后再操作。

## 运行：宿主直跑 worker 时模型网关地址不能被改写成 host.docker.internal

- **现象**：`bun run dev` 下真实对话全部失败，worker 日志反复出现 `model proxy request failed: other side closed`，但直接请求网关正常。
- **原因**：模型代理无条件把上游 loopback 改写成 `host.docker.internal`；该别名只在容器内可解析，宿主进程访问同一网关会失败。
- **规避**：只有 worker 自身在容器内时才改写（`packages/worker/src/upstream.ts`，用 `/.dockerenv` 判定）；沙盒侧地址仍必须改写。改到这里时不要把它和沙盒的 `toHostUrl` 混用。

## 复制到 worktree 的 `.env` 可能比刚确认的配置旧

- **现象**：新 worktree 起了服务，但用户刚确认的管理员密码失效；或 `.env` 缺 `APP_SECRET_KEY` / `ANTHROPIC_API_KEY` 起不来，装好依赖后前端也可能无法解析 `@agentport/shared`。
- **原因**：`.env` 不受 Git 管理；`.worktreeinclude` 只在建树时复制一次，来源是发起建树的那棵树（可能是旧 worktree），结果不代表最新。主 checkout 的 `.env` 也可能是旧残留。worktree 还不带 `node_modules` 与 workspace `dist`。各树共用数据库；历史实现曾在首次登录时用 `ensureAdmin` 按当时的 `ADMIN_PASSWORD` 重播管理员，旧配置一登录就把用户刚设的密码覆盖掉。当前已改为 `ensureBootstrap`：`platform_bootstrap` marker 只允许初始化一次，之后 `.env` 的 `ADMIN_PASSWORD` 不再覆盖现有账户。
- **规避**：配置默认取主 checkout `.env` 的绝对路径，启动前核对 `ADMIN_USER`/`ADMIN_PASSWORD`/`ALLOW_WEAK_ADMIN_PASSWORD` 等改动过的关键项；用户最新明确决定优先于磁盘上的值，不以「来自 main 的 `.env`」当成用户决定。登录验证使用用户确认的账号密码，不把 `.env` 的值等同于当前密码；也不拿测试或调试任务改掉用户登录态。然后 `bun install --frozen-lockfile`，前端预览前构建 shared/contract/core。新增必填 env 文件时同步加进 `.worktreeinclude`（仅作初始化副本，仍不保证最新）。规则集中在 `docs/DEV-WORKFLOW.md`「配置与启动」。

## 多个 worktree 同时跑全栈 compose 会互相踩

- **现象**：两个窗口的任务看到对方的数据/容器，或 `3000/5432/6379` 端口被占起不来。
- **原因**：`docker-compose.yml` 写死 `name: agentport` 和主要宿主端口（api 3000、postgres 5432、redis 6379、Docling 5001；只有 worker 模型代理端口走 `MODEL_PROXY_PORT`），所有 worktree 共用同一 compose 项目、卷、端口。
- **规避**：只让主 checkout 跑基础设施（postgres/redis），各 worktree 只跑应用进程连同一套。`COMPOSE_PROJECT_NAME` 只能分开项目、容器和命名卷，改不了写死的宿主端口；`HOST_WORKSPACES_DIR` 默认仍指向原项目的命名卷，`SANDBOX_API_URL` 也写死回连 3000，多套全栈还会共用工作区与回连地址。所以项目名本身不提供隔离，确需并行全栈要单独方案，先核对端口、宿主卷与回连地址再动手。端口说明见 `docs/OPERATIONS.md` §2.2 与 `docker-compose.yml` 的 `ports`。

## EnterWorktree 的 name 只接受 ASCII slug

- **现象**：用中文任务名调用 `EnterWorktree` 会失败。
- **原因**：工具限制 name 每段只能是字母、数字、点、下划线、短横线（最长 64）。
- **规避**：worktree 名用 `log-to-file` 这类 ASCII slug；中文任务名只用于当前会话或原生待办的标题，不放进 worktree 名。

## worktree 里两类命令会被拒绝，原因不同

- **现象**：worktree 会话里出现两种拒绝。①「runs rtk with a git command among its operands … Refusing to run it」；②「this command is too complex to verify that it stays inside the worktree … Split it into plain, separate commands」。
- **原因**：①是 `rtk hook claude` 把 `git` 包成 rtk 调用，命令里看不出实际执行的是哪个 git；②是 worktree 隔离守卫无法静态解析该命令，例如「建目录 + heredoc」写在同一行（`mkdir -p X && cat > X/a.mjs <<'EOF'`）。实测单独 `mkdir -p X`、单独 heredoc、`mkdir && echo`、`until [ -n "$(…)" ]` 都可通过，所以②不覆盖所有复合命令。
- **规避**：git 用 `/usr/bin/git <args>` 直接调用，不要混进复合命令；写临时脚本时先把 `mkdir` 和 heredoc 分成两次调用。遇到其它拒绝先按报错原文区分是 rtk 还是 worktree 守卫，不要一律归因 RTK。

## 测试：队列消费者检查要看库号和队列名，不能只看实例

- **现象**：`bun run test` 里 `chat-admission`、`chat`、`eval` 等套件整组 skip 或报 `worker must be stopped`，换机器/换时间又正常。
- **原因**：`queueIdle` 用 `redis.client('LIST')` 扫全实例，而 `CLIENT LIST` 不受库号隔离；开发库 db 0 上常驻的 worker 会被算成「被测队列的消费者」。`Queue.getWorkersCount()` 同样扫全实例、只按 clientName 过滤，换成它并不能解决。测试全部并行时，同轮其它套件起的 worker（`sandbox-probe`、`native-queue`）也会被误算。
- **规避**：默认入口已由 backend globalSetup 每轮提供独享临时 Redis 容器（实例内固定 db 9），开发 worker 留在另一个共享实例的 db 0，因此看不到测试队列。自己判消费者时仍要同时按 `db=<库号>` 和 `name=bull:<base64(队列名)>` 过滤，不能只看实例；用独立 `prefix` 的套件（如 `schedule-scheduler`）真实 worker 看不到，不需要消费者检查，直接判 Redis/Postgres 可用即可。

## 测试：全量并行时偶发 401，根因是登录后会话没落库

- **现象**：`bun run test` 全量跑时，`agents`、`servers`、`knowledge-routes` 等随机有文件报 `UNAUTHORIZED: not logged in`，每轮命中的文件都不一样，单独跑又全过。
- **原因**：多个测试文件并行登录同一管理员时，better-auth 偶发返回 200、也下发了 cookie，但会话行没写进库。实测证据：失败的那张 cookie 重试仍 401、换一个 app 实例也 401，而会话表里既有会话完好、行数没有减少——所以不是缓存、不是 CASCADE、不是限流、也不是连接池。
- **规避**：登录接口已加「下发的 cookie 回读一次，读不到就重试一次登录」（`packages/api/src/modules/auth/routes.ts`；探测用 `disableRefresh: true`，避免为探测多写一次会话）。排查同类抖动时用 `--no-file-parallelism` 与基线对比，不要凭一次全量结果认定回归。

## 测试：`RATE_LIMIT_DISABLED` 在构建 app 时读取

- **现象**：调试脚本里设置 `process.env.RATE_LIMIT_DISABLED = '1'` 的时机晚于 `buildApp`，登录仍从第 11 次开始返回 429。
- **原因**：`packages/api/src/http/security.ts` 的 `createSecurity()` 在 `buildApp` 时读取该变量，更早的模块加载阶段或已构造的 app 不会重新求值。登录限流来自契约的 `rateLimit: 10`，不是旧的 `preset`。
- **规避**：在 `buildApp`/`createSecurity` 之前设置变量，或用 `NODE_ENV=test` 等外部环境传入；后端测试由根 `bunfig.toml` 的 preload（`packages/worker/test/setup-env.ts`）统一下发 `RATE_LIMIT_DISABLED=1`。不要指望修改已创建 app 的进程环境后即时生效。

## recharts 的 `strokeWidth` 不是图标违例

- **现象**：`overview.tsx` 里 `<Area strokeWidth={1.5}>` 看着违反「图标统一 1.75」。
- **原因**：那是图表描边宽度，与 lucide 图标无关；规则针对的是 lucide 组件。
- **规避**：契约检查只匹配从 `lucide-react` 导入的组件名；不要为此改图表数值。

## 不要把任务跟踪资料写进 `.claude/worktrees/`

- **现象**：手写到 worktree 目录里的临时记录或计划，任务收尾后无法追溯，或随树删除而丢失。
- **原因**：worktree 退出即删或按周期清理，且 `.claude/worktrees/` 被 gitignore。
- **规避**：普通任务跟踪放当前对话或原生待办；只有用户明确要求保存时才写入指定路径。跨任务教训写 `docs/PITFALLS.md` 并随分支提交；需要暂停或交接时用 pstack 原生 checkpoint，不手造目录。

## 运行：`bun update` 会更新依赖，不会启动项目

- **现象**：要求启动服务，却更新了依赖和锁文件。
- **原因**：项目启动脚本叫 `up`，必须通过 `bun run up` 执行；裸 `bun update` 只更新依赖，不会启动项目。
- **规避**：启动显式运行 `bun run up`；升级依赖才用 `bun update`。执行前看根 `package.json` 的 scripts，不凭名称猜命令。误更新时只恢复已确认由本次命令产生的改动。

## 运行：API 可访问，不代表用户的 Portless 地址已启动

- **现象**：`localhost:3000` 正常，用户打开 `agentport.localhost` 却提示 `No app registered`。
- **原因**：Docker API 与 Portless 前端是两个独立进程；旧页面壳还能显示，但后续请求已没有对应路由。
- **规避**：先确认用户正在用的完整 URL，再启动对应服务；按那个 URL 检查一次页面请求，不把另一个端口可用当作同一结果。

## 实现：新 worktree 不一定基于最新 `origin/main`

- **现象**：进入新 worktree 后，刚合并的功能消失；或从旧 worktree 下套娃建树，起点更旧。
- **原因**：本地 main 常落后于远端；从旧 worktree 或本地 main 建树都会继承旧提交。
- **规避**：先 `git fetch origin main`，再从主仓库用绝对路径以 `origin/main` 建树；本地 main 与旧 worktree 都不作最新依据（`docs/DEV-WORKFLOW.md` §2）。已确认合并的功能才能作为运行源。

## 实现：更换集成方案前，核对原有授权和平台原则

- **现象**：用户已确认 CLI 安装方案，审查后却直接换成 HTTP 快照实现。
- **原因**：把审查发现的问题直接当成替换用户已选方案的授权，未先评估官方 CLI 在隔离环境中的使用方式。
- **规避**：先核实具体限制及最小修法；替换已确认的集成路径前，说明行为差异和代价并取得确认。不能以实现方便代替用户的架构决策。

## 测试：跨 worktree 登录要从实际域名提交

- **现象**：无 Origin 的 API 注入测试能登录，预览域名提交却返回 403；复制已有 Cookie 后页面正常，仍不能证明登录已修复。
- **原因**：Vite 代理改写 Host 而保留浏览器 Origin，认证校验仍只信任基础域名；手动写 Cookie 绕过了被测步骤。
- **规避**：验证真实登录 POST 的 Origin、响应与 Cookie；覆盖新子域名允许、非可信域名拒绝，登录和登出都走真实浏览器路径。共享登录来源规则，不能只修 CORS 响应头。

## 测试：精简文案后要同步真实端到端定位器

- **现象**：单元测试和页面检查通过，CI 冒烟仍按旧草稿标题定位而失败。
- **原因**：修改界面文案时只检索了前端测试目录，漏掉根目录 `tests/*.e2e.ts` 的真实页面断言。
- **规避**：改动可见名称前检索全部调用与测试引用，包括 E2E；同步为当前可访问角色与名称，保留原本要验证的用户操作，不用删除断言掩盖失败。

## 流程：个人项目合并不自动附加 CI 等待

- **现象**：用户要求提交并合并，智能体却启动 CI 监控和冷却等待，拖延交付。
- **原因**：照搬工具技能的默认流程，忽略个人项目已经明确的轻量迭代要求。
- **规避**：以用户授权和项目规则为准；CI 仅手动触发，合并不等待，PR 自动监控默认关闭。需要检查时按改动范围本地验证，不把全量套件绑到每次提交。

## 沟通：用户要求启动服务时，不擅自扩成发布验证

- **现象**：用户只想打开页面自己验收，却收到重建、测试、部署和大量解释。
- **原因**：把「启动」扩大成完整交付流程，未区分当次请求与之前任务的验收。
- **规避**：只启动实际需要的进程，给出正确地址；除启动失败定位外，不顺带升级依赖、全量测试或改业务代码。用户说自己验证后，让用户接手。

## 沟通：先分清产品功能与研发工作区工具

- **现象**：用户谈产品菜单里的技能市场，回答却围绕本仓库安装的研发技能展开。
- **原因**：看到 skills.sh 就联想到工作区工具，忽略了用户指出的产品入口。
- **规避**：先沿用户给出的菜单或页面定位产品能力，再调研外部集成；仓库自身工具仅作为可复用证据，不替代产品需求。

## 并行：恢复改动时覆盖了同时进行的未提交差异

- **现象**：一个窗口撤销差异后，另一个窗口正在写的文件被还原或丢失。
- **原因**：把整文件 `restore` 当成「撤销本任务」，没先核对工作区里已有差异的归属。
- **规避**：撤销前对照开工记录的初始差异与当前 `git diff`，只撤本任务的 patch（`docs/DEV-WORKFLOW.md` §2「撤销与恢复」）。

## 实现：按截图和记忆猜参考 UI 的交互与状态

- **现象**：参照目标产品做出来的区域、数据或状态与真实交互不符，返工。
- **原因**：只看静态视觉就实现，没有在目标产品里实际操作对应控件。
- **规避**：实现前实际操作目标控件确认区域/数据/状态，无法操作则标为缺口（`docs/DEV-WORKFLOW.md` §2 实现）。

## 实现：对齐/间距类改动没量实际坐标就宣布完成

- **现象**：同一处对齐问题被用户复述多次（例如三个面板的收起按钮不在同一行），前几轮都说「已改好」。
- **原因**：只按代码里的类名推断视觉结果，没有读渲染后的实际位置；多个容器各自的高度来源不同，类名相同也不代表基线一致。
- **规避**：间距、对齐、层级这类改动，交付前用浏览器读一次实际 `getBoundingClientRect()` 或计算样式，把数值写进回复；同一问题被复述第二次时先量再改，不再次靠改类名试错。

## 浏览器：ego-browser 的四个高频误用

- **现象**：`task space not found`、`page label not found`、`Invalid locator`、`matched N elements`、点了没反应。
- **原因**：把上次的 space id / page 标签 / `ref` 当成长期有效；locator 语法写成 Playwright 的写法。
- **规避**：①同一个目标只用一个 TaskSpace，用**固定名字**复用（`taskSpace('chat-layout')`），名字才是长期句柄；数字 `spaceId` 只在当轮输出里可读，不要当成跨轮常量存下来；②`task.page(label)` 只查已存在的页，缺页用 `await task.newPage()`（不传参数）且用先前输出里的 `p1`/`p2` 标签；③`ref` 只在当前快照有效，页面变化后重新 `snapshot()` 再点；④role 定位写成 `loc=role:button[name="新建专家"]`，名字是子串匹配用 `[name*="…"]`，`loc=role:dialog` 这种缺名字的写法会报 `Invalid locator`。需要观测条件时用 `waitForSelector`/`waitForFunction`，不用固定 sleep。

## 测试：全量并行时不同文件每轮随机失败，根因是跨文件共享的测试身份与信道

- **现象**：`bun run test` 全量并行时每轮命中的文件不同：`createTestAccount` 返回 409「该业务 ID 有历史记录」、个人记忆用例查到 2 条本应 1 条、删除接口偶发 503 且服务端日志为 `options.sessions.closeIdle is not a function`；把失败文件单独跑全过。
- **原因**：三类跨文件共享：① `packages/worker/test/fixtures/access.ts` 曾用固定业务 ID，一个文件写入 agents 记录后，另一个文件用同一 ID 建号被 409 拒绝；② `personal-memory.test.ts` 曾按管理员身份筛整张表，而 `agents.test.ts` 也以管理员写规则；③ 导入真实 worker `src/index.ts` 的入口测试若只 mock 部分 `sessions` 方法，会订阅默认信道 `session-cleanup:requests`，抢答其它 API 测试的删除请求并回传 TypeError（ACK 首个胜出）。
- **规避**：测试身份按文件 URL 派生（同文件稳定、跨文件唯一）；需要清理或计数的测试用自己创建的账号并按 `business_id` 限定；导入 worker 入口的测试一律 mock `startSessionCleanupChannel` 返回空 `close`（参照 `eval-index-log.test.ts`），不要只给残缺 sessions 补方法。复现用 `--sequence.shuffle --sequence.seed=… --repeats=…` 组合相关文件，并与 `--no-file-parallelism` 对照。

## 数据库：单表 SELECT 的 SQL 子查询可能丢失外层列限定名

- **现象**：频道消息已写入 `seq=1`，相关子查询的 `maxSeq` 却为 0，合法 SSE 游标被误判为未来游标。
- **原因**：Drizzle 在单表 SELECT 投影里把 `${channels.id}` 生成成未限定表名的 `"id"`；放进 `channel_messages m` 子查询后，被 PostgreSQL 解析成内层 `m.id`。
- **规避**：已有频道 ID 入参时直接绑定参数，避免此处相关列引用；涉及嵌套 SQL 先检查 `.toSQL()` 并用真实非空数据验证，不只看类型检查或空列表测试。

## 数据库：Drizzle `sql` 模板里的 JS 数组会展开成多个占位符

- **现象**：`sql`${ids}::text[]`` 生成 `($2, $3)::text[]`，非空数组报 `cannot cast type record to text[]`，空数组直接语法错误；看起来像 SQL 写错。
- **原因**：Drizzle 的 `sql` 模板把数组当参数列表展开，不作为一个数组参数绑定。
- **规避**：Bun SQL 的数组参数用原生 `client.array(values, 'TEXT')` 构造，再交给 `sql.param`，例如 `${sql.param(db.$client.array(ids, 'TEXT'))}::text[]`；不要把 JS 数组直接交给 Drizzle 模板。同一原生 SQL 路径的日期参数传 ISO 字符串（`date.toISOString()`），不要依赖驱动自动转换 `Date`。空数组与非空数组都要有测试。

## 数据库：workspace 包导出指向 dist，只改源码不重跑 `tsc -b` 时测试仍在用旧代码

- **现象**：改了 `packages/contract` 等包的 schema 源码，后端测试结果不变；重建 dist 后同一个测试立刻出现不同行为（如知识原件 61 与 62 字节）。
- **原因**：workspace 的 `exports` 指向 `dist` 且 dist 被 gitignore；直接跑测试加载的是上一次构建的产物，不是刚改的源码。
- **规避**：改共享包源码后先 `bun run build`（或该包 `tsc -b`）再跑测试；排查「改动无效」类问题时先确认 dist 时间戳，不要先怀疑缓存或断言。

## 数据库：迁移账本漂移或共享库已有列时不要手改账本

- **现象**：`bun run db:migrate` 报列已存在（如 `agents.role`），或 `__drizzle_migrations` 里的时间戳在 journal 中找不到；共享库还可能停在上一号，后续迁移一条都没跑。
- **原因**：dev/共享库曾被另一条迁移历史建过，或列被手工 DDL、另一分支加过；journal 与库内账本不一致，列定义也可能与本分支 schema 不同（例如 `not null default ''` vs 可空）。
- **规避**：先按 `journal`、实际 `__drizzle_migrations` 与 `\d <table>` 逐条比对确认差异；个人项目不留历史数据，直接 `bun run down --clean && bun run up` 重建最干净，或确认无数据后按本分支 schema 重建。不要手写/删除迁移账本行来「对齐」，也不要把 `ADD COLUMN` 改成 `IF NOT EXISTS`，否则新库与旧库定义会分叉。

## 流程：用 main 的提交顺序覆盖了用户更晚的决定

- **现象**：合并 review 时按 main 里已有的实现反推哪条决定有效，忽略了用户之后明确的新决定。
- **原因**：把代码时间线当成决定时间线。
- **规避**：以当前会话中用户最新明确表态和原生待办为准（`docs/DEV-WORKFLOW.md` §3），不按旧任务文档或代码时间线反推。

## 沟通：clear 后按指代猜测要撤销什么

- **现象**：会话重开后凭「继续」「撤销刚才的」直接按历史扫描日志推断目标，花时间猜错方向，被用户中断。
- **原因**：上下文丢失后用历史推断代替确认。
- **规避**：指代不明先确认目标，不翻历史猜（`docs/DEV-WORKFLOW.md` §2「会话恢复」）。

## 验证：从 SSE 日志用宽松正则拼文本会造出「重复内容」的假象

- **现象**：真实模型跑完一轮生成式 UI，用 `/\"text\":\"(…)\"/g` 从事件日志拼出的文本里，`root = Card` 出现两次，看起来像重复渲染。
- **原因**：`assistant_text` 事件也含 `text` 字段，正则把「增量 delta」和「整块文本」一起匹配进去，拼接后自然有两份。
- **规避**：只匹配 `"type":"text_delta"` 的 text；判断渲染结果时以**前端分段函数的实际输出**为准，不靠日志字符串计数。

## 实现：OpenUI 补丁合并会移除 root 不可达的语句

- **现象**：`mergeStatements(existing, 'x = TextContent("…")')` 之后新语句消失，看起来像合并没生效。
- **原因**：官方语义是「从 root 可达的语句才保留」，只加语句不改 `root` 就是孤立语句，会被清掉。
- **规避**：editMode 的补丁若新增节点，必须同时更新 `root = Card([...])` 的引用；测试要覆盖这条，不要按「追加即保留」写断言。

## 流程：worktree 内的 shell 守卫会拒绝拼接运行时密钥与复杂复合命令

- **现象**：`docker exec … $(grep …)`、`env $(grep …) node …`、`set -a; . ./.env` 被拒绝执行，提示命令无法确认停留在 worktree 内。
- **原因**：worktree 隔离守卫只允许能静态解析的简单命令，运行时取值与 `source` 无法校验。
- **规避**：把逻辑写进脚本文件，由脚本自己读 `.env`（不在命令行出现密钥）；单条简单命令分开执行。

## OpenUI：JSON Schema 不能反推等价的真实组件库

- **现象**：组件名字/版本号自检都通过，绑定输入后 `$filter` 却不更新，省略默认参数的程序被当成缺字段。
- **原因**：`reactive()` 的标记不在 JSON Schema 里，反编译还会漏 Zod 的 default、record 值类型和最小项数；名称相同不代表组件契约等价。
- **规避**：维护真实 Zod/reactive 定义，由官方 CLI 从浏览器实际 library 生成后端 LibrarySpec；用绑定回写、默认参数和约束的行为对照测试验升级，不用manifest自比或组件数量代替。

## 技能：`skills update` 报告最新，不等于本地与上游一致

- **现象**：`npx --yes skills@latest update --project --yes` 输出 `All project skills are up to date`，但本地被改过的技能文件、上游已删除的技能目录都原样保留。
- **原因**（CLI 1.7.4 实测，后续按当次核对）：update 只比较上游 hash 与 `skills-lock.json` 的记录，不读本地文件，因此本地漂移不会触发覆盖；非交互 `--yes` 遇到上游删除时只输出 `Skipping deletion in non-interactive mode` 而不删。
- **规避**：不把 up to date 当作已完成；按 `docs/SKILLS.md` 的定向重装与完整目录核验流程对齐，上游删除项同样按该流程清理。

## 表单：RHF reset 后 undefined 受控字段被判为脏

- **现象**：跨分区编辑并保存成功，服务器和标题已更新，表单仍显示“未保存”，`dirtyFields` 却为空。
- **原因**：默认值省略 `effort`，`useController` 重注册写入自有键 `effort: undefined`；RHF 比较键集合时将两者判为不同。
- **规避**：默认值与 reset 快照始终包含所有受控字段的键；用跨分区编辑、保存、重挂载的行为测试验证，不能用整表 watch 或另造 JSON 比较兜底。

## 运行：超长连续文本会使正则最小量词耗尽V8栈

- **现象**：7MB连续文本已通过事件边界，但消息脱敏时抛RangeError，整个消息事务未落库。
- **原因**：凭证匹配的`{8,}`/`{16,}`/`{32,}`在该V8路径为长匹配保留大量回溯栈。
- **规避**：用`+`匹配连续段，在替换回调保持原长度阈值；长文本验收必须走真实消息持久化，不能只检查事件数组保留。

## 数据库：Drizzle DESC NULLS LAST 索引未必匹配默认倒序

- **现象**：新增倒序复合索引后，评估分页仍用 bitmap/顺序扫描再排序。
- **原因**：Drizzle `.desc()` 生成 `DESC NULLS LAST`，查询默认 `DESC NULLS FIRST`，规划器没有采用该排序路径。
- **规避**：当前非空分页列使用升序复合索引，由 PostgreSQL 反向扫描满足倒序；生成迁移后用实际 SQL 的 `EXPLAIN (ANALYZE, BUFFERS)` 验证，不能只看索引列名一致。

## 数据库：复合外键的引用目标必须是 UNIQUE 约束，不能是 uniqueIndex

- **现象**：迁移在 `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` 时报 42830（`there is no unique constraint matching given keys`）。
- **原因**：Drizzle `uniqueIndex()` 只生成独立的 `CREATE UNIQUE INDEX`，drizzle-kit 把它排在 `ADD CONSTRAINT` 之后；PostgreSQL 复合外键要求引用列上有 UNIQUE/PRIMARY KEY **约束**。
- **规避**：引用目标用表级 `unique('...').on(...)`；生成迁移后确认 `ADD CONSTRAINT` 先于引用它的外键。

## 数据库：partial index 的 eq 参数会被 drizzle-kit 序列化成 $1

- **现象**：生成的迁移里出现 `WHERE "is_default" = $1`，执行时报 `there is no parameter $1` 或索引条件错误。
- **原因**：drizzle-kit 把 `eq(t.isDefault, true)` 当参数化表达式，不会内联布尔字面量。
- **规避**：partial index 条件改用 `` sql`${t.isDefault} = true` ``，生成后确认 SQL 是字面量而不是 `$1`。

## 导入：ZIP 库的定长输出长度不等于真实解压大小

- **现象**：归档低报 deflate 原始大小时，fflate 返回被截断的文本，后验长度比较仍通过。
- **原因**：fflate 按声明长度创建定长输出；预检和解压器若各自解析条目数、编码、EOCD，也可能解释不同。
- **规避**：先校验中央目录及数据区间，再用 Node 原生 `inflateRawSync` 的 `maxOutputLength` 限制真实输出；覆盖低报 deflate、名称编码与注释内完整伪 EOCD，不把库返回数组长度作为充分证据。

## 测试：私有队列配全表对账会互相收敛别的测试记录

- **现象**：同库并行跑两份对账测试，明明waiting/delayed job还在，run却变failed，发布次数从1变3。
- **原因**：每个测试进程用不同私有队列，生产对账函数却扫描整张运行表；另一进程的job在自己的队列中当然不存在。
- **规避**：优先每次验证使用独立PG/Redis；同文件同库的跨进程测试用会话级advisory lock串行，不能放宽状态断言或改生产对账。单次全套中检查“无阻塞消费者”的前置也可能与SSE测试互扰，按需用`--no-file-parallelism`验证，不增加常驻门禁。

## UI：消息项延迟布局会干扰历史分页的阅读锚点

- **现象**：点击「加载更早消息」后，原来正在阅读的消息向上漂移，消息 ID 和分页数量仍正确。
- **原因**：消息项同时使用 `content-visibility: auto` 与 `contain-intrinsic-size: auto 10rem`，屏外项的占位高度和实际布局高度不同，干扰滚动原语按元素位置恢复 prepend 锚点。
- **规避**：消息项保持真实布局，让现有 MessageScroller 原语维护阅读位置，不另加滚动补偿。验证使用 125 条异高消息、真实滚轮及两次分页，比较同一消息 ID 相对滚动视口的顶部坐标；不能只看消息存在或分页数量。1440×900、1200×900 实测移除这两项后，两次分页漂移均从 −74px 变为 0px。

## UI 验证：类名和采样时序不能代替真实几何与性能

- **现象**：轮播有正确的 `basis` 类但卡面少12px；流式基准读到约1秒帧间隔，或未抓到中间态。
- **原因**：Carousel item 的内距计入 border-box；浏览器后台页会节流RAF；回放先启动、浏览器后导航会错过增量。空输入发送按钮本来就禁用，不能用“可发送”等待终态。
- **规避**：分别测item和卡面矩形、轨道gap；浏览器就绪后用信号触发回放，在固定前台记录明确的流式窗口，并记录空闲对照。终态用真实run状态/最终内容判定，不把探针超时直接归为产品失败。

## 测试：测试库隔离必须尊重注入地址，不能隐式改写或回落固定库

- **现象**：外层已注入临时数据库，但创建智能体仍500，取消测试静默跳过；或测试进程把连接串改成了历史固定库。
- **原因**：测试模块在 import 时捕获 `DATABASE_URL`、擅自改 `process.env`，或把地址重写回固定历史库；复用的旧迁移账本不含后来合入的表，迁移异常又被吞成 infra 不可用。
- **规避**：默认入口由 `scripts/test-backend.ts` 调用 globalSetup 每轮创建随机库并迁移，再把返回的连接串合并进 spawn `bun test` 的 `process.env`；套件确需独立库时调用 `createIsolatedDatabase(prefix, adminUrl)`，显式使用返回的 `url`（不再隐式改 env），关闭连接后只删自己创建的库。建库/迁移失败必须抛错；只有 PG/Docker 不可用才发布不可连地址并跳过，不能回落开发库或共享 Redis。核验清理时只认本次函数返回的库名及唯一容器名/句柄：同一 worktree 可能有并行代理在跑测试，不要按 `backend_test_*` 前缀或镜像名批量删库/删容器。

## 测试：用行锁编排 claim/取消竞争时，等锁对象不一定是同一个

- **现象**：测试事务 `SELECT ... FOR UPDATE` 锁住 `knowledge_jobs` 行后，希望 worker claim 先于 API 排队取消获胜；实际 claim 的 UPDATE 等待 `transactionid`，取消的 UPDATE 等待 `tuple`，两者不在同一等待队列，释放锁后次序不保证。
- **原因**：被 `FOR UPDATE` 锁住的行会让后续 UPDATE 等待持有者事务 ID；更晚的 UPDATE 可能转而等待 tuple 锁。跨不同锁对象没有单一 FIFO 语义，按“先发起就先赢”的直觉写测试会偶发反序。
- **规避**：让必须获胜的一方先持有目标行、再阻塞在一个**下游行**上（例如 claim 先锁 job、再等 sync run）。另一方对目标行的 CAS 只能等获胜事务提交，释放下游锁后 CAS 必然看到已提交的新状态而落空；用 `pg_locks` 未授予锁事件确认两个等待已建立，不用 sleep。参考 `packages/api/test/knowledge-jobs.test.ts` 的 `queued cancel loses to a claimed sync job`。

## 测试：依赖真实文件系统的 spawn 就绪要用明确信号，不能数 `setImmediate` 轮数

- **现象**：`runtime-environment-build` 单跑或全量时，固定 20 次 `setImmediate` 后 buildx 仍可能未 spawn（`buildIndex === -1`）。
- **原因**：`setImmediate` 只推进事件循环轮次，不保证 spawn 前的 `mkdtemp`/`writeFile` 等真实 fs（libuv 线程池）回调已完成，固定轮数可能先用完；线程池争用是可能放大因素，不是已确定的唯一原因。
- **规避**：fake spawn 在真正就绪（含 `--iidfile` 写入）时 resolve 明确信号，测试 `await` 它，并用 `Promise.race` 让 handler 提前结束直接失败；只用于排空回放缓冲的 `setImmediate` 可保留。

## 测试：读全表的接口测试要复用项目测试 config 并预置正常加密记录

- **现象**：`knowledge-server-guard` 单跑 3/3 绿，全量并行时 `GET /api/servers` 返回 500（`INTERNAL_ERROR`）；库里有普通连接器才触发。
- **原因**：测试 app 自造 config 只有 `NODE_ENV`/`SELF_URL`，缺 `APP_SECRET_KEY`；`listServers` 查全表后解密普通连接器 `env`，`Buffer.from(undefined)` 抛错。空库单跑没有这条记录，掩盖了缺口。
- **规避**：测试 app config 直接用项目测试 helpers 的 `testConfig()`（与生产相同配置契约，但不是生产函数）；覆盖列表/全表查询时用现有 repo `createServer` 和同一 `APP_SECRET_KEY` 预置一条带加密 env 的正常记录再断言，不手造密文，也不用空库单跑绿代表集成。

## 解析：Docling pageMap 不能用整文 indexOf 反查来源

- **现象**：表格 chunk 丢失来源页码；图片 OCR 的 `1` 被匹进正文数字 `1234`，页码错位。
- **原因**：Docling JSON 的表格是紧凑序列化，与官方 Markdown 中带对齐空格的表格文本不同，整文 `indexOf` 找不到表格；短 OCR 串也会落到任意相同数字里。CRLF 原文还会让偏移与返回文本位置不一致。
- **规避**：复用 `markdownBlocks` 已算出的原文 offset 与 fingerprint，按同类匹配并维护已认领区间，不随意 substring。真实解析验收要看 `adapter.chunkMarkdown` 产出的 `pageFrom`，不能只看 JSON blocks 的 locator；CRLF 必须返回原文 offset。

## 测试：组件覆盖的「豁免清单」会冒充已覆盖

- **现象**：`bun run openui:check` 11 项全绿、组件覆盖测试 38 项全绿，实际仍有日期早存一天、复选默认项不进载荷、表格流式补行后仍 0 行、日期弹层点击打不开。
- **原因**：覆盖测试断言的是「渲染出非空内容」；可交互组件被写进 `NESTED_ONLY` 并注释「由父组件用例覆盖」，而豁免只是一个名字，没有任何交互断言。`openui:check` 只比对 schema/spec，不进入 DOM 交互。
- **规避**：改动 OpenUI 组件后跑 `bun run openui:audit`，看 behavior / render / nested（可交互但尚未登记证据）/ missing 四类数字；缺口按同一范围比较不应上升，新增组件或能力可以登记新缺口并写明，不算回归；审计只读登记表，不解析断言也不计算覆盖率。每个新发现的 bug 先落一条会失败的行为用例再修；不要靠往豁免清单加名字让测试变绿。

## 附件：目录权限与相对路径会让沙盒读不到文件

- **现象**：`bun run dev` 上传成功，但模型读取 `/mnt/inputs` 失败；或 Linux 宿主以非 1000 UID 运行时同样读不到。
- **原因**：API 与 worker 各自以包目录为 cwd 解析相对 `WORKSPACES_DIR`，附件（以及记忆、成果）落在不同目录；附件目录按 0700/0600 创建，而沙盒固定以 uid 1000 运行，宿主直跑非 1000 UID 时无法遍历。
- **规避**：本地开发把 `WORKSPACES_DIR` 设为同一个绝对路径，或使用 Compose；需要沙盒读取持久目录时用 Compose 的 uid 1000 三端配置，不要用 0755/0777 放宽权限掩盖 UID 差异。

## 运行：Node 子进程的 exit 与 close 不能混用，等 close 会与后代互等

- **现象**：runner 已退出，`close` 却迟迟不触发；在等 `close` 期间再杀后代进程会互相卡住；stdio 为 inherit 或 detached 的测试更容易复现。
- **原因**：`close` 要等子进程退出且所有 stdio 管道关闭；后代继承了 stdout/stderr 时管道仍打开，`close` 被拖后。若顺序是「先 await close，再清理后代」，而后代又阻塞在管道上，就互等。EOF 收尾只设 `exitCode` 而留着 pipe handles 时同样不会收敛。
- **规避**：按 `exit` 事件启动后代清理，再排空/结束输出管道并确认已 settled；测试覆盖 stdio inherit 与 detached；EOF 收尾显式结束管道，不只设 `exitCode`。

## 镜像：官方 CLI 的 Bash 工具需要真正的 bash/zsh，busybox sh 不够

- **现象**：镜像里有 `sh` 且能执行命令，但智能体调用 Bash 报 `No suitable shell found`。
- **原因**：Claude Code 原生 CLI 按 PATH 查找 bash/zsh 来执行 shell 工具，不把 busybox ash 当兼容 shell；自制 sh 兼容壳只能骗过部分测试，不是开箱能力。
- **规避**：sandbox 基座安装 `bash`，构建期用 `bash --version` 确认是 GNU bash；运行环境 verify 再确认 PATH 上存在 bash。

## UI：子表单卸载不会自动结算外层 pending

- **现象**：模型 profile 保存成功、编辑表单消失，外层弹窗的关闭、新增和编辑仍永久禁用；保存中后退/前进被拦下后关闭弹层，被拦的导航 Promise 永久挂起，确认框残留。
- **原因**：外层通过子表单 effect 接收 pending；成功回调先卸载子表单，随后子表单的 `setSaving(false)` 无法再触发回报，外层保留最后的 true。TanStack Query 的 per-call mutation 回调随组件卸载不再执行，把结算只移到父层 `onCreated` 仍依赖这条被跳过的回调；`useBlocker` 的 resolver 也不会随卸载自动 `reset`/`proceed`。
- **规避**：拥有弹窗/编辑子树生命周期的父层持有卸载权，在真正关闭或切换前结算 pending 与最新 blocker resolver（`reset` 表示取消被拦下的导航），不把结算挂在子表单成功回调。跨卸载仍要继续的异步收尾用 `mutateAsync` + `finally`（回填、toast 在异步延续里做），不依赖 per-call 回调。测试必须在响应仍挂起时先断言子表单/编辑节点已卸载，再释放响应并断言 pending、弹层与导航均已结算；并发多对象结果用函数式合并（`setResults(prev => ({ ...prev, [id]: next }))`），以乱序完成和一次 HTTP 异常验证互不覆盖。

## UI：详情路由的 document.title 不能只按路由模板命名

- **现象**：两个不同专家的浏览器标签标题完全相同，插件、知识库和运行详情也只显示固定的资源名；多标签和读屏无法区分实体。
- **原因**：shell 用匹配到的路由/固定分区生成 `document.title`，详情页实际实体名只存在于页面内 h1，没有进入标题。
- **规避**：列表页基础标题统一 `${页面名称} · PACE`；详情路由的基础标题仍用于加载/回退，主内容挂载后用唯一 h1 同步 `${实际 h1} · PACE`，并观察主内容标题变化；pathname 变化先重置基础标题，观察器只挂 main 子树并在卸载时断开。不要用路由参数、数据库 ID 或内部路径冒充用户可见名称。

## UI：CodeMirror 的 id 不等于可访问名称

- **现象**：正文已有可见 `label[for]`，浏览器 AX 树里的 CodeMirror `textbox` 名称仍为空；加载前 textarea 与加载后编辑区还可能表现不同。
- **原因**：CodeMirror 使用 `contenteditable`，不能靠原生表单控件的 label 关联命名；只向 `SourceEditor` 传 id 不会生成可访问名称。
- **规避**：调用 `SourceEditor` 时同时传与可见标签一致的 `aria-label`；用真实加载后的 AX 树核对名称，并验证回退 textarea，不能只断言 label 或 id 存在。

## UI：URL 成为状态唯一来源后，导航 mock 必须反映 search 更新

- **现象**：完整文件页签实际可用，按需加载测试却始终不请求；评估结果已改 URL 选择，旧测试仍调用不存在的 `renderExpanded`。
- **原因**：测试将 `useSearch` 固定为空、`useNavigate` 固定为无行为函数，仍以旧的本地状态/行内展开假设断言。
- **规避**：涉及 URL 导航、历史、blocker 时优先真实 Router 与实际 `validateSearch`；保留原用户行为断言，不能只替换成函数是否被调用，也不能删除失败断言凑绿。

## 记忆：`UserPromptSubmit` 的 `additionalContext` 上限是 10,000 字符

- **现象**：个人偏好正文接近上限时，注入被截断或本轮失败；把 36 KiB 文件大小当成字符上限也会误判。
- **原因**：官方 `additionalContext` 单次上限按字符计（10,000），文件字节数是另一层护栏；Unicode 码点与 UTF-8 字节数不同。
- **规避**：平台统一按 Unicode 码点限制 9000 字符，并另设 36 KiB 字节护栏；超限直接拒绝并说明，不静默截断。改这条链路时同时保留字符与字节两层检查。

## 记忆：`MEMORY.md` 只加载前 200 行或 25KB

- **现象**：详细经验写进 `MEMORY.md` 后，新会话没有加载到后半部分，看起来像记忆丢失。
- **原因**：官方启动只读取 `MEMORY.md` 的前 200 行或 25KB；它是索引，不是完整笔记。
- **规避**：`MEMORY.md` 只放索引与主题链接，详细内容写主题文件或规则；历史回顾采纳时对提案做 200 行 / 25KB 校验，超限拒绝而不是截断。

## UI：`buttonVariants` 必须经过 `cn` 合并，不能直接拼接类名

- **现象**：给按钮传 `className` 后仍被基础样式覆盖，或同一按钮在不同调用处出现两套边框/高度。
- **原因**：按钮变体样式是一个类字符串，直接拼接时 Tailwind 冲突不会按预期解决；项目封装已用 `cn(buttonVariantStyles(props))` 合并。
- **规避**：始终调用导出的 `buttonVariants`（已含 `cn`），不要直接调用内部样式函数或用模板字符串拼类名；需要覆盖时通过它的 `className` 参数传入。

## UI：Base UI 的 `hidden="until-found"` 不能被作者 `content-visibility` 覆盖

- **现象**：关闭的 keepMounted 折叠面板仍占位、内容可被找到，或打开动画异常。
- **原因**：`hidden="until-found"` 依赖 UA 的 `content-visibility: hidden` 规则；作者内联 `content-visibility: visible` 会覆盖它。
- **规避**：关闭面板不要设置 `content-visibility`，交给原生 `until-found`；行为测试断言 `hidden` 属性存在且内联 `content-visibility` 为空。

## 分享：token 放在 URL 片段，页内锚点会把它替换掉

- **现象**：分享页点正文锚点后刷新变成 404；或 token 出现在请求头/日志里。
- **原因**：片段（`#token`）不会发给服务端，适合携带秘密；但默认的 `a[href^="#"]` 跳转会把整个片段换成目标 id。
- **规避**：链接固定为 `/s/<shareId>#<token>`；正文点击拦截 `a[href^="#"]`，只滚动到目标、不改 URL；页面先挂 `no-referrer` 再发公开请求。不要为了省事把 token 放进查询串。

## 测试：个人记忆相关套件共用同一行，必须用会话级 advisory 锁

- **现象**：多个记忆测试文件并行时互相覆盖管理员个人偏好，断言随机失败。
- **原因**：测试共享数据库，且都会删写 `user_preferences` 的同一行；普通事务隔离挡不住跨文件写。
- **规避**：同一库内串行化这些文件，使用同一 `MEMORY_TEST_LOCK` 的 `pg_advisory_lock`；不要靠放宽断言或删除冲突用例。

## 前端：`routeTree.gen.ts` 由 Vite 插件生成，不要手改

- **现象**：新增路由文件后类型检查报路由未注册，或手改的生成文件被下一次 dev/build 覆盖。
- **原因**：TanStack Router 的 Vite 插件在 dev/build 时生成 `routeTree.gen.ts`，`tsc -b` 不负责生成。
- **规避**：新增或删除路由后跑一次 `bun run --filter @agentport/web build`（或 dev），让生成文件更新并随改动提交；不要手工编辑生成文件。

## 数据库：新增运行触发值要同步扩展 CHECK 约束

- **现象**：插入 `agent_runs.trigger='review'` 时报 CHECK 约束失败，代码与 schema 看似一致。
- **原因**：`trigger` 是 text + CHECK 约束（`chat/mcp/schedule/event/review`），不是 PostgreSQL enum；改 Drizzle schema 不会自动改已有约束。
- **规避**：新增触发值时先 `bun run db:generate` 生成扩展 CHECK 的迁移，再 `bun run db:migrate`；不要假设 text 列会接受新值。

## 测试：真实容器测试可能加载旧 dist，产物存在不等于来自当前源码

- **现象**：真实 Docker / SDK 测试全绿，实际行为却对应旧代码；镜像或挂载里是旧的 `shared`/`sandbox` 构建。旧 Vitest 入口还曾在新建 worktree 首次跑用例前报 `TypeError: code.charCodeAt is not a function`。
- **原因**：测试只检测 `dist` 是否存在，或复用镜像中旧的 `shared` 产物，没有确认产物来自本轮源码；根 `bun run test` 只跑测试，不等于执行构建。旧 Vite 转换会把缺 workspace `dist` 的模块解析异常改写成 `charCodeAt` 堆栈。
- **规避**：每轮为 `shared`/`sandbox` 编译独占临时产物或显式构建最新版本，并记录产物来源；验收跑真实 Docker 与 SDK fake API；不要把根测试入口当作构建步骤。新树先 `bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build` 再跑后端测试；遇到 `charCodeAt` 先查缺哪个 workspace `dist`，不要改业务代码。后端测试由 globalSetup 在随机 PostgreSQL 库和临时 Redis 上运行，不手动迁开发库、不回落共享库。

## 实现：被工作区与产出共用的目录刷新不能无条件保留记忆挂载根

- **现象**：接入子智能体记忆后，产出目录里合法的 `.claude/agent-memory` 首次复制就丢文件、红测试报 `ENOENT`；切换草稿版本时目标还留着上一版内容。
- **原因**：`refreshSessionDirectory`（`packages/worker/src/session-workspace.ts`）同时服务定义工作区与产出目录，却无条件跳过 `.claude/agent-memory` 以保住工作区的挂载根 inode；产出目录没有挂载根，同名目录只是普通用户文件，被当挂载根跳过就不再复制或删除。
- **规避**：保留挂载根改为显式选项 `preserveMemoryMount`，只在定义工作区调用时传 `true`（`packages/worker/src/index.ts`），产出保持整棵替换；新增刷新调用前先确认目标是否真有挂载根，不按目录名猜语义。

## 安全：记忆策略只收窄 SDK 文件工具，不收窄挂载权限

- **现象**：`writeMode=proposal_only` 时 hook 已拒绝 `Write`/`Edit`，容器内 Bash 仍能直接写 `/mnt/agent-memory`，运行期写入策略形同虚设。
- **原因**：挂载决策只看 `policy.enabled`，记忆目录恒为 rw；PreToolUse 只覆盖原生文件工具，Bash 写入走的是内核挂载权限。
- **规避**：挂载可写性必须与策略同源——只有 `enabled && writeMode === 'native_auto'` 才 rw，`proposal_only` 只读，关闭专家记忆时不挂（`memoryMountFor`，`packages/worker/src/sandbox/sessions.ts`）；子智能体记忆跟随同一可写性。只读是挂载身份的一部分，切换 `writeMode` 触发容器重建，不能只改运行中容器的属性。

## 测试：生产 ESM/CJS 互操作不能用测试运行结果代替

- **现象**：ExcelJS 等 CJS 依赖在旧 Vitest 入口里导入全绿，构建后的 API 以原生 ESM 启动却报具名导出缺失。
- **原因**：Vitest/Vite 会做 CJS 互操作与转译，掩盖打包后 Node 原生 ESM 对具名导出的限制；测试环境通过不代表 `dist` 可加载。
- **规避**：用真实 Node 导入构建产物（如 `node --input-type=module -e "await import('./packages/api/dist/...')"`）或直接启动构建后的服务；不把测试绿色当作 ESM 兼容证据，也不用 mock 替换该检查。

## 知识库：COW 事务提交后失败清理不能删除已发布文件

- **现象**：新版本事务已提交并切指针，随后 job 收尾抛错，cleanup 把当前版本正文/图片删掉，检索或下载失败。
- **原因**：清理按「本次作业失败」判断，没区分事务前残留与新版本已提交；已发布版本的文件已被 `currentVersionId` 引用。
- **规避**：清理只删除未被任何版本引用的临时/残留文件；提交后失败只标记任务失败，不回收已发布版本目录。真实 PG 事务测试覆盖「提交后抛错」分支。

## 归档：ZIP 预检的 central/local 与目录身份必须同解释

- **现象**：xlsx 解压限额被绕过（中央目录与本地文件头名称不一致），或真实空目录/恶意目录在导入时误判。
- **原因**：不同解析器分别读中央目录与本地文件头，目录项未按同一身份校验；只看声明大小或先完整加载再检查都拦不住。
- **规避**：预检与实际解压共用同一实现与同一路径/身份规则，目录也校验；按实际解压字节统计并设上限，异常立即中止。改共享 ZIP 代码后同时回归 xlsx 与知识包两条调用。

## 知识库：`file-type` 的 AIFF 识别只认 `FORM` 头，普通文本会被误判

- **现象**：以 `FORM` 开头的普通文本（例如 `FORM is important`）在音频入口被当成音频；若直接拒绝，会把非音频文件误报为不支持音频格式。
- **原因**：`file-type@22.3.0` 对 `aif` 只检查 IFF 的 `FORM` 魔数，不核对偏移 8 处的 `AIFF`/`AIFC` 类型字段；仅凭魔数不能证明容器成立。
- **规避**：在 `packages/core/src/knowledge-audio.ts` 增加 IFF 类型字段校验，并用“纯文本以 FORM 开头”和“截断但头成立”两条 fixture 区分。格式识别只证明头成立，不是完整解码；不要把识别通过当作音频可转录。

## 模型客户端：响应头已到后的读流失败不能归为 `bad_response`

- **现象**：embedding/rerank/转录请求已拿到 2xx 响应头，读 body 时连接中断，却返回 `bad_response`，队列因此不重试；实际是传输故障。
- **原因**：旧路径先 `JSON.parse(await response.json())`，把读流失败与完整 JSON 的语法错误混在同一处；响应头成功不代表正文已完整到达。
- **规避**：在 `packages/core/src/knowledge-models.ts` 的 `readJsonResponse` 先 `await response.text()`，读失败复用取消/超时/不可用分类，只有完整文本解析失败才是 `bad_response`。embedding、rerank 与 ASR 共用这一处，不要在调用方各自 catch 后重分类。

## 知识库：Wiki 最新版本不能用 `created_at`/`now()` 排序

- **现象**：并发保存或打开组织弹层时，按 `created_at DESC` 取到的“最新”版本不是版本号最大的那版，乐观锁误报 409。
- **原因**：PostgreSQL 的 `now()` 是事务开始时间；先开始、后提交的事务可能得到更早的 `created_at`。版本行在同一事务内写入，时间戳不保证随版本单调递增。
- **规避**：最新版本、版本列表与 keyset 分页统一按 `version DESC`（同页再加 version keyset），版本号在页面行锁与唯一约束内生成；不要按 `created_at`/`id` 推断业务顺序。当前仓储已改为 `version DESC`，相关定向测试与独立复核结论以任务记录为准，不把本条写成全绿。
## 数据库：`userId` 改 `businessId` 必须选 rename，且 Vite 会把真实迁移错误掩成 `charCodeAt`

- **现象**：drizzle-kit 生成迁移后，新库执行报 PostgreSQL `multiple primary keys for table ... are not allowed`；在旧 Vitest globalSetup 里可能只看到 `TypeError: code.charCodeAt is not a function`，看不出是迁移失败。
- **原因**：交互式生成时把改名默认当成「新增列 + 新主键」，会生成 `ADD PRIMARY KEY`，而旧主键还在；真实错误又被 Vite 的 globalSetup 包装改写成 `charCodeAt` 堆栈（另见「真实容器测试可能加载旧 dist」一条）。
- **规避**：生成时明确把该列选为 rename，保留 `RENAME COLUMN`，并在同一迁移里删除原列上指向 auth `user` 的外键，不要接受默认的 add 方案。验证时绕过前端测试转译，直接用 Bun 运行调用 `createIsolatedDatabase` 的临时脚本，建全新随机库并迁移，拿到真实 Pg 错误；不要在共享库上试。

## 运行：`/health` 只证明连通，不证明 schema 与当前代码匹配

- **现象**：API `/health` 返回 DB/Redis ok，worker 一启动就报 `agent_runs.subject_kind` / `audit_log.actor_kind` 缺列；或旧库的迁移账本停在旧编号，直到业务请求才 500。
- **原因**：健康检查只 ping 连接，不校验迁移是否追平当前 journal、表结构是否含新列。
- **规避**：复用旧库或新起进程前，先核对 `__drizzle_migrations` 末条与当前 journal、用 `\d <table>` 或一次真实业务查询确认列已存在；不要把健康检查当作迁移完成。数据集与测试优先使用独立库。

## 运行：运行环境的 base image 由 API 入队冻结，API 与 worker 必须同 `SANDBOX_IMAGE`

- **现象**：`.env` 换成专用沙盒镜像并重启 worker 后，环境版本仍从旧 `agentport/sandbox:dev` 构建，报缺 `session-supervisor.js`；或 API 与 worker 实际使用不同镜像。
- **原因**：API 入队时把自身的 `SANDBOX_IMAGE` 冻结进运行/版本，worker 按版本的 `baseImageId` 构建；只改 worker 或只改 `.env`、不重启 API 都不生效。已有运行环境的默认 base 指针也不会随 env 更新。
- **规避**：API 与 worker 用同一 `SANDBOX_IMAGE` 启动，改镜像后两者都重启；需要专用底座时显式指定或更新运行环境 base，并核对版本记录里的 `baseImageId`，不要假设默认指针跟随 env。

## 测试：E2E session 只保存登录，不会替你打开页面

- **现象**：auth setup 登录成功并保存 session，后续用例或 helper 在写请求/查 UI 前没 `app.open`，报 `APP_NOT_OPEN` 或定位不到元素。
- **原因**：`test.setup` + `session.save` 只落登录态；页面上下文要显式打开，已有 session 不等于页面已就绪。
- **规避**：需要 UI 的步骤先 `app.open(路径)`；helper 里先打开再读写页面。纯 API 校验可以不开页，但不能用它宣布 UI 已通过。

## 测试：macOS 的 `os.tmpdir()` 是软链路径，测试工作区要先 realpath

- **现象**：在 macOS 上以 `mkdtemp(join(tmpdir(), ...))` 建工作区，路径校验报越界或不是真实路径，测试随机失败。
- **原因**：`/var/folders/...` 经 `/var -> /private/var` 软链；工作区按 realpath 做越界校验时，未解析的 tmpdir 与真实路径不一致。
- **规避**：创建测试目录前先 `await realpath(tmpdir())` 再 `mkdtemp`（如 `packages/api/test/agents-access.test.ts`）；不要放宽路径校验或改业务代码，明确指定非软链 `TMPDIR` 只算临时绕过。

## 运行：本地 CA 签发的 HTTPS 在 Node 中默认不受信任

- **现象**：调度 guardian 用 Node 直接请求本地 HTTPS 地址时因证书不受信任失败，而浏览器或 curl 正常。
- **原因**：Node 自带 CA 集合不包含本机开发 CA，需要显式使用系统 CA 或传入 CA。
- **规避**：本地 HTTPS 联调时给 Node 加 `--use-system-ca`（或临时 `NODE_USE_SYSTEM_CA=1`）后重新验证，不要关闭 TLS 校验；固化到脚本前确认当前 Node 版本支持该参数。

## 运行：worker 写入预算与 Redis 保留窗口不一致会让刷新丢掉流头

- **现象**：生成中刷新后早期文本和工具事件消失，Redis 流 `streamEntries` 停在 1013 左右且 `trimmed=true`，而 worker 自报的事件预算远未用尽。
- **原因**：worker 按自己的展示/落库预算接受事件，`XADD` 却仍带 `MAXLEN ~ 1000`，Redis 先按保留窗口裁掉流头；两个上限互不知情。生成中的助手消息此时还没落库，重放只能从剩余尾部开始，刷新也就补不回被裁内容。
- **规避**：保留窗口与写入预算要由同一套契约常量约束，写入端不做条数裁剪。验证长流必须用超过旧上限的事件数（如 1200/1600）断言完整回放且无 `replay_truncated`，不能把「流只剩 1000 条」当成正常 fixture。当前契约是 `shared/run-stream.ts` 的瞬时/落库各 2000 条、32MiB，`XADD` 无 MAXLEN，仍靠每次写入续期 `EXPIRE 3600`，没有 PERSIST 或新增生命周期。

## 恢复：终态要先确认再读本轮 canonical，不能沿用首次 history

- **现象**：刷新时首屏历史已返回，随后 run 查询才变终态，页面只显示用户问题或旧的半截回答；运行记录被清理时还会留下永远 `detached` 的假运行。
- **原因**：历史请求与 run 查询并发，首次历史可能早于本轮落库完成；终态分支沿用了首次 history，没有在终态确认后重读消息。404 又和「暂时读不到 run」走了同一恢复分支。
- **规避**：先确认 run 详情是终态，再按 runId 分页重读完整本轮消息；合并已加载旧轮 prefix、跨页补出本轮 user 锚点，不用默认 50 条覆盖。404 视为记录已清理：释放假运行但保留已保存历史。测试要让首次 history 返回旧内容、run 详情延后返回终态，才能覆盖这个竞态。

## 测试：故障删除用例持共享绑定锁等满 ACK，会拖垮同轮并行套件

- **现象**：全量并行时 `conversations` 的删除用例偶发返回 503（期望 204），单跑或换一轮不一定复现；同一批里其它删除/准入用例也可能撞 5s 控制查询超时。
- **原因**：删除路由在事务外等 worker 关闭 ACK（最长 10s），期间仍持全局 `AGENT_BINDINGS_LOCK_KEY` 会话锁；「worker 不在线/不 ACK」的故障用例要等满预算，共享库上的其它套件删除/准入被这把锁阻塞，失败不是删除实现回归。
- **规避**：故障/无 ACK 用例用 `createIsolatedDatabase` 独占库（`packages/api/test/delete-lifecycle.test.ts`），并配独享 Redis（Pub/Sub 不按库隔离）；不要放宽 ACK 预算、缩短超时或把整套串行。ACK 等待保持在事务外，锁由会话级持有到文件回收完成。

## 测试：跨进程共享的同步写文件不是原子操作

- **现象**：宿主读到 fixture 输出的 `Unexpected end of JSON input`，但 writer 进程没报错；重跑时有时通过。
- **原因**：`writeFileSync` 先截断再写，另一端恰好落在截断与写完之间就会读到半截 JSON；同一文件由不同进程高频覆盖时概率更高。
- **规避**：同目录写临时文件再 `renameSync` 到目标（`packages/worker/test/fixtures/session-task.mjs` 的 busy 输出）；跨进程读的文件都按这条处理，不用「重试解析」掩盖。

## 测试：消息持久化与账号重建套件共用 worker 身份会冲突

- **现象**：`message-persistence` 与 `run-pending-finish` 同轮并行时，后者 `createTestAccount` 返回 409「该业务 ID 有历史记录」，未进入测试主体；独立运行通过。
- **原因**：两者复用 `fixtures/access.ts` 的 `TEST_BUSINESS_ID`，前者可先写带该身份的消息，后者此时建账号被正常的身份恢复校验拒绝。
- **规避**：验证时让 `run-pending-finish` 独立运行或用 `--no-file-parallelism`；改夹具时按套件分配唯一业务身份，不放宽生产身份校验。

## 测试：依赖安装与测试运行并发会让新 worker 丢掉旧 peer 路径

- **现象**：长测试跑着时执行 `bun install`/升级依赖，已启动的 worker 多数正常，但新 fork 的 worker 报模块找不到，路径指向已被替换的 `node_modules/.bun` 目录；单独重跑整套又全绿。
- **原因**：Bun 安装会重排隔离 store 并更新顶层链接；已加载模块的进程不受影响，新 worker 按新解析结果启动，旧 peer 路径已不存在，失败被误当成代码回归。
- **规避**：测试运行期间不安装/升级依赖；先停掉测试进程，等 `bun install` 完成后再从干净状态重跑。出现这类「路径不存在」先核对是否刚装过依赖，不要改业务代码或删测试。

## SSE：`subscribeRun` 回放完才 resolve，await 之后启动的定时器保护不了长回放

- **现象**：成员打开 run 事件流后、Redis 回放尚未结束时被移出频道，已撤权的连接仍把回放中的历史 token 送给对方，直到回放结束才停。
- **原因**：`subscribeRun` 在首次回放全部完成后才 resolve；调用方在 `await subscribeRun(...)` 之后才启动撤权/终态复核定时器，回放期间的逐事件回调不经过该定时器，而逐页回放可能持续很久。
- **规避**：撤权核验必须放在回放回调内逐事件执行（每次重新查成员/run），不能只依赖 await 之后的定时器；需要周期核验时用独立授权计时或在回放循环里检查。测试把撤权卡在回放第一页之后，断言剩余 token 一条都不外发。

## 迁移台账与仓库 journal 不一致，所有登录 500

- **现象**：任意 worktree 的 API 登录都返回 500，日志是 `relation "platform_bootstrap" does not exist`；`drizzle.__drizzle_migrations` 有几十条旧记录，但最大 `created_at` 早于当前 journal 的 0043。
- **原因**：多个 worktree/分支各自生成过迁移，共享库被另一套 journal 迁移过，台账与仓库 journal 的时间戳/内容对不上。drizzle migrator 只按「journal.when > 台账最大 created_at」判断待执行，于是重跑已存在的迁移，在第一个 `CREATE TABLE` 就失败并整批回滚。
- **规避**：先 `pg_dump -Fc` 备份；只读核验实际结构与 journal，确定真实基线；对已存在的对象按核验结果登记台账（hash 用迁移 SQL 的 sha256），对新增的 NOT NULL 列先建可空列、回填后再 `SET NOT NULL`；在 dump 恢复出的副本库完整演练后再作用于共享库。不要直接 `bun run db:migrate` 硬跑，也不要为了跑通而删除业务数据。

## 运行：Bun 默认空闲超时也会断开仍在处理的请求

- **现象**：MCP `tools/call` 没有提前输出响应字节，约 12 秒出现 `ECONNRESET`，服务端提示请求空闲超过 10 秒；JSON、导入导出也会受同一入口设置影响。
- **原因**：`Bun.serve` 默认 `idleTimeout` 为 10 秒，按网络字节活动计时，不是业务执行截止。Bun 1.4.3 实测全局 `idleTimeout: 0` 和入口 `server.timeout(request, 0)` 都不会在响应完成后自动恢复空闲 keepalive 回收。
- **规避**：API 统一配置 `idleTimeout: 0`，保留业务自己的截止、取消和 `HTTP_DRAIN_MS` 有界 HTTP 排空。验证必须用真实端口等待超过 12 秒且没有响应字节，另外观察响应后的空闲连接和 SIGTERM；不要只放宽某条 SSE 路由，也不要把默认值换成另一个有限业务上限。

## 运行：Redis 主动 close 也会触发 onclose，排空与释放必须分开

- **现象**：worker 正常退出时出现 `session cleanup subscriber error` / `publisher error`；试图用 `onclose = null` 解除回调，在 Bun 1.4.3 实测会使后续 `.close()` 抛 `TypeError`，尽管本地类型允许 `null`。
- **原因**：正常释放也触发断线回调，回调本身不能区分主动关闭与异常。开始排空时在途 ACK 仍依赖 publisher，不能把整个排空期都当成无须记录的主动释放。
- **规避**：只在最终 `.close()` 前设置局部释放状态，在 `onclose` 中据此抑制主动关闭告警；初始化订阅失败的释放走同一判定。保留排空期间的异常、排空超时与 ACK 发布失败日志。系统探针分别验证正常 ACK 后关闭、真实 Redis 故障和在途 ACK 失败；退出码之外同时检查 fatal 日志。

## 运行：临时 PostgreSQL 的 Unix socket 就绪不等于宿主 TCP 已就绪

- **现象**：独享 PostgreSQL 容器的 `pg_isready` 成功后，宿主首次连接仍报 `Connection terminated unexpectedly`。
- **原因**：初始化时先启动只监听 Unix socket 的临时服务，初始化完成后停止它，再启动正式 TCP 服务；默认 `pg_isready` 可能命中临时服务。
- **规避**：容器内探测显式用 `pg_isready -h 127.0.0.1`，确认正式 TCP 服务就绪后再通过映射端口连接；失败仍按本次创建的容器 ID 清理。

## 迁移：删依赖后旧 `node_modules` 残留会掩盖未迁移的测试与 E2E

- **现象**：移走旧驱动（如 ioredis）后，沿用旧安装的依赖树跑测试仍可能全绿；在干净 `bun install --frozen-lockfile` 下，测试或 E2E 里的旧直接导入、旧连接参数才报错。
- **原因**：旧安装或上级目录中仍可解析的依赖可能掩盖未迁移调用，旧工作区测试通过不证明锁文件能在干净环境复现；当前源码 typecheck 不覆盖测试与 E2E；只搜索直接 import 也会漏掉 BullMQ 旧 connection options 这类隐式驱动入口。
- **规避**：删依赖时同时检查源码、测试、E2E 与隐式驱动入口；在干净依赖环境跑对应的真实回归，不通过补回旧驱动来掩盖漏迁。

## 镜像：恢复旧镜像 ID 不等于它能被当前 worker 执行

- **现象**：按旧盘记录恢复出的镜像内容与历史一致，但当前 worker 仍不能用它跑新的会话运行：历史镜像内没有 `bun`，默认基座还缺 `session-supervisor` 与 `bash`。
- **原因**：当前会话容器以 `bun` 为入口执行 `dist/session-supervisor.js`（`packages/worker/src/sandbox/sessions.ts`）；创建容器时按环境线上版本冻结的 `imageId` 取镜像（`resolveOnlineRuntimeEnvironment` 只选 `ready` 且 `imageId` 非空的版本），`baseImageId` 决定构建基座，不参与会话容器的镜像选择。OCI 恢复只还原内容，不保证镜像满足当前入口命令和工具链。
- **规避**：接管旧运行环境前，分别核对镜像内 `bun`、`session-supervisor` 与 `bash`，并与当前 worker 的入口命令对照；需要重新执行时基于由当前 Dockerfile 构建并验证具备 Bun、supervisor 与 bash 的基座构建并发布新版本，不能凭 tag 认定基座能力，不改冻结 ID、不为旧 runner 加兼容层。启动命令只是配置加载方式，不等于镜像可直接运行。

## 接口：前后端各兜一次同一个默认值，服务端的兜底分支会变成死代码

- **现象**：复制知识库弹层把 slug 预填成 `源slug-copy` 并始终随请求发送，服务端 `body.slug ?? 自动挑一个未占用 slug` 的自增分支因此永远走不到；同一源库第二次复制直接 409。单测只测接口，仍全绿，形成假安全感。
- **原因**：同一个决策（副本 slug）在 UI 与服务端各表达一次，且 UI 侧不是「留空交给服务端」，而是自己算了一个看起来等价的值；接口测试与 UI 行为不同源。
- **规避**：默认值只在一处决定。需要服务端兜底的字段，UI 留空并显示建议值（placeholder）；提交时只在用户真的填了才带该字段。接口测试同时覆盖「未传 → 自动挑选」与「显式传已占用值 → 409」，UI 测试断言「默认不传该字段」。

## 测试：给共用页面新增查询后，其他测试文件的「未配置请求」断言会集体失败

- **现象**：知识库列表页新增个人置顶查询后，只改了自己的 `knowledge-management.test.ts`，另三个也渲染 `KnowledgePage` 的文件（`knowledge-audio`、`knowledge-source-forms`、`knowledge-create-flow`）报 `expected [ 'GET /api/knowledge/bases/pins' ] to deeply equal []`。
- **原因**：这些文件各自维护 MSW handler，`msw.assertClean()` 把任何未配置请求当作失败；页面新增 Query 等于给所有渲染它的文件加了必配路由。中途 `await cleanup()` 会 `resetHandlers()`，之后还需要重新注册默认 handler。
- **规避**：新增列表级查询时先 `grep -l "<页面组件>" packages/web/test` 找出所有渲染该页面的文件，逐文件补默认 handler；用例内覆盖同一路由时用更靠后的 `server.use` 覆盖默认值，不要在共享 helper 里写死业务返回。

## 频道：SSE 初始游标不能取乐观消息的 seq

- **现象**：离开频道再返回后频道直播流不再收到新消息，EventSource 持续重连，服务端日志是未来游标 400。
- **原因**：前端频道消息缓存里可能有乐观消息，seq 用 `Number.MAX_SAFE_INTEGER` 占位；SSE effect 从缓存尾部取 seq 作为 `after`，服务端判定游标超过 maxSeq 拒绝。
- **规避**：初始游标只取 id 不以 `local-` 开头的已落库消息；任何从消息缓存推导 SSE 游标的逻辑都要排除乐观项。

## 频道：markRead 去掉频道行锁后必须用 greatest 防回退

- **现象**：快速滚动或并发标记已读时，last_read_seq 可能被较旧的请求覆盖，未读数反弹。
- **原因**：原先靠 channels 行 FOR UPDATE 串行化；去掉行锁后多个读标记事务按各自算出的 target 直接覆盖。
- **规避**：更新用 `greatest(last_read_seq, target)` 并在 returning 里取最终值；target 仍需夹到当前 max(seq)。并发语义靠单行原子更新，不重新引入频道行锁。

## 验收：visual-shots 的 minimal 种子只有频道没有消息

- **现象**：`bun run visual:shots --full --route /channels/<id> --seed minimal` 只能截到空频道，验证不了多用户作者、历史分页和设置弹层内的成员列表。
- **原因**：minimal 种子只创建 2 个 agent、1 个频道和绑定，不写消息，也没有第二个成员。
- **规避**：先跑 `--keep` 起隔离栈，从输出拿临时库名，用 `docker compose exec -T postgres psql -U agentport -d <临时库>` 直接插第二个账号、channel_members 和 channel_messages（保持 business_id 与 auth 表一致），再用 `--base-url http://localhost:5173 --seed none` 截详情；设置弹层等交互态用 ego-browser 登录后点开再截。收尾删除 Redis 容器与临时库。

## 接口：非幂等操作提交后不要返回可重试 5xx

- **现象**：移除频道成员/智能体的 DELETE 已提交删除，但随后取消其活动 run 失败，接口返回 503（AppError 默认 retryable=true）；客户端按提示重试同一个 DELETE 得到 404，残留 run 仍不会取消，“稍后重试”永远不可能成功。
- **原因**：把事务提交后的清理失败当成了整个操作失败；DELETE 不像 close/disconnect 那样可幂等重放，重试语义与已完成的删除结果冲突。
- **规避**：主操作已提交后，清理失败只记 warn 日志并按成功返回；若确实需要把清理失败暴露给调用方，改成幂等操作或把失败项放进成功响应体，不要返回可重试 5xx。close/disconnect 这类可幂等重放的操作才保留 503。

## 频道：频道作用域复用私有组件时，内部 mutation 会绕过频道授权

- **现象**：频道 run 详情复用 `StepInspector` / `RunQuestionCard` 后，回答提问仍走私有 `/api/runs`，频道 run 必然失败，同一提问还会重复出现。
- **原因**：组件内部固定调用私有 mutation，没有接收频道 responder；视图沿用了组件，提交通路与授权范围却没有一起切换。
- **规避**：频道场景显式传入频道 responder，或移除组件内的操作入口只保留展示；服务端仍按 `getChannelRunForMember` 与频道角色校验，不依赖前端隐藏入口。

## 频道：持久 system 行只写库不发布会与本地流锚点重复

- **现象**：run 终态失败时在线端出现两条提示，一条来自本地 run 流，一条来自持久频道消息。
- **原因**：终态 notice 只落库时，在线端要等 `run.finished` 的 SSE catch-up 才拿到；前端若不按 runId 丢弃本地流锚点，流内失败提示与持久 notice 会同时显示。
- **规避**：写库方同时发布 `message.created`；前端收到任何带 runId 的持久消息时丢弃对应本地流，并保留 `run.finished` catch-up 作为发布失败的兜底。

## 数据库：ON DELETE RESTRICT 报 23001，不是 23503

- **现象**：父专家删除改为 `ON DELETE restrict` 后，按 23503 捕获外键冲突的映射不生效，删除返回 500。
- **原因**：PostgreSQL 对 `RESTRICT` 立即检查报 `23001 restrict_violation`，`NO ACTION` 才报 `23503 foreign_key_violation`；Drizzle 还会把错误包在 cause 链里。
- **规避**：捕获时同时接受 23001/23503，并核对 `constraint` 名，避免把其他外键（如 `memory_reviews.model_agent_id`）误映射成子专家错误。

## 测试：清理专家时先删父专家会违反 `agents_parent_id_agents_id_fk`

- **现象**：全量 `bun run test` 时，`packages/api/test/agent-package-zip.test.ts` 与 `packages/worker/test/run-pending-finish.test.ts` 的 afterAll 报 `agents_parent_id_agents_id_fk` 违反。
- **原因**：`agents.parent_id` 是 `onDelete: 'restrict'`；测试清理按 slug/id 批量删除专家时不保证先删子专家，先删父专家会被数据库拒绝。
- **规避**：测试清理先按 `parent_id` 删除目标 slug 专家的直接子专家，再删除目标专家；worker 测试的清理数组按「子在前、父在后」入栈，不要只依赖单条 `delete from agents where slug = any(...)`。

## 数据库：事务内按预读行计算写入集合会漏掉并发新增行

- **现象**：删除来源并保留文档时，接口返回 `affected: 1`，实际该来源停用了 2 篇文档，第二篇的 Wiki 也没有标记过期；返回值与日志都正常。
- **原因**：`deleteSource` 先 `SELECT ... FOR UPDATE` 文档并按旧行算 affected，随后才 `UPDATE` 该来源全部文档。READ COMMITTED 下同一事务不同语句的可见集合可以不同；持有来源行 `FOR UPDATE` 也挡不住没有外键约束的 `source_connection_id` 插入，而同步流程正是先 `createDocument` 再对来源取 SHARE 锁，新文档落在两条语句之间。
- **规避**：写入行集合从变更语句的 `RETURNING` 取：keep 分支用停用的 `UPDATE ... RETURNING` 同时计算 affected 与后续 Wiki stale，不凭预读行或父行锁推断。锁序保持现状，不为此加锁。并发验证用真实 PG 锁住首篇文档让 SELECT 等待、插入第二篇后释放，并观察 `pg_locks` 确认等待关系，不用固定 sleep 推先后。
