# 踩坑记录

> 跨任务反复出现的坑统一记在这里，由 `CLAUDE.md` 指向。主会话与执行子代理动手前先读，落实相关规避方式；任务范围变化或报错时重新核对，不只在踩坑后追加。
> 不限定类别：遇到值得留存、能避免以后重复犯错的教训就及时整理，运行、实现、沟通、测试只是例子。每条固定「现象 → 原因 → 规避」，不把任务流水账和已有操作说明复制进来。

## 运行：宿主直跑 worker 时模型网关地址不能被改写成 host.docker.internal

- **现象**：`pnpm dev` 下真实对话全部失败，worker 日志反复出现 `model proxy request failed: other side closed`，但直接请求网关正常。
- **原因**：模型代理无条件把上游 loopback 改写成 `host.docker.internal`；该别名只在容器内可解析，宿主进程访问同一网关会失败。
- **规避**：只有 worker 自身在容器内时才改写（`packages/worker/src/upstream.ts`，用 `/.dockerenv` 判定）；沙盒侧地址仍必须改写。改到这里时不要把它和沙盒的 `toHostUrl` 混用。

## 复制到 worktree 的 `.env` 可能比刚确认的配置旧

- **现象**：新 worktree 起了服务，但用户刚确认的管理员密码失效；或 `.env` 缺 `APP_SECRET_KEY` / `ANTHROPIC_API_KEY` 起不来，装好依赖后前端也可能无法解析 `@agentport/shared`。
- **原因**：`.env` 不受 Git 管理；`.worktreeinclude` 只在建树时复制一次，来源是发起建树的那棵树（可能是旧 worktree），结果不代表最新。主 checkout 的 `.env` 也可能是旧残留。worktree 还不带 `node_modules` 与 workspace `dist`。各树共用数据库，API 首次登录时 `ensureAdmin` 会按当时的 `ADMIN_PASSWORD` 重播管理员，旧配置一登录就把用户刚设的密码覆盖掉。
- **规避**：配置默认取主 checkout `.env` 的绝对路径，启动前核对 `ADMIN_USER`/`ADMIN_PASSWORD`/`ALLOW_WEAK_ADMIN_PASSWORD` 等改动过的关键项；用户最新明确决定优先于磁盘上的值，不以「来自 main 的 `.env`」当成用户决定。登录验证使用用户确认的配置，不拿测试或调试任务改掉用户登录态。然后 `pnpm install --frozen-lockfile`，前端预览前构建 shared/core。新增必填 env 文件时同步加进 `.worktreeinclude`（仅作初始化副本，仍不保证最新）。规则集中在 `docs/DEV-WORKFLOW.md`「配置与启动」。

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

- **现象**：模型 profile 保存成功、编辑表单消失，外层弹窗的关闭、新增和编辑仍永久禁用。
- **原因**：外层通过子表单 effect 接收 pending；成功回调先卸载子表单，随后子表单的 `setSaving(false)` 无法再触发回报，外层保留最后的 true。
- **规避**：拥有弹窗生命周期的外层在成功回调中明确结算 pending/dirty，再卸载子表单；行为测试必须覆盖保存成功后关闭、继续新建和路由离开，不只断言请求完成。

## UI：URL 成为状态唯一来源后，导航 mock 必须反映 search 更新

- **现象**：完整文件页签实际可用，按需加载测试却始终不请求；评估结果已改 URL 选择，旧测试仍调用不存在的 `renderExpanded`。
- **原因**：测试将 `useSearch` 固定为空、`useNavigate` 固定为无行为函数，仍以旧的本地状态/行内展开假设断言。
- **规避**：涉及 URL 导航、历史、blocker 时优先真实 Router 与实际 `validateSearch`；保留原用户行为断言，不能只替换成函数是否被调用，也不能删除失败断言凑绿。

## 测试：真实容器测试可能加载旧 dist，产物存在不等于来自当前源码

- **现象**：真实 Docker / SDK 测试全绿，实际行为却对应旧代码；镜像或挂载里是旧的 `shared`/`sandbox` 构建。新建 worktree 首次跑 Vitest 还可能在业务用例前报 `TypeError: code.charCodeAt is not a function`。
- **原因**：测试只检测 `dist` 是否存在，或复用镜像中旧的 `shared` 产物，没有确认产物来自本轮源码；根 `vitest` 入口只跑测试，不等于执行构建。新 worktree 不带 workspace `dist` 时，Vite 会把模块解析/构建异常重写成 `charCodeAt` 堆栈，看起来像业务代码报错（本次实测缺 `packages/db/dist`）。
- **规避**：每轮为 `shared`/`sandbox` 编译独占临时产物或显式构建最新版本，并记录产物来源；验收跑真实 Docker 与 SDK fake API；不要把根 `vitest` 入口当作构建步骤。新树先 `pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db build` 再跑 backend 测试；遇到 `charCodeAt` 先查缺哪个 workspace `dist`，不要改业务代码。后端测试由 globalSetup 在随机 PostgreSQL 库和临时 Redis 上运行，不手动迁开发库、不回落共享库。
