# 技术栈最佳实践修复

## 目标与方案

按 Fastify/API、Drizzle/Postgres、React/Query、shadcn/Tailwind/Vitest 四组技能审计结果修复实际问题。Opus 设计与独立评审，Sonnet 分域实施，主会话审查、验证和交付。新增依赖、部署服务、schema 与迁移均为零。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/best-practice-fixes`
- 分支：`refactor/best-practice-fixes`
- 起始 origin/main：`381e7b205c996e3dfdd3d463e49690cf0fe73f62`，初始本树差异为空。
- 主 checkout 原有 `.vitest/json/output.json` 变化不属本轮，不覆盖或提交。
- DB：knowledge/chat 仓储与直接 chunks/integrity 测试。
- API：auth/skills 路由、errors/openapi 插件、shared Zod locale 与直接测试。
- Web：文档搜索、专家文件查询、检索 key、对应测试；UI button/chart/checkbox/dialog/radio/select/sheet/slider/switch/toggle 与 focus 脚本、组合状态测试。
- 文档：本记录、ARCHITECTURE.md、VALIDATION.md、PROJECT-BRIEF.md的API文档一行；后者已确认与实际接入冲突，仅定点纠正。其他 worktree 和共享环境不动。

## 当前有效决定

- 用户已授权 commit/push/PR/merge、清理任务工作区和临时实例、更新 main，无需再次确认。执行代理不自行提交只是分工。
- 按变化范围验证，不触发/等待 CI、不启动 PR 监控。真实模型和完整产品 E2E 未执行，如实列为限制，不临时增设交付门槛。
- 分块按500行批次插入并顺序汇总；4700条旧参数超限复现修复。传入Tx时随外层事务回滚，直接传DB时后批失败可能保留前批，调用方仍在全部成功后发布版本。
- 会话分支所有来源读取与复制写入走同一事务；第二批失败回滚分支会话与消息，不新增行锁。
- 文档 JSON/YAML、Scalar页面/脚本等资源需真实登录 Cookie；文档子scope共用errorHandler，根scope单独一次注册，无FSTWRN004。
- requireAuth 抛 AppError 停止处理并维持Problem形状/Set-Cookie；技能通配路径在schema校验，删除handler重复safeParse。
- shared入口配置Zod默认中文，自定义文案不变；影响API/Web/worker默认消息。
- 文档搜索复用300ms防抖，空态依据settledQuery；文件树只在files分区查询；搜索key带limit；固定120/450ms等待改有界条件等待。
- Radio聚焦/选中/错误优先级、Checkbox/Switch/Button错误聚焦压环、Toggle outline单层；Slider实际焦点在内部input，以has(:focus-visible)响应、透明边框+2px环、内部无outline。删除未定义cn-*类、统一ChartTooltip语义阴影。
- Badge单层焦点和ring-0/transparent抵消类保留，不为统一类名删掉有效行为。

## 已替代项

- 只删radio焦点环不足以覆盖选中态CSS优先级，已补组合状态并实编译/浏览器核验。
- 错误态环豁免与设计系统冲突，已删除豁免；错误+聚焦应有可见危险边框且无第二层环。
- Slider的thumb自身不聚焦，旧focus-visible类不生效，已转为内部input实际焦点。
- 搜索输入与生效query不同步导致清空瞬间空态误报，已改settledQuery并补回归。
- 最终复核发现Toggle default在错误+聚焦时宽度0导致信号消失，已补aria-invalid真实1px边框；颜色、宽度和无环断言先红后绿，浏览器确认1px危险边框、ring0、outline none，独立定点复核3/3通过。

## 审计判定与未实施项

| 候选 | 判定与后续 |
|---|---|
| HNSW iterative_scan、外键/列表/JSONB索引 | 静态疑点，需EXPLAIN、数据量和召回/耗时实测，不能直接判定生产缺陷或盲加索引 |
| 标签逐条upsert | 低优，未证实瓶颈，不扩本轮 |
| request-id、503 Retry-After | 可选错误接口增强，本轮不扩 |
| OpenAPI错误schema与版本0.13/根0.14 | 已记录真实不一致，留后续单独处理 |
| 列表数组/分页形状统一 | 涉及接口消费迁移，非本轮最小修复 |
| inline select加memo | 未证实明显开销，不加 |
| setQueryData后invalidate | 可为正常的服务端重新校验，不是一律互斥或确证bug |
| 英文a11y、字号、死token和cn两入口 | 需实际引用/渲染核查；不盲删dark分支和正常导入，不因通用技能默认改视觉 |
| PROJECT-BRIEF中“API文档未接入” | 已与代码核对不一致，定点修正为Swagger+Scalar及登录要求，不扩大历史简报整理 |

## 步骤

- [x] 四组技能审计、独立工作区与专用数据库
- [x] DB实施与独立评审通过
- [x] API实施与独立评审通过
- [x] Query实施和清空空态修复通过最终复核
- [x] Slider真实键盘焦点与其余组合状态验证
- [x] Toggle default错误态边框修复及独立定点复核通过
- [x] 最终范围回归、类型、构建和契约检查
- [ ] 提交PR合并、清理本树/实例、更新main

## 验证

- 专用PG：pace-best-practice-pg，127.0.0.1:64068；Redis：pace-best-practice-redis，127.0.0.1:64070/9。未读主.env或改共享账号。
- DB红绿：4700chunks旧PG协议失败→全部返回；分支第二批失败旧branch1/messages500→0/0，来源501条和session状态保持。
- Query红绿：输入a/ab/abc旧3请求→1；文件页原首屏1请求→0，切files后1；limit10/20缓存隔离；清空空态旧误报→恢复正确。
- 主会话最终隔离后端：15文件212项通过，0失败；含API鉴权与数据库原子性范围，无FSTWRN004。
- Web最终全量：75文件727项通过，0失败；Toggle宽度修复后已复跑全量和格式检查。
- 7包typecheck、全仓build、focus/contract通过；52文件错误级Biome通过，既有chunk体积和jsdom navigation提示保留。
- 独立review：DB79项，API47+62项，最终整体web727、API/DB65及integrity/branch12通过；最终整体指出唯一Toggle宽度缺口，未以测试绿覆盖它。
- 浏览器Slider：内部range为activeElement，thumb仅2px#8a8a8a环、透明边框，input outline:none；hover/active相同。临时服务和浏览器space均已关闭。

## 限制与下一步

实现、整体独立评审及最后Toggle修复定点复核均通过，无剩余阻断。按既有授权正常fetch核基线、提交推送创建PR并合并；确认merge和工作区干净后清理，main快进。实际结果以GitHub/Git状态为准。

未运行完整产品E2E、真实模型/SDK任务或真实读屏/强制高对比验收；不宣称端到端性能倍数。测试自动生成的.vitest报告只恢复本树产物，主checkout原差异保留。
