# 踩坑记录

> 跨任务反复出现的坑统一记在这里，由 `CLAUDE.md` 指向。主会话与执行子代理动手前先读，落实相关规避方式；任务范围变化或报错时重新核对，不只在踩坑后追加。
> 不限定类别：遇到值得留存、能避免以后重复犯错的教训就及时整理，运行、实现、沟通、测试只是例子。每条固定「现象 → 原因 → 规避」，不把任务流水账和已有操作说明复制进来。

## 运行：宿主直跑 worker 时模型网关地址不能被改写成 host.docker.internal

- **现象**：`pnpm dev` 下真实对话全部失败，worker 日志反复出现 `model proxy request failed: other side closed`，但直接请求网关正常。
- **原因**：模型代理无条件把上游 loopback 改写成 `host.docker.internal`；该别名只在容器内可解析，宿主进程访问同一网关会失败。
- **规避**：只有 worker 自身在容器内时才改写（`packages/worker/src/upstream.ts`，用 `/.dockerenv` 判定）；沙盒侧地址仍必须改写。改到这里时不要把它和沙盒的 `toHostUrl` 混用。

## 复制到 worktree 的 `.env` 可能比刚确认的配置旧

- **现象**：新 worktree 起了服务，但用户刚确认的管理员密码失效；或 `.env` 缺 `APP_SECRET_KEY` / `ANTHROPIC_API_KEY` 起不来，装好依赖后前端也可能无法解析 `@agentport/shared`。
- **原因**：`.env` 不受 Git 管理；`.worktreeinclude` 只在建树时复制一次，来源是发起建树的那棵树（可能是旧 worktree），结果不代表最新。主 checkout 的 `.env` 也可能是旧残留。worktree 还不带 `node_modules` 与 workspace `dist`。各树共用数据库；历史实现曾在首次登录时用 `ensureAdmin` 按当时的 `ADMIN_PASSWORD` 重播管理员，旧配置一登录就把用户刚设的密码覆盖掉。当前已改为 `ensureBootstrap`：`platform_bootstrap` marker 只允许初始化一次，之后 `.env` 的 `ADMIN_PASSWORD` 不再覆盖现有账户。
- **规避**：配置默认取主 checkout `.env` 的绝对路径，启动前核对 `ADMIN_USER`/`ADMIN_PASSWORD`/`ALLOW_WEAK_ADMIN_PASSWORD` 等改动过的关键项；用户最新明确决定优先于磁盘上的值，不以「来自 main 的 `.env`」当成用户决定。登录验证使用用户确认的账号密码，不把 `.env` 的值等同于当前密码；也不拿测试或调试任务改掉用户登录态。然后 `pnpm install --frozen-lockfile`，前端预览前构建 shared/core。新增必填 env 文件时同步加进 `.worktreeinclude`（仅作初始化副本，仍不保证最新）。规则集中在 `docs/DEV-WORKFLOW.md`「配置与启动」。

## 多个 worktree 同时跑全栈 compose 会互相踩

- **现象**：两个窗口的任务看到对方的数据/容器，或 `3000/5432/6379` 端口被占起不来。
- **原因**：`docker-compose.yml` 写死 `name: agentport` 和主要宿主端口（api 3000、postgres 5432、redis 6379、Docling 5001；只有 worker 模型代理端口走 `MODEL_PROXY_PORT`），所有 worktree 共用同一 compose 项目、卷、端口。
- **规避**：只让主 checkout 跑基础设施（postgres/redis），各 worktree 只跑应用进程连同一套。`COMPOSE_PROJECT_NAME` 只能分开项目、容器和命名卷，改不了写死的宿主端口；`HOST_WORKSPACES_DIR` 默认仍指向原项目的命名卷，`SANDBOX_API_URL` 也写死回连 3000，多套全栈还会共用工作区与回连地址。所以项目名本身不提供隔离，确需并行全栈要单独方案，先核对端口、宿主卷与回连地址再动手。端口说明见 `docs/OPERATIONS.md` §2.2 与 `docker-compose.yml` 的 `ports`。

## EnterWorktree 的 name 只接受 ASCII slug

- **现象**：用中文任务名调用 `EnterWorktree` 会失败。
- **原因**：工具限制 name 每段只能是字母、数字、点、下划线、短横线（最长 64）。
- **规避**：worktree 名用 `log-to-file` 这类 ASCII slug；中文只写在 `docs/tasks/<slug>.md` 的标题里。

## worktree 里两类命令会被拒绝，原因不同

- **现象**：worktree 会话里出现两种拒绝。①「runs rtk with a git command among its operands … Refusing to run it」；②「this command is too complex to verify that it stays inside the worktree … Split it into plain, separate commands」。
- **原因**：①是 `rtk hook claude` 把 `git` 包成 rtk 调用，命令里看不出实际执行的是哪个 git；②是 worktree 隔离守卫无法静态解析该命令，例如「建目录 + heredoc」写在同一行（`mkdir -p X && cat > X/a.mjs <<'EOF'`）。实测单独 `mkdir -p X`、单独 heredoc、`mkdir && echo`、`until [ -n "$(…)" ]` 都可通过，所以②不覆盖所有复合命令。
- **规避**：git 用 `/usr/bin/git <args>` 直接调用，不要混进复合命令；写临时脚本时先把 `mkdir` 和 heredoc 分成两次调用。遇到其它拒绝先按报错原文区分是 rtk 还是 worktree 守卫，不要一律归因 RTK。

## 测试：队列消费者检查要看库号和队列名，不能只看实例

- **现象**：`pnpm test` 里 `chat-admission`、`chat`、`eval` 等套件整组 skip 或报 `worker must be stopped`，换机器/换时间又正常。
- **原因**：`queueIdle` 用 `redis.client('LIST')` 扫全实例，而 `CLIENT LIST` 不受库号隔离；开发库 db 0 上常驻的 worker 会被算成「被测队列的消费者」。`Queue.getWorkersCount()` 同样扫全实例、只按 clientName 过滤，换成它并不能解决。测试全部并行时，同轮其它套件起的 worker（`sandbox-probe`、`native-queue`）也会被误算。
- **规避**：默认入口已由 backend globalSetup 每轮提供独享临时 Redis 容器（实例内固定 db 9），开发 worker 留在另一个共享实例的 db 0，因此看不到测试队列。自己判消费者时仍要同时按 `db=<库号>` 和 `name=bull:<base64(队列名)>` 过滤，不能只看实例；用独立 `prefix` 的套件（如 `schedule-scheduler`）真实 worker 看不到，不需要消费者检查，直接判 Redis/Postgres 可用即可。

## 测试：全量并行时偶发 401，根因是登录后会话没落库

- **现象**：`pnpm test` 全量跑时，`agents`、`servers`、`knowledge-routes` 等随机有文件报 `UNAUTHORIZED: not logged in`，每轮命中的文件都不一样，单独跑又全过。
- **原因**：多个测试文件并行登录同一管理员时，better-auth 偶发返回 200、也下发了 cookie，但会话行没写进库。实测证据：失败的那张 cookie 重试仍 401、换一个 app 实例也 401，而会话表里既有会话完好、行数没有减少——所以不是缓存、不是 CASCADE、不是限流、也不是连接池。
- **规避**：登录接口已加「下发的 cookie 回读一次，读不到就重试一次登录」（`packages/api/src/features/auth/routes.ts`；探测用 `disableRefresh: true`，避免为探测多写一次会话）。排查同类抖动时用 `--no-file-parallelism` 与基线对比，不要凭一次全量结果认定回归。

## 测试：`RATE_LIMIT_DISABLED` 只在模块加载时求值

- **现象**：调试脚本里设了 `process.env.RATE_LIMIT_DISABLED = '1'`，登录仍然第 11 次开始返回 429。
- **原因**：`plugins/security.ts` 的 `limitsOff` 是模块顶层常量，在 `import` 时求值；ES module 的 import 会提升，写在 `import` 之后的赋值不生效。同时 `authRateLimit = preset(10)` 就是「第 11 次开始 429」的来源。
- **规避**：脚本里要在 import 之前设置该变量（或用 `NODE_ENV=test` 等外部环境传入）；直接用 `node --env-file` 或 shell 前缀，不要在模块内补设。vitest 已经在 `env` 里统一下发，测试本身不受影响。

## recharts 的 `strokeWidth` 不是图标违例

- **现象**：`overview.tsx` 里 `<Area strokeWidth={1.5}>` 看着违反「图标统一 1.75」。
- **原因**：那是图表描边宽度，与 lucide 图标无关；规则针对的是 lucide 组件。
- **规避**：契约检查只匹配从 `lucide-react` 导入的组件名；不要为此改图表数值。

## 不要把任务记录写进 `.claude/worktrees/`

- **现象**：写在 worktree 目录里的记录，任务收尾后无法追溯。
- **原因**：worktree 退出即删或按周期清理，且 `.claude/worktrees/` 被 gitignore。
- **规避**：任务记录写 `docs/tasks/<slug>.md`，踩坑写 `docs/PITFALLS.md`，都在 worktree 内创建并随分支提交。

## 运行：`pnpm up` 会更新依赖，不会启动项目

- **现象**：要求启动服务，却更新了 package.json、锁文件和本地依赖。
- **原因**：`up` 是 pnpm 内置 update 命令，优先于同名 package script。
- **规避**：启动脚本显式运行 `pnpm run up`；执行前看 scripts，不能仅凭名称猜命令。误更新时只恢复已确认由本次命令产生的改动。

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

## 数据库：单表 SELECT 的 SQL 子查询可能丢失外层列限定名

- **现象**：频道消息已写入 `seq=1`，相关子查询的 `maxSeq` 却为 0，合法 SSE 游标被误判为未来游标。
- **原因**：Drizzle 在单表 SELECT 投影里把 `${channels.id}` 生成成未限定表名的 `"id"`；放进 `channel_messages m` 子查询后，被 PostgreSQL 解析成内层 `m.id`。
- **规避**：已有频道 ID 入参时直接绑定参数，避免此处相关列引用；涉及嵌套 SQL 先检查 `.toSQL()` 并用真实非空数据验证，不只看类型检查或空列表测试。

## 数据库：Drizzle `sql` 模板里的 JS 数组会展开成多个占位符

- **现象**：`sql`${ids}::text[]`` 生成 `($2, $3)::text[]`，非空数组报 `cannot cast type record to text[]`，空数组直接语法错误；看起来像 SQL 写错。
- **原因**：Drizzle 的 `sql` 模板把数组当参数列表展开，不作为一个数组参数绑定。
- **规避**：需要单个 PostgreSQL 数组参数时用 `sql.param(array)`，例如 `${sql.param(ids)}::text[]`；空数组与非空数组都要有测试，不能只测其中一种。

## 数据库：迁移账本漂移或共享库已有列时不要手改账本

- **现象**：`pnpm db:migrate` 报列已存在（如 `agents.role`），或 `__drizzle_migrations` 里的时间戳在 journal 中找不到；共享库还可能停在上一号，后续迁移一条都没跑。
- **原因**：dev/共享库曾被另一条迁移历史建过，或列被手工 DDL、另一分支加过；journal 与库内账本不一致，列定义也可能与本分支 schema 不同（例如 `not null default ''` vs 可空）。
- **规避**：先按 `journal`、实际 `__drizzle_migrations` 与 `\d <table>` 逐条比对确认差异；个人项目不留历史数据，直接 `pnpm run down --clean && pnpm run up` 重建最干净，或确认无数据后按本分支 schema 重建。不要手写/删除迁移账本行来「对齐」，也不要把 `ADD COLUMN` 改成 `IF NOT EXISTS`，否则新库与旧库定义会分叉。

## 流程：用 main 的提交顺序覆盖了用户更晚的决定

- **现象**：合并 review 时按 main 里已有的实现反推哪条决定有效，忽略了用户之后明确的新决定。
- **原因**：把代码时间线当成决定时间线。
- **规避**：以任务记录「当前有效决定」和用户最新明确表态为准（`docs/DEV-WORKFLOW.md` §3）。

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

## UI 验证：类名和采样时序不能代替真实几何与性能

- **现象**：轮播有正确的 `basis` 类但卡面少12px；流式基准读到约1秒帧间隔，或未抓到中间态。
- **原因**：Carousel item 的内距计入 border-box；浏览器后台页会节流RAF；回放先启动、浏览器后导航会错过增量。空输入发送按钮本来就禁用，不能用“可发送”等待终态。
- **规避**：分别测item和卡面矩形、轨道gap；浏览器就绪后用信号触发回放，在固定前台记录明确的流式窗口，并记录空闲对照。终态用真实run状态/最终内容判定，不把探针超时直接归为产品失败。

## 测试：测试库隔离必须尊重注入地址，不能隐式改写或回落固定库

- **现象**：外层已注入临时数据库，但创建智能体仍500，取消测试静默跳过；或测试进程把连接串改成了历史固定库。
- **原因**：测试模块在 import 时捕获 `DATABASE_URL`、擅自改 `process.env`，或把地址重写回固定历史库；复用的旧迁移账本不含后来合入的表，迁移异常又被吞成 infra 不可用。
- **规避**：默认入口由 backend globalSetup 每轮创建随机库并迁移，经 `provide`/`inject` + `setupFiles` 在导入测试前写入 `process.env`；套件确需独立库时调用 `createIsolatedDatabase(prefix, adminUrl)`，显式使用返回的 `url`（不再隐式改 env），关闭连接后只删自己创建的库。建库/迁移失败必须抛错；只有 PG/Docker 不可用才发布不可连地址并跳过，不能回落开发库或共享 Redis。核验清理时只认本次函数返回的库名及唯一容器名/句柄：同一 worktree 可能有并行代理在跑测试，不要按 `backend_test_*` 前缀或镜像名批量删库/删容器。

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

- **现象**：`pnpm openui:check` 11 项全绿、组件覆盖测试 38 项全绿，实际仍有日期早存一天、复选默认项不进载荷、表格流式补行后仍 0 行、日期弹层点击打不开。
- **原因**：覆盖测试断言的是「渲染出非空内容」；可交互组件被写进 `NESTED_ONLY` 并注释「由父组件用例覆盖」，而豁免只是一个名字，没有任何交互断言。`openui:check` 只比对 schema/spec，不进入 DOM 交互。
- **规避**：改动 OpenUI 组件后跑 `pnpm openui:audit`，看 behavior / render / nested（可交互但尚未登记证据）/ missing 四类数字；缺口按同一范围比较不应上升，新增组件或能力可以登记新缺口并写明，不算回归；审计只读登记表，不解析断言也不计算覆盖率。每个新发现的 bug 先落一条会失败的行为用例再修；不要靠往豁免清单加名字让测试变绿。

## 附件：目录权限与相对路径会让沙盒读不到文件

- **现象**：`pnpm dev` 上传成功，但模型读取 `/mnt/inputs` 失败；或 Linux 宿主以非 1000 UID 运行时同样读不到。
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
- **规避**：新增或删除路由后跑一次 `pnpm --filter @agentport/web build`（或 dev），让生成文件更新并随改动提交；不要手工编辑生成文件。

## 数据库：新增运行触发值要同步扩展 CHECK 约束

- **现象**：插入 `agent_runs.trigger='review'` 时报 CHECK 约束失败，代码与 schema 看似一致。
- **原因**：`trigger` 是 text + CHECK 约束（`chat/mcp/schedule/event/review`），不是 PostgreSQL enum；改 Drizzle schema 不会自动改已有约束。
- **规避**：新增触发值时先 `pnpm db:generate` 生成扩展 CHECK 的迁移，再 `pnpm db:migrate`；不要假设 text 列会接受新值。

## 测试：真实容器测试可能加载旧 dist，产物存在不等于来自当前源码

- **现象**：真实 Docker / SDK 测试全绿，实际行为却对应旧代码；镜像或挂载里是旧的 `shared`/`sandbox` 构建。新建 worktree 首次跑 Vitest 还可能在业务用例前报 `TypeError: code.charCodeAt is not a function`。
- **原因**：测试只检测 `dist` 是否存在，或复用镜像中旧的 `shared` 产物，没有确认产物来自本轮源码；根 `vitest` 入口只跑测试，不等于执行构建。新 worktree 不带 workspace `dist` 时，Vite 会把模块解析/构建异常重写成 `charCodeAt` 堆栈，看起来像业务代码报错（本次实测缺 `packages/db/dist`）。
- **规避**：每轮为 `shared`/`sandbox` 编译独占临时产物或显式构建最新版本，并记录产物来源；验收跑真实 Docker 与 SDK fake API；不要把根 `vitest` 入口当作构建步骤。新树先 `pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db build` 再跑 backend 测试；遇到 `charCodeAt` 先查缺哪个 workspace `dist`，不要改业务代码。后端测试由 globalSetup 在随机 PostgreSQL 库和临时 Redis 上运行，不手动迁开发库、不回落共享库。

## 实现：被工作区与产出共用的目录刷新不能无条件保留记忆挂载根

- **现象**：接入子智能体记忆后，产出目录里合法的 `.claude/agent-memory` 首次复制就丢文件、红测试报 `ENOENT`；切换草稿版本时目标还留着上一版内容。
- **原因**：`refreshSessionDirectory`（`packages/worker/src/session-workspace.ts`）同时服务定义工作区与产出目录，却无条件跳过 `.claude/agent-memory` 以保住工作区的挂载根 inode；产出目录没有挂载根，同名目录只是普通用户文件，被当挂载根跳过就不再复制或删除。
- **规避**：保留挂载根改为显式选项 `preserveMemoryMount`，只在定义工作区调用时传 `true`（`packages/worker/src/index.ts`），产出保持整棵替换；新增刷新调用前先确认目标是否真有挂载根，不按目录名猜语义。

## 测试：生产 ESM/CJS 互操作不能用 Vitest 结果代替

- **现象**：ExcelJS 等 CJS 依赖在 Vitest 里导入全绿，构建后的 API 以原生 ESM 启动却报具名导出缺失。
- **原因**：Vitest/Vite 会做 CJS 互操作与转译，掩盖打包后 Node 原生 ESM 对具名导出的限制；测试环境通过不代表 `dist` 可加载。
- **规避**：用真实 Node 导入构建产物（如 `node --input-type=module -e "await import('./packages/api/dist/...')"`）或直接启动构建后的服务；不把 Vitest 绿色当作 ESM 兼容证据，也不用 mock 替换该检查。

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

- **现象**：drizzle-kit 生成迁移后，新库执行报 PostgreSQL `multiple primary keys for table ... are not allowed`；在 Vitest globalSetup 里可能只看到 `TypeError: code.charCodeAt is not a function`，看不出是迁移失败。
- **原因**：交互式生成时把改名默认当成「新增列 + 新主键」，会生成 `ADD PRIMARY KEY`，而旧主键还在；真实错误又被 Vite 的 globalSetup 包装改写成 `charCodeAt` 堆栈（另见「真实容器测试可能加载旧 dist」一条）。
- **规避**：生成时明确把该列选为 rename，保留 `RENAME COLUMN`，并在同一迁移里删除原列上指向 auth `user` 的外键，不要接受默认的 add 方案。验证时绕过 Vite，直接用 `pnpm --filter @agentport/api exec tsx` 调用 `createIsolatedDatabase` 建全新随机库并迁移，拿到真实 Pg 错误；不要在共享库上试。

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

## 测试：依赖安装与 vitest 运行并发会让新 worker 丢掉旧 peer 路径

- **现象**：长测试跑着时执行 `pnpm install`/升级依赖，已启动的 worker 多数正常，但新 fork 的 worker 报模块找不到，路径指向已被替换的 `.pnpm` 目录；单独重跑整套又全绿。
- **原因**：pnpm 安装会重排 `node_modules/.pnpm` 的虚拟 store 并更新顶层链接；已加载模块的进程不受影响，新 worker 按新解析结果启动，旧 peer 路径已不存在，失败被误当成代码回归。
- **规避**：测试运行期间不安装/升级依赖；先停掉测试进程，等 `pnpm install` 完成后再从干净状态重跑。出现这类「路径不存在」先核对是否刚装过依赖，不要改业务代码或删测试。

## SSE：`subscribeRun` 回放完才 resolve，await 之后启动的定时器保护不了长回放

- **现象**：成员打开 run 事件流后、Redis 回放尚未结束时被移出频道，已撤权的连接仍把回放中的历史 token 送给对方，直到回放结束才停。
- **原因**：`subscribeRun` 在首次回放全部完成后才 resolve；调用方在 `await subscribeRun(...)` 之后才启动撤权/终态复核定时器，回放期间的逐事件回调不经过该定时器，而逐页回放可能持续很久。
- **规避**：撤权核验必须放在回放回调内逐事件执行（每次重新查成员/run），不能只依赖 await 之后的定时器；需要周期核验时用独立授权计时或在回放循环里检查。测试把撤权卡在回放第一页之后，断言剩余 token 一条都不外发。

## 迁移台账与仓库 journal 不一致，所有登录 500

- **现象**：任意 worktree 的 API 登录都返回 500，日志是 `relation "platform_bootstrap" does not exist`；`drizzle.__drizzle_migrations` 有几十条旧记录，但最大 `created_at` 早于当前 journal 的 0043。
- **原因**：多个 worktree/分支各自生成过迁移，共享库被另一套 journal 迁移过，台账与仓库 journal 的时间戳/内容对不上。drizzle migrator 只按「journal.when > 台账最大 created_at」判断待执行，于是重跑已存在的迁移，在第一个 `CREATE TABLE` 就失败并整批回滚。
- **规避**：先 `pg_dump -Fc` 备份；只读核验实际结构与 journal，确定真实基线；对已存在的对象按核验结果登记台账（hash 用迁移 SQL 的 sha256），对新增的 NOT NULL 列先建可空列、回填后再 `SET NOT NULL`；在 dump 恢复出的副本库完整演练后再作用于共享库。不要直接 `pnpm db:migrate` 硬跑，也不要为了跑通而删除业务数据。
