# 能力差距与补齐计划

> 只读历史：本文件记录历史循环的产出，非待办来源；未完成项以 [REMAINING-TODOS.md](REMAINING-TODOS.md) 为准。
> 本文件由「探索 → 差距 → 补齐 → 验证」循环产出，每轮迭代更新。
> 参考来源见文末。

---

## 续执行50轮（2026-10-22启动）

- 目标：成熟平台官方能力调研 → 当前项目差距 → 实现 → 真实验证；每轮由新Haiku子代理在独立上下文发现和实现，主会话固定共享契约并复核。
- 实现底座：AI Harness 统一官方 `@anthropic-ai/claude-agent-sdk`；竞品用于对标能力，不引入第二套智能体运行或编排底座。有实际功能价值时可引入额外技术栈，同类能力选定一种实现，更换时清理旧调用与依赖。
- 文件能力范围以 `ARCHITECTURE.md`「官方文件能力与接入状态」为准，覆盖官方支持项与版本/加载约束，不局限于技能、子智能体几个示例目录；不把 CLI 专属、用户级状态或尚未接入功能声称为已支持。
- 当前完成：**50/50**（第1–50轮已验收，循环已停止）。登记/调研/派发本身不计轮；只有来源、差距、实现与实际验收齐全才计入。没有有价值缺口时继续换领域核对，不能为凑轮添加功能。
- 决策只维护 `DECISIONS-PENDING.md`；能决定则采用推荐方案，未决项仅搁置其依赖，其余继续。单管理员/单机等决定不变；知识库/RAG 已按 D-9 当前决定建设（原「不做内置 RAG、用技能替代」已被替代），编排 DSL 仍不做。不自动发布、部署或删除真实数据。
- 知识库这条线的记录放在独立任务文件里，不占用本文件的 50 轮编号：[实现契约](tasks/knowledge-implementation-contract.md)、[实施记录](tasks/knowledge-implementation.md)、[独立审查整改](tasks/knowledge-review-findings.md)、[真实运行验证](tasks/knowledge-runtime-verification.md)。
- 基线纠偏：历史优先级表的“凭证代理未做”已过时，D-17已实现；D-18已实现有超时的调用内挂起，跨进程重启恢复仍不同于持久化检查点。

| 轮次 | 来源与差距 | 实现 | 实际验证 | 状态 |
|---|---|---|---|---|
| 1 | Dify应用配置可导入导出；项目专家导出遗漏生成式工具定义及enabled/requiresApproval | export/import事务往返；复用不覆盖；创建/导入权限校验共享；重复名称拒绝，外部子智能体ID告警 | 工具专项12/12、首次全量183/183；复审修正后import+agents27/27；typecheck/lint/API构建通过 | 完成 |
| 2 | 官方SDK支持skills清单；当前生成SKILL.md却要求使用禁用的Read，未显式预批准技能调用 | 绑定slug从worker传runner，SDK原生skills清单；保持其他内置工具禁用 | SDK边界3项、真实CLI2项正负发现验证，worker/core/runner13项；全量191/191、构建通过；没有发送模型请求 | 完成 |
| 3 | 官方技能以SKILL.md为入口；当前只能在专家JSON中携带，技能页无原生文件下载 | 复用运行时renderSkillMd，鉴权下载与菜单入口 | skills接口3/3，预览与下载逐字节一致；浏览器菜单实际下载SKILL.md，typecheck/lint/web+API构建通过 | 完成 |
| 4 | 官方技能目录以SKILL.md交换；当前可下载但不能导入同一文件 | 成熟yaml解析库，现有字段校验、鉴权导入、重名409；拒绝尚未接入行为字段，保留描述性metadata提示 | parser+API25/25，全量221/221；浏览器上传/重复冲突/不支持字段拒绝/编辑保留通过，typecheck/lint/build通过；独立复审无阻塞，修正SDK缺省说明与审计文档，复跑25/25 | 完成 |
| 5 | Dify支持会话重命名；项目历史标题只有首条消息自动生成 | 手动标题PATCH、鉴权、审计仅字段名；历史菜单与共享弹层，脏草稿确认、pending关闭保护、焦点返回 | 后端接口9/9；桌面与390px保存/重载/验证/放弃/焦点通过且消息保留；全量245/245、E2E10通过1跳过，typecheck/lint/build通过 | 完成 |
| 6 | 官方子智能体以.claude/agents/*.md定义；项目只能预览，不能下载已绑定子定义 | 复用运行时渲染器、父子归属校验、下载已保存且启用定义；明确依赖父工作区MCP/技能 | 子文件API5/5、与会话接口合计14/14；浏览器编辑器实际下载，内容包含子提示词且不含父提示词；typecheck/build/lint通过，后续整合全量245/245、E2E10通过1跳过 | 完成 |
| 7 | 审批后端D-18等待同次调用，页面却要求重发；终态run仍可被无效批准 | 聊天/详情提示同步为本次调用，终态按钮移除与聊天轮询停止；事务锁定run后批准、首次时间幂等 | 生命周期10/10含真实PG阻塞锁并发；浏览器终态无批准按钮、HTTP409；全量245/245、E2E10通过1跳过、typecheck/lint/build通过；调用已超时但run仍running尚不区分 | 完成 |

| 8 | LangSmith支持数据集文件导入；项目评估用例只有逐条CRUD | agentport/eval@1 JSON、显式目标专家、事务导入同名跳过告警；导入不启动运行；导出失败留页提示 | 接口14/14含并发去重；浏览器往返、重复跳过、无效格式、390px、501条导出失败留页通过；独立复审修正错误导航；全量274/274，E2E10通过1跳过，类型lint构建通过 | 完成 |

| 9 | 评估提交只计数、执行和历史读取当前用例；增删改会改变批次和历史文本 | 提交事务冻结用例数组，worker使用快照，结果保留原文且源用例删除后外键可空；只冻结用例不固定专家配置 | 迁移0022已执行；真实DB与浏览器删除源用例后历史原文保留，worker+API11/11；全量266/266、E2E10通过1跳过；typecheck/lint/API构建通过，独立复审无阻塞、完整性+worker12/12复跑通过 | 完成 |

| 10 | 平台评估批次无停止入口；worker已有逐项状态检查但用户不能停止后续用例 | cancelled原子停止、保留已有结果；worker结果与通过数同事务锁定批次，与取消串行；界面明确当前用例可能继续 | 迁移0023已执行；真实DB幂等/晚到更新拒绝、浏览器停止通过；独立复审结果竞态用失败测试修复并新增并发一致性用例；全量276/276、E2E10通过1跳过，类型lint构建通过 | 完成 |

| 11 | TanStack路由要求选择状态走URL；当前聊天选择只在内存，刷新丢失历史 | URL承载agent/conversation，服务端归属优先；迟到提交和旧流隔离，结束刷新历史缓存；不自动发消息或恢复SDK执行 | 浏览器深链/刷新/前进后退/归属/新建/无效链接与390px通过；独立复审迟到响应与缓存缺口修复，生命周期4/4；全量302/302、E2E13通过1跳过，类型lint构建通过 | 完成 |
| 12 | 技能PATCH只有id条件，多编辑窗口最后写入覆盖；专家已有过期编辑保护 | 复用notStale与CONFLICT_STALE，技能页面提交编辑快照时间；防同毫秒并发覆盖 | 技能专项19/19含双并发唯一成功并复跑；浏览器过期草稿保留、服务端赢家不覆盖、重开最新通过；全量285/285，E2E10通过1跳过；独立复审无阻塞，类型lint构建通过 | 完成 |

| 13 | LangSmith可比较实验；当前评估历史只能逐个展开，无法按固定用例核对变化 | 同专家终态比较，快照ID对齐；输入改变/缺少历史快照/无身份明确不可直接比较，不引入评判模型 | 比较接口13/13复跑；浏览器改善/输入变更/历史无法核对、自身排除/焦点/390px通过；歧义行键修正、单边结果边界说明已实测；全量298/298、E2E12通过1跳过，独立复审无阻塞，类型lint构建通过 | 完成 |

| 14 | 子智能体可绑定skillIds，但worker/预览只加载父技能，子定义未写skills | 批量加载启用子技能，官方skills字段与工作区技能文件合并去重，草稿保留子设置；父SDK自动许可清单不扩大 | core+API17/17复跑、真实接口/子文件下载通过；CLI实际发现子定义和技能，预加载状态不可见；全量311/311、E2E13通过1跳过，类型lint构建通过，独立复审修正草稿；实际子级加载/模型执行未验证 | 完成 |

| 15 | 平台仅可导入专家JSON，无法复用官方.claude/agents/*.md角色定义 | 受限agent.md导入为独立专家，正文完整保留，已支持模型/轮次/推理字段；未知权限/Hook字段拒绝、重名409、不自动执行 | 解析与原导入31项复跑；浏览器H1/中文/轮次/effort保留、重名/权限拒绝及默认提示通过；全量328/328、E2E13通过1跳过，独立解析复审无阻塞，类型lint构建通过 | 完成 |

| 16 | MCP测试连接丢弃inputSchema，远程连接器参数结构只能靠外部检查器查看 | 单次listTools保留显式字段与目录上限，缓存只读目录、无重复连接；编辑后清除快照 | 元数据接口、目录上限3/3；浏览器参数/只读/无额外连接/编辑清缓存/焦点与390px通过；独立复审修正，整合全量334/334、E2E13通过1跳过，类型lint构建通过 | 完成 |
| 17 | 运行详情会自动刷新而列表不会，排队/运行状态需手动重载；工作台无条件请求备用列表 | 活动记录5秒刷新、终态停止；工作台只在概览返回null时查备用列表 | 轮询配置3/3复跑；浏览器排队自动转成功且筛选保留，正常概览备用请求0；独立复审无阻塞，全量334/334、E2E13通过1跳过，类型lint构建通过 | 完成 |

| 18 | 官方项目MCP配置用.mcp.json组织，平台只能手动逐条登记 | 受限HTTP/stdio原生配置批量导入，凭证加密、整批校验与事务、重名409不覆盖；占位符和未支持字段拒绝，导入不执行 | 解析+接口25/25复跑；浏览器双类型/掩码/未测试/整批冲突/模板拒绝与390px；独立库359/359、E2E13通过1跳过，安全复审无阻塞且错误回显修正；该轮类型lint构建通过，后续19轮编辑中 | 完成 |

| 19 | 手动创建/PATCH/专家JSON导入允许URL内嵌账号密码，旧记录与连接错误会明文回显 | 共享URL写入拒绝，旧列表/导出/预览统一脱敏；运行时连接前固定错误拒绝，表单保留可执行说明，不改写原数据 | URL接口/表单/解析26项复跑；真实浏览器提示headers；该轮独立库368/368、E2E13通过1跳过，后续整合379/379；独立安全复审无剩余回显，类型lint构建通过 | 完成 |

| 20 | 工具调用超时后审批记录仍待批准，页面无法区分本次恢复与后续许可 | 持久化等待期限、服务端waiting与批准范围，终态拒绝保留；慢查询后再次核对截止 | 0024两库已迁移；期限/MCP/生命周期21项与跨截止2项通过；浏览器等待/后续按钮及响应提示通过；全量373/373、E2E13通过1跳过，类型lint构建通过，独立复审边界修正 | 完成 |

| 21 | MCP工具审批等待未观察run终态或请求取消信号，取消后仍可能读取批准并调用上游 | 运行状态门禁、可中断等待与请求signal，发起上游前再检查；不承诺撤回已发送的外部请求 | 真实MCP HTTP取消错误且上游0；取消/截止/原MCP17项、复审孤立审批两条失败测试修复后10项通过；全量381/381、E2E13通过1跳过，类型lint/API构建通过 | 完成 |

| 22 | MCP共享4槽包住整个传输，审批等待和平台invoke可能占满回调所需容量 | 上游执行4槽/排队8项，审批等待独立4槽满则立即需批准；invoke独立入场与请求限流保留 | 容量8/8复跑，真实HTTP四等待不挡普通工具/第五等待即时拒绝；平台四长调用不挡新会话（模拟invoker，非沙盒）；全量389/389、E2E13通过1跳过，独立复审队列无界已修复，类型lint构建通过 | 完成 |

| 23 | 专家JSON只带根定义和源subAgentIds，导入虽告警但无法恢复委派和子技能 | 直接子定义及资源并集可移植包，根绑定名称独立；事务新建子定义与最终版本，不复用改挂既有专家 | 完整往返/版本/无部分写入通过；复审技能漂移先失败后告警不覆盖，联合44项、整合全量427/427、既有E2E13通过1跳过、真实HTTP往返、类型lint构建通过；交互式包上传下载未实测 | 完成 |

| 24 | 评估用例可导出，但实际输出/通过情况只能在线查看，无法保存测得结果 | 终态eval-run@1文件，复用结果schema、配置未固定标记、500条/1MiB拒绝不截断 | API11项/联合44项、全量427通过；真实HTTP附件与浏览器实际下载核对、运行禁用和超限留页通过；完整E2E17通过1跳过；显式DB配置，类型lint构建通过 | 完成 |

| 25 | 同会话可被多标签页同时提交，生成两个活动run并穿插历史/审批继承 | 专家KEYSHARE后会话行锁入场，活动queued/running返回409；运行/历史/用户消息同事务，不同会话并行 | 旧路由3条失败复现；新11项含锁竞争与专家删除反序NOWAIT失败→通过；顺序聊天前置修正，全量428/428、当前构建E2E17通过1跳过、类型lint构建通过；无数据清理/迁移，非全库唯一约束 | 完成 |

| 26 | 会话详情无界读取全部消息，长会话打开会传输大量工具内容 | 默认50/最大100游标页，按需加载更早消息，原始历史保留合并，流式尾部与跨页工具关联不重复，分支仍完整复制 | API/聊天/分支41项、前端16项、全量448通过；刷新窗口丢旧消息真实浏览器旧失败新通过；125条/390px/切换/刷新，完整E2E21通过1跳过，类型lint构建通过；未验证像素级锚点或真实模型SSE竞争 | 完成 |

| 27 | cancelled终态后worker仍无条件替换消息，晚到旧回答可能进入新轮历史 | 专家/会话/运行固定锁序，锁内检查running再替换输出，终态不写；取消与落库按提交顺序收口 | PG取消先/落库先及删除锁序、重放/用户保留/脱敏专项17项通过，全量458/458；worker构建类型lint通过，独立复审无阻塞；非真实沙盒，PG等待调度为测试边界 | 完成 |

| 28 | 陈旧queued按年龄直接失败，worker重启/拥堵后仍在BullMQ等待的任务会被误丢弃 | 先核对队列状态保留有效任务，条件更新防认领/取消覆盖；每次探测20秒超时，错误延后且迟到不写 | 真实Redis旧3个误收口失败→新仅1个；专项10项含启动离线约20秒保留queued与关闭，full468/468、类型lint构建通过；独立复审超时问题已修正，不自动重投 | 完成 |

| 29 | running收口固定用全局超时，专家配置更长timeoutMs的合法长任务会被提前判失败 | 按当前专家timeoutMs加宽限判断running；queued探测与其余契约不变，不改表不冻结运行中配置 | 同一陈旧起点短10秒失败/长1小时保留，队列/离线契约13项，全量471/471、类型lint worker构建通过，独立SQL复审无阻塞并移除死回退；运行中改配置按当前值、时钟偏差为边界 | 完成 |

| 30 | 运行详情只能重跑不能取消活动运行；queued取消仅改数据库，BullMQ等待作业残留占队列名额 | 详情增加queued/running取消；queued取消后best-effort移除等待job，DB终态优先，操作幂等 | API旧job残留红→消失绿且重复取消幂等；联合取消/入场23项、全量476/476、浏览器queued/running/succeeded三态与轮询E2E24通过1跳过；队列删除best-effort，不撤回已发出上游 | 完成 |

| 31 | 审计页只能按动作前缀/状态分页查看，运维无法按目标筛选或保存证据，只能手翻curl/psql | 复用脱敏审计列增加目标精确筛选和1000条有界JSON导出，超限409不截断，鉴权/附件头/错误留页 | 旧实现目标失效与静默截断已红；API7项、浏览器目标下载/超限提示/恰好1000条E2E27通过1跳过、全量483/483、独立复审无阻塞，筛选与表格口径一致 | 完成 |

| 32 | 会话历史面板没有标题搜索，会话多时只能逐条找 | 客户端标题筛选（不区分大小写包含）、清除恢复、无匹配提示；只作用于当前专家已加载列表 | 浏览器3项筛选/清除/空态/跨专家不串通过；完整E2E30通过1跳过、全量483/483，类型lint构建通过 | 完成 |

| 33 | 概览“需要处理”只看最近20条，窗口内更早失败被误判无待处理；无窗口失败总数与Token汇总 | 概览聚合增加窗口失败数与Token总量；最近列表无失败但窗口有失败时显示真实总数并引导查看全部 | 窗口内外failed/tokens精确，一次性库聚合2项、真实overview返回8失败/46671tokens、页面提示E2E、完整E2E32通过1跳过、全量485/485，类型lint构建通过；共享库下“近期无失败”提示分支未E2E | 完成 |

| 34 | 平台MCP工具忽略请求中止信号，外部客户端取消后对应run仍会执行并消耗 | invoke接受ctx.mcpReq.signal；共用聊天取消逻辑，running发布worker停止信号，queued发布终态并清理作业；不撤回已发上游 | 原4项/HTTP3项通过；遗漏停止信号已补，真实Redis键与订阅/终态流验证，停worker联合25/25及整合全量510通过；2025无状态单次abort不可达保留，修正不另计数 | 完成 |

| 35 | 运行列表只能在线分页查看，无法保存按专家/状态筛过的运行证据 | 复用运行列表脱敏元数据增加1000条有界JSON导出，不含步骤/提示词，超限明确拒绝，页面错误留页 | 旧404已红；API6项、浏览器2项筛选下载校验、完整E2E34通过1跳过、全量498/498，一次性库隔离，类型lint构建通过 | 完成 |

| 36 | 评估批次从创建一小时后盲目失败，队列等待或长批次仍有效却被截断 | 超龄仅作为探测候选，按eval队列有效状态保留批次；20秒/4并发探测，错误保留，条件更新防取消/完成覆盖 | 旧盲失败真实Redis两例已红；waiting/delayed/active保留、缺失/终结失败、探测超时/错误与取消竞争专项、联合6项、全量510/510，类型lint构建通过；不重跑批次 | 完成 |

| 37 | 平台MCP调用入队失败或等待截止仅向客户端报错，queued/running可能遗留并继续消耗；非正超时可创建立即过期运行 | 入参先校验正有限超时；入队失败条件收口infra，等待截止复用共享取消及worker信号，保留已完成终态 | 旧实现7项失败→新7项通过；停worker联合25项、独立复审无阻塞、最终全量517/517，类型lint/API构建过；原公网夹具两失败已改本地真实HTTP后9项通过，不另计数 | 完成 |

| 38 | 审计只用时间戳游标，同一时间超过一页时翻页会漏记录 | 增加beforeId独占游标，数据库按原始(created_at,id)比较，保留before时间范围与导出过滤 | 旧API5项/客户端3项失败已红；审计API13项、客户端6项、联合23项，全量531/531，真实125条加载更多完整无重复，E2E35通过1跳过，独立复审无阻塞，类型lint构建过 | 完成 |

| 39 | 概览Token单行int32相加及总计强转可溢出，合法大累计导致overview 500 | 加法前升为bigint，sum后转float8保留JSON数字，统计窗口和页面结构不变 | 单行25亿/累计30亿旧API500已红，修正真实PG4项通过并保持数字类型；联合23项、全量531/531、E2E35通过1跳过，独立复审无阻塞，类型lint构建过；2^53以上精度不保证 | 完成 |

| 40 | Redis保留裁剪可能使重连只回放尾部，页面结束后不采用已保存结果；字节上限标记污染回答文本 | 结构化裁剪提示；仅裁剪运行结束后读取已保存run步骤修复本轮尾部，保留旧历史并隔离迟到响应 | 真实Redis5项、前端32项、全量544/544，真实POST/Stream/EventSource/run详情恢复完整回答、旧历史保留去重；E2E36通过1跳过，复审两项数据丢失边界已红绿修复，类型lint构建过 | 完成 |

| 41 | 连接器PATCH和token轮换基于旧配置整块写回，可能使旧token复活或地址回滚；条件冲突误404、同毫秒版本可复用 | 锁内读取并合并更新/轮换；版本毫秒单调递增，过期写返回409，保留缺失404 | 旧200/404及token回滚已红；并发3项与CRUD/导入联合34/34、新token200旧token401、全量544/544、完整E2E36通过1跳过，独立复审无阻塞，类型lint构建通过 | 完成 |

| 42 | 专家updatedAt仍用本地毫秒时间，同一毫秒旧版本可复用，条件并发可能双成功并生成相互覆盖的版本 | 编辑版本按既有技能/连接器模式至少推进一毫秒，保留条件冲突409、事务快照与绑定语义；单连接内读取顺序执行 | 冻结时钟复用/未来版本倒退旧实现已红，修正真实PG4项与完整阻塞链200/409赢家快照通过；联合40项、全量551/551、类型lint构建通过，独立复审无阻塞；父子改挂范围不变 | 完成 |

| 43 | 专家导出仅限制条数不限制总字节，页面二次排版后可生成自身导入拒绝的包 | 共用实际下载序列化与1MiB UTF8上限；导出超限409不截断，导入显式同限，保留workspace和原包字段 | API Unicode往返/恰好1MiB及多一字节/超限导出3项通过，联合40、全量551后续552通过；实际下载后页面原文件上传与超限留页，E2E38通过1跳过，独立窄范围复审无阻塞；旧非法数据不保证往返 | 完成 |

| 44 | 专家PATCH将事务前读取的整行回填，不带版本的不同字段并发会互相恢复旧值 | 仅更新请求明确提交的列，保留带版本409、字段转换和事务版本快照；同字段无版本仍后写优先 | 越界代理改动经主会话核对、正式租约与独立复审；旧丢值已红，新不同字段均保留且最终版本1/2/3快照一致；联合24、全量552/552、类型lint通过 | 完成 |

| 45 | 子智能体归属与单层约束只在事务外检查，不同父专家可同时争用同一子定义或并发形成两层委派 | 仅绑定变更获取事务级绑定锁，在仓储事务内重新校验归属/层级；创建编辑回滚共用规则，普通字段编辑不加此锁 | 三种归属/层级竞争与校验后删除两竞争旧错误成功已红，新5项通过；实际绑定不足整体回滚配置与版本，二次复审无阻塞；联合35通过1跳过，全量568/568、类型lint构建通过 | 完成 |

| 46 | 评估行提交后入队失败会遗留running并阻止同专家再次提交，最长等待一小时清理 | 入队异常仅条件收口running且claimedAt为空的批次，固定503；仅收口赢家尽力移除job，保留已认领/终态，日志不附原始cause | 6分支与日志安全断言、联合35通过1跳过、独立复审通过；清理夹具按ID隔离修正后完整回归568/568，类型lint构建通过；DB收尾失败仍需取消/既有清理 | 完成 |

| 47 | 专家选择默认强度或清空思考预算时undefined被JSON省略，保存后旧值重新出现 | 仅PATCH接受effort/maxThinkingTokens为null表示清除；省略保留，创建导入不变，完整表单显式清除并同步乐观缓存 | API默认清除5项与导入/版本联合34项通过，真实页面设置high/2048→默认空值→改名重载保持，完整E2E41通过1跳过、全量578/578，类型lint构建及窄范围复审通过 | 完成 |

| 48 | 连接期间数据库已终态而run_finished丢失时，原SSE只等待后续事件，页面可能持续运行 | 每2秒不重叠检查数据库终态；遗漏时先发terminal_missing恢复标记再发终态，复用持久化回答恢复，连接关闭清理检查 | 真实HTTP/Redis5项、客户端恢复及裁剪联合23项通过，真实页面仅DB终态无XADD仍恢复完整回答，完整E2E41通过1跳过、全量578/578，类型lint构建过；复审无阻塞并补finishing保护与失败清理 | 完成 |

| 49 | 普通聊天入队失败虽条件收口queued，但重抛原始队列错误返回500且日志可能含连接信息 | 保留条件收尾，改固定503且不携带原始cause；已认领/终态保护及日志验证 | 4旧500失败测试已红→新503通过，联合14项、全量578/578，日志有统一错误记录且无连接信息，跨文件复核无阻塞，类型lint构建通过 | 完成 |

| 50 | 已连接运行的数据库行消失时，SSE仍周期查询且客户端持续忙碌 | 仅连接内确认行不存在时发run_unavailable并关闭；客户端保留文本、释放忙碌、刷新历史，不伪造结果；初次不存在仍404、DB故障继续重试 | 客户端36项、真实HTTP/Redis7项通过，复审补清空残留lastRunId已红绿验证；真实页面固定提示/文本保留/输入恢复且无死详情入口，最终E2E42通过1跳过、全量583/583，类型lint构建及两独立复审通过 | 完成 |

官方基线来源：
- https://docs.dify.ai/zh/use-dify/workspace/app-management
- https://docs.dify.ai/zh/api-reference/conversations/rename-conversation
- https://docs.dify.ai/zh/api-reference/conversations/delete-conversation
- https://docs.langchain.com/langsmith/compare-experiment-results
- https://docs.langchain.com/langsmith/manage-datasets-in-application
- https://docs.n8n.io/workflows/history/

## 循环 1（2026-10-20）

### 行业基线：生产级智能体平台的六个原语

综合 2026 年多方实践，平台能力被归纳为**模型无关的六个原语**，换模型不用重写平台：

| 原语 | 含义 |
|---|---|
| **沙盒** | 隔离执行，最小权限，临时凭证 |
| **凭证** | 密钥不下放到不可信代码，按需注入 |
| **工具网关** | 参数校验、限流、高风险调用审批 |
| **HITL** | 分级自治：常规直通、不确定排队审批、高风险升级 |
| **Tracing** | 多步推理树，含工具输入输出、token、版本、策略决策 |
| **回滚** | 配置与运行的快照恢复 |

在此之上，生产必需项包括：**离线评估套件 + 在线抽样评估 + 轨迹评估**、**版本化（提示词/工具/记忆策略/护栏一起验证）**、**预算与停机控制**、**审计与 RBAC**。

### 差距矩阵

状态：✅ 已实现 ／ 🟡 部分 ／ ❌ 未实现

> 说明：此矩阵是**循环 1 结束时**的快照，「本轮」指循环 1；后续循环的补齐记录见下方各节与根 [CHANGELOG.md](../CHANGELOG.md)。「下一轮」是当时的计划，不代表当前状态。

| 领域 | 能力 | 循环前 | 本轮 | 说明 |
|---|---|---|---|---|
| 沙盒 | 隔离执行、资源限制、只读根 | ✅ | ✅ | cap-drop、no-new-privileges、memory/cpu/pids |
| 凭证 | 密钥加密入库、接口脱敏 | ✅ | ✅ | AES-256-GCM |
| 凭证 | **运行时注入 MCP env/headers** | ❌ | ✅ | 已移到 `core/secrets.ts`，worker 解密注入 |
| 工具网关 | MCP 三类来源 + 连接测试 | ✅ | ✅ | |
| 工具网关 | 工具级启用/禁用 | ❌ | ❌ | 下一轮 |
| HITL | 取消运行 | ✅ | ✅ | |
| HITL | 工具调用审批 / 暂停恢复 | ❌ | ❌ | 下一轮（需 SDK 交互通道） |
| Tracing | 运行状态/成本/轮次 | ✅ | ✅ | |
| Tracing | **token 与延迟落库** | 🟡 | ✅ | `latency_ms` / `input_tokens` / `output_tokens` |
| Tracing | **完整对话历史（assistant + tool）** | ❌ | ✅ | worker 持久化 `assistant_text` 与 `tool_result` |
| Tracing | run 详情页 / trace 树 | ❌ | ❌ | 下一轮 |
| 回滚 | 配置版本历史 | ❌ | ❌ | 下一轮 |
| 评估 | 离线评估集、在线抽样、轨迹评估 | ❌ | ❌ | 下一轮 |
| 版本 | 智能体/技能版本化 | ❌ | ❌ | 下一轮 |
| 治理 | 审计写入覆盖 | 🟡 | 🟡 | 已有 3 个动作；配置变更与登录待补 |
| 治理 | 审计页 | ❌ | ❌ | 下一轮 |
| 知识 | 文档/RAG | ❌ | ❌ | 优先级低（可用技能替代）——循环 1 当时的判断，已被 D-9 替代；当前实现见 [ARCHITECTURE.md](ARCHITECTURE.md#6-知识库运行时) |
| 多智能体 | 子智能体 / 编排 | ❌ | ❌ | 优先级中 |
| 运行时 | agent enabled 生效 | ❌ | ✅ | POST /api/chat 拒绝禁用 agent |
| 运行时 | 健康检查含 Redis | 🟡 | ✅ | `/health/ready` 同时检查 DB 与 Redis |
| 运行时 | 队列重试策略 | ❌ | ❌ | 下一轮 |

### 本轮已修复并验证

1. **运行时密钥注入**：worker 从 `secrets_encrypted` 解密后写入 `.mcp.json`，与预览一致。验证：技能绑定 + 文件预览输出一致。
2. **对话历史完整**：worker 把 `assistant_text` 与 `tool_result` 写入 `messages`。验证：一次真实运行后角色序列为 `user, tool, tool, assistant`。
3. **token 与延迟**：从 SDK `result.modelUsage` 汇总并落库。验证：`totalTokens=3152`、`latencyP50=6228`。
4. **enabled 生效**：禁用智能体调用返回 409。
5. **健康检查**：`/health/ready` 返回 `{db:"ok",redis:"ok"}`。
6. **错误映射**：外键引用不存在返回 400（`INVALID_REFERENCE`）而非 500；重名返回 409。

### 循环 1 补充：完整对标结论

详细调研（LangSmith / LangGraph / Dify / n8n / Flowise / Vellum / OpenAI Agents / Claude Code / MCP）确认了 P0 的完整集合，并补出三个此前遗漏项：

| 能力 | 状态 | 说明 |
|---|---|---|
| **把平台自身暴露为 MCP Server** | ❌ | 目前只做 HTTP→MCP；反向暴露（智能体即工具）缺。Dify / n8n / Flowise 都有。边际成本低、价值高。 |
| **持久化 HITL（暂停落盘、跨重启恢复）** | ❌ | 现有「取消」只是终止，不是暂停。LangGraph 的 `interrupt` + checkpointer 是参照。 |
| **错误分类与重试策略** | ❌ | 队列未设 attempts/backoff；模型限流、工具失败、超时未区分。 |

另确认以下项**已达标**：文件定义智能体、MCP 客户端（stdio + HTTP）、HTTP→MCP、流式 SSE、会话持久化、沙盒、取消/超时/预算、凭据加密。

### 循环 2 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 运行详情页 + trace 时间线 | ✅ | `GET /api/runs`、`/api/runs/:id`；`/runs`、`/runs/$runId` 页面 |
| 配置版本历史 + 回滚 | ✅ | `agent_versions` 表；创建/更新同事务写快照；`POST /api/agents/:id/rollback`。实测 v1→v2→rollback 生成 v3 |
| 审计页 + 覆盖 | ✅ | `GET /api/audit`；登录成功/失败、server/agent/skill 增删改、测试连接、运行请求/取消 |
| 平台暴露为 MCP Server | ✅ | `POST /mcp` + `PLATFORM_MCP_TOKEN`；已启用智能体成为工具。实测 `initialize` 成功 |
| 错误分类与重试 | ✅ | BullMQ `attempts:2` + 指数退避；`isRetryable` 只重试基础设施错误 |
| 工具调用消息落库 | ✅ | `tool_result` 与 `assistant_text` 写入 `messages` |

### 循环 3 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 工具级启用/禁用 | ✅ | `api_tools.enabled`；`PATCH /api/servers/:id/tools/:toolId`；`buildGeneratedServer` 跳过禁用项。实测禁用后测试连接工具消失、评估跑批失败；恢复后 2/2 通过 |
| 评估集 + 回归跑批 | ✅ | `eval_cases` / `eval_runs` / `eval_results`；`POST /api/eval/runs` 异步串行执行；实测 2 个用例全部判对 |
| 资产导出 | ✅ | `GET /api/export/agents/:id`，官方 `.claude/` 目录 ZIP（平台元数据在根 sidecar），密钥只导出键名 |
| 数据库备份 | ✅ | `pnpm backup` → `pg_dump | gzip`，保留 7 份 |
| 运行完成审计 | ✅ | worker 写 `agent.run.finished` |
| run 步骤映射单测 | ✅ | `packages/db/test/steps.test.ts`，5 个用例 |

### 循环 4 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 子智能体单层委派 | ✅ | `agents.parent_id`；渲染 `.claude/agents/<child>.md`；仅 `allowSubAgents` 时放行 `Agent` 工具；拒绝自引用与两层 |
| 数据保留 | ✅ | 版本保留 50、终态运行 90 天、孤立消息 30 天；每日 repeatable job + `pnpm --filter @agentport/worker maintenance` |
| 指标端点 | ✅ | `GET /health/metrics`：进程 / 队列 / 连接池 / Redis ping，依赖不可用时返回 null 而非 500 |
| 请求日志规范化 | ✅ | 按路由模板记录，`unmatched` 兜底；>2s 记 warn；SSE 排除 |
| 平台健康卡片 | ✅ | 概览页 30s 轮询队列与内存 |
| E2E 回归 | ✅ | 5 条用例覆盖运行/审计/技能/评估/概览 |

### 循环 5 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 会话上下文恢复 | ✅ | 发起 run 时取最近 20 条消息注入 prompt；不依赖 SDK session resume |
| 会话分支 | ✅ | `conversations.parent_id` + `branch_of_message_id`；`POST /api/conversations/:id/branch`；侧栏按钮 |
| 智能体导入 | ✅ | `POST /api/import/agents`；slug 冲突自动改名；密钥只提示不导入；6 个测试 |
| 可访问性收口 | ✅ | 焦点环兜底、skip-link、Dialog/抽屉焦点陷阱、键盘导航、错误文案与 `aria-describedby` |
| 响应式 | ✅ | 1280/1024/768/390 四宽度实测无横向溢出；每页唯一 h1 |
| 文案质量 | ✅ | 错误按状态码给「发生了什么 + 下一步」；空态补主行动 |

### 循环 6 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 部署可移植 | ✅ | compose 去掉 `${PWD}`，改用命名卷 + `HOST_WORKSPACES_DIR`；在 `/tmp` 下 `--project-directory` 验证通过 |
| 部署自检 | ✅ | `pnpm smoke` 覆盖健康、登录、三类列表、MCP 鉴权；实测输出 `SMOKE OK` |
| 工具审批（最小） | ✅ | `api_tools.requires_approval` + `agent_runs.approvals`；未批准返回明确文案；`POST /api/runs/:id/approve`；20 个相关测试 |
| 文档收口 | ✅ | README（概览 + 命令 + 安全要点）、ARCHITECTURE、OPERATIONS（环境变量、部署、排障、压测） |
| 文档与代码一致性 | ✅ | 修正 15 处偏差（`SANDBOX_NETWORK`→`SANDBOX_EGRESS`、`pnpm -r typecheck` 写法、迁移非自动、`PLATFORM_MCP_TOKEN` 未文档化等） |
| 禁用智能体拦截 | ✅ | `POST /api/chat` 返回 409 并给下一步 |

### 循环 7 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 失败路径测试 | ✅ | 9 条：SSE 提前断开、重复投递、非法 JSON、超长输入、审批边界、约束冲突 |
| 修复的真实缺陷 | ✅ | SSE 引用计数泄漏（两个标签页互相影响）、批准不存在工具被静默接受、prompt 无上限 |
| 性能索引 | ✅ | `messages.run_id`、`agent_runs(started_at)`、`(conversation_id, created_at, id)`；执行计划由 Seq Scan 转 Index Scan |
| 会话列表瘦身 | ✅ | `lastMessage` 只取 280 字符，响应体 8009 → 6820 B |
| 安全审查 | ✅ | `docs/SECURITY.md`：1 Critical + 11 High；循环 8、9 已修复全部 High 与 Medium，仅剩 M12 |
| 测试总数 | ✅ | 82 个 vitest 用例（当前实测）+ E2E |

### 循环 8 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 预览脱敏 | ✅ | 密钥值显示 `<已配置>`；generated 的 Authorization 运行时注入 |
| 结构化工具审批 | ✅ | `approval_requests(run_id, server_id, tool_name)`；`POST /api/runs/:id/approve`；UI 改读 `/api/runs/:id/approvals` |
| 日志/落库脱敏 | ✅ | `redactSecrets` 覆盖 Bearer/sk-/ghp_/`KEY=value`/长 base64url；stderr 降为 debug |
| 输出上限 | ✅ | 沙盒单字段 256 KB；worker 单行 1 MiB、单 run 2000 事件/32 MiB；UI 64 KB 折叠 |
| 导入安全 | ✅ | 导入调用 `assertSafeUrl`；同名不同 kind 拒绝复用；写 `agent.imported` 审计 |
| 审计补齐 | ✅ | tool CRUD、eval case CRUD、logout、`/mcp` 触发 run 均有审计 |
| 环境校验 | ✅ | `APP_SECRET_KEY`/`JWT_SECRET` ≥32、`ADMIN_PASSWORD` ≥12 且拒绝占位值 |

### 循环 9 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 限流 | ✅ | 登录 10/min、chat 20/min、`/mcp` 与 `/mcp/:serverId` 60/min、连接测试 20/min、评估发起 10/min；`/mcp` 另有进程内并发 4 |
| CSP | ✅ | 全局启用；仅 MCP 路由关闭；`style-src` 放行内联样式 |
| 可吊销会话 | ✅ | JWT 带 `sid`，Redis `session:<sid>`，logout 立即失效；鉴权结果本地缓存 5 秒 |
| CORS / 代理 | ✅ | `CORS_ORIGINS` allowlist；`TRUST_PROXY=1` 信任转发头 |
| 乐观锁 | ✅ | Agent/Server PATCH 带 `expectedUpdatedAt`，冲突返回 409 `CONFLICT_STALE` |
| 外键 | ✅ | `agent_runs`、`messages.run_id` 外键（迁移 0011 先清理孤儿行） |
| 沙盒出站 | ✅ | `SANDBOX_EGRESS` 三档：默认 `open`（bridge 直连）；`proxy` 必须配代理否则启动 fail-closed；`none` 断网 |
| 压测基线 | ✅ | 读/写/SSE/MCP/队列数据与第一瓶颈见 [OPERATIONS.md §8](OPERATIONS.md#8-压力测试结果) |

### 循环 10–12 已补齐（摘要）

| 能力 | 状态 | 证据 |
|---|---|---|
| 工作区按 run 隔离 | ✅ | `WORKSPACES_DIR/<slug>/<runId>/`（`run_*`）；run 结束删除，重试复用同一目录；会话复用另用 `session-sandboxes/<conversationId>/{workspace,outputs}`（实施中，见 [任务记录](tasks/session-sandbox-lifecycle.md)） |
| 工具卡片持久化 | ✅ | worker 同时落 `tool_use` 与 `tool_result`；刷新后可重建卡片 |
| Redis 健康检查修复 | ✅ | compose healthcheck 使用容器内 `REDIS_PASSWORD`，新部署不再卡在 unhealthy |
| 取消与孤儿收敛 | ✅ | SIGTERM → SIGKILL 升级；5 分钟周期把超时仍 `running` 的 run 置 `failed` 并补发 `run_finished` |
| URL 校验 | ✅ | 登记/修改时校验协议与私网；运行前再次校验 |
| 审批跨 run 继承 | ✅ | 同一会话下一次 run 复制 `approval_requests`，审计记 `agent.run.approvals_inherited` |
| 预览与运行时统一 | ✅ | 共用 `core/workspace-input.ts`；预览用占位密钥，运行用真实密钥 |
| token 轮换 | ✅ | `POST /api/servers/:id/rotate-token`，旧 token 立即失效，明文只返回一次 |

### 循环 13 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 按 run 的短期 MCP token | ✅ | `agent_runs.mcp_token_hash` / `mcp_token_expires_at`（迁移 0012）；token 仅写入 `.mcp.json`，DB 存 sha256，run 结束清空；端点先认 run token 再回退长期 token |
| 工作区文件权限 | ✅ | 目录 0700 / 文件 0600（`core/mcp-token.ts`）；重试复用后再次 `chmod`；macOS Docker Desktop 下容器内 uid 1000 可读 |
| 评估跑批入队 | ✅ | `eval-runs` 队列（并发 1）；API 只建行并入队返回 202；`eval_runs.error`（迁移 0013）；超 1 小时 running 收敛为 `failed` |
| SSE 每连接独立订阅 | ✅ | `subscribeRun` 每次一条独立 Redis 连接并 `XREAD BLOCK` 跟读；串行回调保持背压；无 pub/sub 唤醒 |
| 测试 | ✅ | 新增 `generated-mcp.test.ts`（run token 生命周期、绑定校验）、`sse-subscribers.test.ts`（并发发布去重、关闭隔离）、eval 入队断言 |

### 循环 14 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 子智能体真实端到端验证 | ✅ | 真实模型 + 沙盒，`Agent` → 子智能体 MCP 调用 → `[Subagent hand-back]`；连续 3 次 run 成功。见 [SUBAGENTS-VERIFICATION.md](SUBAGENTS-VERIFICATION.md) |
| 子智能体零工具修复 | ✅ | 子智能体 md 不写 `tools`，继承父会话工具集；避免 SDK 派生时通配符解析为空 |
| 父智能体自我递归修复 | ✅ | 主智能体 md 不写入 `.claude/agents/`，只保留预览 |
| SSE 事件重复修复 | ✅ | 串行化 drain，事件数等于 `XLEN` |
| 前端缺口 | ✅ | `allowedTools` / `maxThinkingTokens` 编辑；运行详情「用同样输入重新运行」；技能列表显示使用数 |
| 备份恢复 | ✅ | `restore.sh`：gzip 校验 → pre-restore 安全副本 → 单事务整库替换 → 补迁移；真实演练通过 |

### 循环 15 已补齐

| 能力 | 状态 | 证据 |
|---|---|---|
| 子智能体调用归属 | ✅ | 事件新增可选 `parentToolUseId`；worker 落库保留；对话页与运行详情缩进并标「子智能体内部调用」 |
| CI 扩展 | ✅ | ci.yml 增加 e2e（`e2e run`，Playwright 已退役）与 docker（构建 api/sandbox 镜像）job |
| 发布流程 | ✅ | `v*` tag 触发 release.yml，推送 `ghcr.io/<repo>/api` 与 `/sandbox` |
| 运维手册 | ✅ | [RUNBOOK.md](RUNBOOK.md)：症状 → 判断 → 处置 → 验证，含 token 泄露与审计取证 |
| 系统状态页 | ✅ | `/status`：live / ready / metrics 三面板，10 秒刷新，浏览器内只读自检 |

### 下一轮优先级（按对「生产可用」的影响排序）

| 优先级 | 能力 | 状态 / 理由 |
|---|---|---|
| ~~P0~~ | run 详情页 + trace 树 | ✅ |
| ~~P0~~ | 智能体配置版本历史 + 回滚 | ✅ |
| ~~P0~~ | 审计页 + 配置变更审计 | ✅ |
| ~~P0~~ | 平台自身暴露为 MCP Server | ✅ |
| ~~P0~~ | 错误分类与重试 | ✅ |
| ~~P1~~ | 工具级启用/禁用 | ✅ |
| ~~P1~~ | 资产导出/备份 | ✅ |
| ~~P2~~ | 评估集（手工用例 + 回归） | ✅ |
| ~~P2~~ | 子智能体（单层委派） | ✅ |
| P1 | 持久化 HITL（暂停 → 落盘 → 恢复） | 未做；当前是最小审批闭环（D-3） |
| ~~P1~~ | 模型凭证代理（M12 剩余项） | ✅ 已按 D-17 实现：worker 持有真实凭证，沙盒每 run 只拿短期 token；文件权限与 run token 已先行完成。见 [SECURITY.md](SECURITY.md) |
| P3 | RAG / 知识库 | 未做；技能可覆盖多数场景（D-9）——循环 1 时的排序。当前已按 D-9 建设（模块与前端落盘，真实闭环验收未完成），见 [ARCHITECTURE.md §6.8](ARCHITECTURE.md#68-当前实现状态) 与 [运行验证记录](tasks/knowledge-runtime-verification.md) |

---

## 参考

- [Production AI Agents in 2026: The Reliability Stack](https://icmd.app/article/the-agentic-reliability-stack-in-2026-how-teams-are-making-ai-agents-safe-fast-a-1776488198970)
- [Building Production-Ready AI Agents in 2026 — MLflow](https://mlflow.org/articles/building-production-ready-ai-agents-in-2026/)
- [AgentOps Is the New DevOps — operating AI agents in production](https://turjo.me/agentops-ai-agents-production)
- [Beyond the Demo: AI Agent Governance, Traceability, and Quality](https://prextechnologies.com/blog/ai-agents-governance-traceability-quality)
- [Building Autonomous AI Agents: Architecture and Design Patterns](https://www.netconsulate.com/insights/building-autonomous-ai-agents-architecture-and-design-patterns)
- [2026 年生产团队最佳 AI Agent 评估与可观测性 Harness](https://mcplato.com/zh-hant/blog/top-ai-agent-evaluation-observability-harnesses-2026)
