# 运行完整性与技术栈简化

## 目标

用户授权处理审查报告全部 12 项以及末尾 4 个较小项，按现有→原生能力优先落地，不新增大型框架。不提交、推送、合并。

## 方案

基于最新 origin/main 复核，已修项记录证据；Opus 固定契约，Sonnet 按文件域并行执行，Opus 独立评审；用行为回归测试与独立基础设施验证，保留 OpenUI、插件和知识库新能力。

## 基线与范围

- 工作树：`.claude/worktrees/simplify-runtime-and-stack`，分支 `worktree-simplify-runtime-and-stack`。
- 审查基线：797edfeaabd39b040d01736c49273da18347ea92；新建树初始为 633e837，fetch 后快进到 origin/main efcf71c。
- 初始工作区干净，无他人未提交差异。主 checkout 不改动。
- 当前主线新增 OpenUI、插件、知识库；本任务仅处理已列问题及受影响调用，不扩大重构。

## 当前有效决定

- 用户最新明确约束：Claude Agent SDK 是核心产品底座；所有简化与性能改动必须保留原有 SDK 业务功能，并以官方 SDK 能力、文件约定与行为为依据。不得以代码量或性能替代核心功能，不另造执行循环或会话/插件/记忆语义。此前通过的通用测试不等于核心 SDK 的真实业务端到端验收。
- 2026-10-26：用户明确授权全部列出问题，采用推荐最佳实践。
- 不新增运行时依赖；不重置用户数据库、卷或配置；验证使用独立实例，不停共享服务。
- 用户最新明确授权提交、创建PR并合并；按项目规则不触发CI、不等待CI、不启动PR监控。合入最新origin/main时保留后来已合入功能，对冲突做针对性复核。

## 已替代项及原因

旧报告的文件行号与缺陷先在新基线复核，已修复行为不重复修改。

## 步骤

- [x] Opus 复核并固定并行文件边界和跨层契约
- [x] 1 事件展示与持久化额度分离（超限不可重试失败、真实outcome串联4×7MB落库，最终Opus通过）
- [x] 2 ZIP 预检与解码一致（第三轮Opus复核通过，低报deflate/编码/完整伪EOCD均修复）
- [x] 3 容器停止语义归一（原生stop、迟建等待、失败保留跟踪与warning，Opus限定复核通过）
- [x] 4 MCP/chat 事务准入统一（Opus独立评审通过）
- [x] 5 预览、导出与运行绑定一致（API独立评审通过，worker复用与排序契约已独立核实）
- [x] 6 Node pipeline 代理及断连取消（真实HTTP背压/断连测试，独立Opus评审通过）
- [x] 7 Redis 有界批量回放与发布（API内存预算二轮复核通过；worker pipeline错误及顺序已独立核实）
- [x] 8 RHF 局部订阅、按需预览（独立Opus评审通过，跨区保存浏览器复验通过）
- [x] 9 当前主线已删除 MARKDOWN_HINT，统一 Streamdown 且显式静态/流式模式（markdown.tsx:372）；保留并在整体验证复跑现有用例
- [x] 10 pnpm deploy 沙盒构建整合（clean snapshot与整合双镜像构建通过，shared白名单独立复核通过）
- [x] 11 评估摘要投影与游标分页完整迁移（两复合索引、单重试恢复、Opus复核通过）
- [x] 12 构建上下文排除无关目录
- [x] 13 审计防抖复用（独立Opus评审通过，浏览器条件一致）
- [x] 14 会话恢复 Query 缓存（client.query与AbortSignal补齐，独立复核通过）
- [x] 15 outputStyle 原生加载（独立CLI初始化实测与Opus复核通过，无模型请求）
- [x] 16 Compose 原生等待（独立Opus真实四场景实验通过）
- [x] 独立 Opus 评审与修复复核（所有域明确通过，最后Bearer/串联真实落库第四轮限定通过）
- [x] 相关 typecheck/test/build 与真实验证（最终245文件2118测试全部通过，0跳过；真实浏览器/镜像/迁移/执行计划验证）

## 追加 code-review（已纳入用户原授权）

- [x] 1 清理失败不改业务结果/重试分类，独立Opus22测试通过，真实消息/session落库保持
- [x] 2 误报：真实QueryClient页面回归60条两页→头插1条→invalidate后游标011变012，61条无漏重；官方文档/本地实现均顺序重算cursor，生产逻辑不改
- [x] 3 provider原生pull/create/start所有权与确定rm删除已Opus通过；probe/native closing同步abort/及时结束/拒绝分类二轮限定复核通过
- [x] 4 三侧复用core unionById按ID去重排序，父B子A真实反序回归通过；独立Opus21测试明确通过，停用子与脱敏有意差异保持
- [x] 6 删除无用node:fs mock；7修正probe旧SIGKILL说明（追加独立环境runner/probe29测试通过）
- [x] 5 destroyAll聚合失败上抛保留id，主shutdown经runShutdown汇总各资源错误、继续收尾并非零退出；独立Opus7测试通过
- [x] 追加范围独立Opus复核、受影响验证、完整回归（246文件2155通过；最后测试锁双进程与异常释放补验通过）

追加验证实例：`pace-review-fixes-pg`（127.0.0.1:59801，库pace_review_verify）、`pace-review-fixes-redis`（127.0.0.1:59804），迁移通过；不使用之前已清理的64790/64792。

追加Opus契约：清理告警保留但不改业务outcome/重试；cold image先可取消pull，再create --pull=never，创建请求已发则等结束并在取消时只删不start，删除appearance猜测；destroyAll聚合失败并由shutdown继续关闭其他资源且非零退出。signal接线已完成（Effect.tryPromise显式signal传provider，cancel/30s timeout/Fiber中断abort、正常完成不abort，17测试通过），正在整体生命周期独立复核。fs/promises会话存在mock仍保留，仅删无人用的node:fs/readFileSync mock。

## 共享契约与并行边界

- 运行时：runner-client/docker/provider/probe 与 sandbox runner，保留 OpenUI block、完整文本、工具与 session 元数据；delta不占持久化额度，真正持久化超限明确失败。worker发布 pipeline 由该执行域负责，API端由Redis域负责。
- ZIP：只改agent-package-zip及专项测试，不与工作区组装域交叉。
- 工作区/准入：API workspace/agent-package/invoker，db chat/agents仓储；保留plugins/knowledge/OpenUI绑定，复用admitChatRun事务。
- 前端：agents表单域独占页面；runQuery/审计防抖域仅改queries运行段；评估域仅改queries评估段，格式化汇总阶段统一执行。
- 评估分页：`GET /api/eval/runs?agentId=&cursor=&limit=`，默认50最大100；`{items,nextCursor}`，游标末条ID，在SQL按(created_at,id)倒序排他比较；非法/跨筛选游标INVALID_INPUT。SQL只取摘要列，详情/执行保留完整数据。shared/API/db/web与mock调用全部迁移。
- 构建域：Docker/pnpm/up/compose/CI；保留git/SDK optional原生依赖、非root和知识库服务。文档主会话在代码稳定后同步。

## 改动文件

- 运行：worker runner-client/model-proxy/sandbox provider/probe、server-bindings与sandbox runner及回归。
- 后端：ZIP编解码、workspace/agent-package绑定、MCP invoker、Redis producer、eval路由与仓储、chat/agents仓储。
- 共享与数据库：评估分页schema、shared打包files、eval_runs索引与0037生成迁移/meta。
- 前端：agents/audit/eval页面、run缓存/取消请求/共享防抖，以及对应生命周期与分页测试。
- 构建：根Dockerfile、compose healthcheck、up/CI/release与ignore；删除5份sandbox旧构建文件。
- 文档：README、ARCHITECTURE、OPERATIONS、RUNBOOK、PITFALLS、本任务记录。
- `.vitest/json/output.json`是测试工具自动更新的已跟踪报告，收尾前只恢复本任务生成差异，不交付噪声。

## 下一步

PR最终provider等待补丁独立Opus复核通过，最新origin/main f2eee7d冲突整合通过；完整251文件2187测试与最后13专项、build/typecheck/contract通过。正在完成merge提交、推送、创建PR并按用户授权合并；不触发/等待CI，不部署。SDK真实模型完整E2E缺口与保存超限状态规则已写PR。主线独立测试库已替换本任务advisory lock方案，不并存两套。

## 验证

- `pnpm install --frozen-lockfile`：通过，依赖按锁定版本安装。
- `pnpm -r build`：基线构建通过。
- 独立验证容器 `pace-stack-fixes-pg`（pgvector/pgvector:pg18，127.0.0.1:64790）与 `pace-stack-fixes-redis`（redis:8-alpine，127.0.0.1:64792）；只用于本任务，未修改共享服务。
- 显式注入独立 DATABASE_URL/REDIS_URL 执行 `pnpm db:migrate`：通过。
- 已安装 SDK 0.3.310 / BullMQ 6.4.2 与锁定版本一致。
- 隔离预览：代码根为本工作树，commit efcf71c，配置由未跟踪 `.tmp/verify-app.mjs` 显式注入，浏览器专用库 `pace_stack_browser` 与自动测试库分离，共用本任务独立Redis；URL `http://localhost:34871`。真实浏览器提交登录并进入工作台成功，未改用户既有账号或服务。
- Markdown现有行为回归：`pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/markdown.test.ts packages/web/test/markdown-static.test.ts packages/web/test/openui-content-markdown.test.ts`，3文件21测试通过；RTK未解析摘要但JSON报告success=true，失败0。
- 模型代理专项：2项新测试先红后绿，联同upstream共5通过；独立Opus复核通过，并实测响应头前断连、429/503透传及上游中断。
- ZIP专项初版7项新格式回归先红后绿，原目录包31通过、插件/知识库相关71通过。独立Opus复审未通过：deflate定长输出低报静默截断、文件名bit11解码差异、合法注释中的EOCD伪签名均有小样本复现，已派发修复；未将初版视为完成。
- 跨域保留回归：workspace-input/plugin-render/OpenUI persistence/run-server-scope，4文件25测试通过。
- `pnpm lint:focus`：通过。
- 浏览器表单回归：身份改名→行为改提示词→展开预览，预览显示两个最新草稿字段，跨分区字段保留；初次保存API回读正确但页面仍“未保存”。修复后重新构建并按同路径真实复验：name=保存状态已复验、dirty=false、已保存按钮存在，通过。
- `pnpm -r typecheck`：评估迁移中间态首次失败（summary无claimedAt），迁移同步后第二次7包全部通过；后续源变化仍按范围重验。
- 评估浏览器验收：专用库插入55条终态记录，真实页面首屏到050并显示“加载更多”，点击后追加051–055并显示“已到末尾”；无需真实模型或worker。
- `pnpm -r build`：整合构建通过（各域部分复审修复仍在进行，完成后按变化面重验）。
- 独立实例整合 `pnpm test --reporter=default` 首轮：244文件，2101通过/1失败/1跳过；唯一失败是正在修复的跨分区保存后“未保存”回归。跳过为eval入队套件queueIdle前置（并行测试存在消费者），后续独立复跑该文件，不能记全套通过。
- 跳过的eval入队文件已独立复跑：4/4通过，0跳过。
- 真实评估页面最终计数55条、55个唯一ID、1个h1，无重复；审计输入agent后只有1次筛选请求，URL与2条结果一致。
- 评审发现并修复中：Redis16条批次基于字段大小而非8MiB行预算，改2条并补转义payload回归；shared deploy额外携带src/test，补files白名单；ZIP完整22字节伪EOCD注释继续复现，补候选结构识别。
- 第11复审未通过：next-page错误双重提示、缺分页排序复合索引。已扩展范围到eval_runs索引与自动生成迁移，只在任务独立库迁移；保留主schema既有其他实体。验证要求真实PG EXPLAIN合成数据事务回滚、DOM单错误入口保留旧行并重试原cursor。
- 前端整合专项agents/chat/audit/eval：4文件40通过，仍有测试act警告待汇总说明。
- 最终整合沙盒镜像：`docker build --target sandbox -t pace/sandbox:stack-fixes-20261026 .`通过；`--read-only`+uid1000+config tmpfs真实运行，shared依赖目录仅dist/package.json，SDK native musl CLI可执行并输出2.1.310。API/worker runtime整合镜像构建中。
- 第二轮完整整合回归：245文件，2106通过、0失败、2跳过（agent-invoker-admission队列前置）。随后单独复跑该文件2/2通过、0跳过；测试仍有既有SIGTERM listener警告。评估索引/错误恢复与运行域复审后按变化面重验。
- API/worker整合镜像 `pace/api:stack-fixes-20261026`构建通过，uid1000，API/worker/web/迁移路径与知识库依赖可解析。
- 最终迁移0037已重新生成升序索引（`0037_chubby_baron_zemo.sql`）；在新建 `pace_stack_final` 从零应用全部迁移通过，核对PG实际为(agent_id,created_at,id)/(created_at,id)，并复跑分页+绑定4文件10测试通过。此前browser库曾应用被替换的0037，只作一次性浏览器样本库，将随任务容器清理，不作为迁移成功证据。
- `pnpm -r build`最终评估索引/错误恢复整合版本通过；typecheck/focus/contract均通过。
- 最终Web全量：65文件681测试通过；新eval分页测试act警告已清除，仍有既有agents-ui Probe act及图表jsdom零尺寸警告，不屏蔽输出。
- 新库ZIP/stream/proxy/bindings联合：5文件57测试通过。
- 运行域复审未过3项：真实持久化超限仍success、docker rm失败被忽略且跟踪提前删除、late probe cleanup吞错，已派最小修复与失败回归；outputStyle/额度内OpenUI/session/正常pipeline顺序已评审通过不重扫。
- 运行补充修复：count/bytes超限明确不可重试失败，rm失败上抛并保留跟踪，late probe warning上下文齐全；四文件23测试通过，Biome通过，第二轮Opus限定复核中。
- 最后运行补丁的`pnpm -r build`、focus、contract通过；最终新库全套及两镜像重建正在进行。
- 最后新库全套：245文件2111通过、1失败、0跳过；失败为新增Redis MONITOR实时回放测试的ioredis command queue state error（非业务断言），已派发监控连接生命周期修复，不能记全套通过。
- 最终运行补丁两类镜像重建通过；正在复验CLI/入口。
- `pnpm db:generate`复核：No schema changes；`pnpm install --frozen-lockfile --offline`通过，pnpm-lock无差异，未新增/升级依赖。
- 新增eval分页测试两用例verbose复跑通过且无act警告。
- 运行二轮复审：超限终态count/non-success与latewarning通过；仍有creating+stop missing绕过等待，以及7MB连续文本经redactSecrets正则栈溢出导致真实落库0条。范围扩展到worker/redact.ts最小regex修复与真实持久化回归，不移除脱敏；已派发，未将运行域记完成。
- 最后运行二轮补充：creating stop missing进入等待、脱敏量词改+后按原阈值判断；5文件46测试通过，含4条7MB真实PG落库读回，原凭证脱敏规则保留。Opus第三轮限定复核中。
- 最后运行代码构建/focus/contract通过，runtime镜像因worker源变化重建中；sandbox源无变化不重复构建。
- Redis计数测试改为Vitest call-through spy记录真实客户端xrevrange/xread参数，仍连接真实Redis并验证内容/顺序/8MiB边界；删除MONITOR连接与临时手写RESP parser，9/9与Biome通过。完整回归重跑中。
- 最终runtime镜像重建与入口复验通过，最后worker源包含迟建清理与长文本脱敏修复。
- 最终完整回归（移除MONITOR竞态及最后运行修复后）：`DATABASE_URL=.../pace_stack_final REDIS_URL=...:64792 pnpm test --reporter=default`，245文件2115测试全部通过，0失败0跳过；仍有既有agents-ui act、jsdom图表零尺寸和SIGTERM listeners警告，不屏蔽，不作为无警告宣称。
- 最终7包typecheck、focus/contract、26个生产源Biome、compose config、up.sh语法与git diff --check通过。
- 运行三轮：Docker迟建missing通过、长文本与阈值对照通过，但重复Bearer前缀存在短匹配消耗回归（Bearer Bearer abcdefgh未遮盖），已派有界lookahead+贪婪段最小修复，并补超限outcome.events直入真实持久化串联回归。
- 最后Bearer短重叠修复使用固定8字符lookahead再贪婪+，重复前缀、7/8阈值和7MB脱敏回归通过；redact/limits/message-persistence三文件30测试通过。串联真实outcome.events持久化新增测试正在验证，最终限定Opus复核中。
- 最终交付验证：最后Bearer补丁+串联PG持久化后全量 `pnpm test --reporter=default`，245文件2118测试通过，0失败0跳过；最终worker构建/runtime镜像重建通过，两镜像uid1000只读运行入口与SDK CLI 2.1.310复验通过。运行最终限定Opus明确通过，真实outcome.events直接保存4条各7MB并保留session。
- 清理：浏览器space与本任务预览进程已关闭；`docker rm -fv pace-stack-fixes-pg pace-stack-fixes-redis`清理自建容器/匿名卷；仅移除`pace/*:stack-fixes-20261026`验证镜像，用户dev镜像与共享服务未动；已跟踪Vitest报告恢复到任务基线。
- 限制：未调用付费模型、未跑完整产品E2E；仅针对变更页面真实浏览器和Docker/PG/Redis链路验收。保留既有慢SSE观众被MAXLEN裁剪的限制、合成终态事件不受runner单行预算限制及既有测试环境警告。
- 追加验证：完整回归245文件2136测试通过，0失败0跳过；7包build/typecheck、focus/contract、追加生产源Biome、git diff --check通过。
- 追加runtime镜像pace/api:review-fixes-20261026构建通过，uid1000，API/worker/web入口检查通过。未覆盖dev镜像。
- 新无限分页测试保留为防回归，反馈2判误报而非绕过修复；node:fs/readFileSync失效mock删除但fs/promises会话存在mock保留。
- 当前唯一待确认域为cold pull/create/start、probe/native per-task取消与shutdown错误传播的独立Opus评审；未提前宣称追加全部完成。
- 生命周期追加首轮Opus复审：create 30s杀CLI丢所有权、stop0仍created（真实Docker29.8）、worker/eval close拒绝退出0、pool拒绝跳过统一错误，4项未过。修复中：已发create不设provider杀CLI deadline，任务预算只abort后等待完成清理；stop后执行rm确认删除；关停复杂流程抽出runShutdown供真实行为测试，所有资源拒绝计入日志/退出状态；probe/native每task超时signal补齐。
- 追加末轮全套出现reconcile-queue-redis两失败（waiting/delayed被判failed，单独复现），该生产模块本任务未改；已派定位真实Redis job状态/候选探测根因，不放宽断言、不盲改业务。最终不得用此前全绿覆盖此次失败。
- provider追加二轮复核通过：create无本层杀CLI超时，pending持有到真实创建收尾；stop后总rm确认删除；19测试及真实Docker29.8未启动容器实验通过。
- shutdown追加二轮复核通过：7测试证明worker/eval/pool/provider拒绝都日志并继续收尾、返回1，原并行/顺序/两轮有界等待保留。
- probe/native追加复核发现closing同时create拒绝误报启动失败、已启动probe继续等超时，两case正在按现有done+reason同步abort修复，未记通过。
- probe/native closing竞赛修复完成：onClosing先记reason同步abort再done，catch按closing归类；已启动probe及时结束，已aborted入口也准确取消。4新增先红后绿，25测试通过，最后build/typecheck/Biome/focus/contract通过；独立限定复核中。
- 最终独占库/Redis并行全套：2144通过，chat-admission前置queueIdle检测到同时阻塞读取导致suite失败/11跳过；reconcile此次通过。单独chat-admission+reconcile联合15/15通过，生产reconcile无diff。正在最终 --no-file-parallelism运行，避免已知测试消费者前置互扰（仅执行方式，不改产品/断言）。
- reconcile诊断确定：同库两进程跑测试但各用私有queue，全表候选扫描会互相将waiting/delayed判missing，精确复现publish1变3与queued变failed。仅测试增加session advisory lock串行同文件同库，双进程修复后各4/4通过；生产reconcile无diff。独立Opus小范围复核中。
- 最终runtime镜像已包含shutdown helper与closing分类补丁，构建通过；只读uid1000入口验证通过。最终typecheck/focus/contract/Biome/diff检查通过；schema/lock不新增变化。
- 最终追加串行完整验证：`DATABASE_URL=.../pace_review_final REDIS_URL=...:61963 pnpm test --reporter=default --no-file-parallelism`，246文件2155测试通过，0失败0跳过；最后typecheck/focus/contract/diff检查通过。并行测试共享消费者前置的限制已如实记录，不把此前失败隐去。
- 测试锁最后复核原代理因502/DNS错误中断，但提供确定复现：默认15s statement_timeout小于单文件约21s，等待者超时57014；afterAll清理失败可能漏释放，已派专用连接超时与finally销毁最小修复。仅测试文件，无生产改动，修后需要独立复核。
- 测试锁补丁已落盘：专用lockClient session SET statement_timeout=0，acquire异常销毁连接并关闭pool，afterAll清理置于try/finally确保release(true)+pool.end；业务pool配置不变。Biome/worker typecheck/diff检查通过，双进程实测与最终限定Opus复核进行中。
- 测试锁最后限定Opus静态复核明确通过：专用连接SET timeout=0不影响业务pool，acquire catch与afterAll finally release(true)断开释放锁，ready=false惰性pool无额外连接；生产reconcile无diff。双进程真实等待与独立最终库对账回归仍在执行，等待结果后清理资源。
- 最后测试锁补丁独立最终库复验：reconcile-queue-redis 4/4通过（约20.72秒，离线Redis20秒行为完整），worker typecheck/Biome/diff检查通过。先前最终完整串行全套246文件2155通过在生产代码最后版本，测试锁文件之后定向补验；不重复无关全量测试。
- 最后锁补丁验证：RED等待15007ms报57014；GREEN同库双进程各4通过，耗时20.73/40.85秒，等待者确实等待超过15秒后完成；注入afterAll清理失败后advisory锁仍0。ready=false 569ms内跳过结束无悬空连接。独立最终库4/4、worker typecheck/Biome/diff检查通过，Opus限定复核通过。
- 最终清理：追加3个自建容器与PG匿名卷已用`docker rm -fv`移除，只移除pace/api:review-fixes-20261026任务镜像；已跟踪Vitest报告恢复，用户dev镜像、共享服务和数据未动。
- 用户澄清后的核心SDK复验：runner/memory-permissions/sub-agent-permissions/sdk-skills四文件48通过；真实query control初始化skill-discovery/plugin-discovery两文件4通过、0跳过（无模型请求），官方CLI实际发现技能、插件命名空间与子定义。shared任务协议、messages持久化源码、SDK版本与依赖锁均未替换。输出风格删除平台重复解析，继续由project官方文件加载。
- 核心SDK验收边界：未在本轮做真实模型完整对话/续聊/分支/MCP/子智能体/记忆跨轮端到端；平台保存超限会将SDK成功标成平台失败，是明确平台规则而非SDK执行结果，不能混称。
- 发布合并阶段执行代理越界：对账冲突代理未用任务专用数据库，执行了共享compose Postgres重建为pgvector。主会话发现后立即停止共享变更并核查`http://localhost:3000/health/ready`返回db/redis ok，容器健康。该操作不作为授权或本任务验证证据；后续显式只用pace-pr-final-pg/redis（55273/55274）。不得隐瞒影响或继续重启共享服务。
- PR合并主线f2eee7d：5文件冲突已解决，前端保留局部订阅/懒预览/dirty reset并通过主线+任务22专项及web694全量；运行保留pipeline并整合主线waitClose/knowledge关停，删除重复内联close框架；reconcile测试采用主线随机独立库，删除本任务锁机制（同一问题原生项目已有更优实现）。
- PR合并版本build/typecheck/focus/contract通过，关键关停/proxy/SDK runner36测试通过，runtime镜像pace/api:pr-merge-verify构建及只读uid1000入口通过；完整回归与Opus合并限定复核中。
- PR运行合并复核唯一阻塞：provider.destroyAll被5s waitClose截断，pending create尚未收尾时会exit0；恢复直接await attempt(provider)，其他资源仍并行有界，补provider迟到完成不得提前退出回归。前端合并独立复核通过（22+59专项）。
- PR最终完整串行回归：251文件2187测试通过，0失败0跳过；最后provider等待补丁9 shutdown/3 close-wait/1 reconcile-shutdown共13专项通过，相关proxy合计16通过。最新主线merge冲突已清、build/typecheck/focus/contract与有效差异格式通过；最后provider限定Opus复核中。
- 后续重复验证应创建新的独立Postgres/Redis实例并注入地址；早期/追加验证实例已清理，PR合并阶段独立实例55273/55274收尾再清理。最终全套有既有act/jsdom尺寸/listeners警告，不声称零警告；未付费模型、未完整产品E2E。
