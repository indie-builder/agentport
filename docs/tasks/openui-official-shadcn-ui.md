# OpenUI UI层采用官方shadcn实现基线

## 目标

用户授权：优先复用OpenUI官方shadcn示例的布局/组件组合与流式呈现方式，未覆盖的84组件参考官方chat组件；底层继续Base UI、现有设计令牌与完整组件契约。改善实际呈现效果而非只让协议/组件名一致。

## 基线与范围

- 沿用worktree-openui-integration，HEAD 72a4db49413ec46e36000f9630c06e33196df183；此前OpenUI未提交差异原地保留，不还原。
- 允许：web的Markdown、OpenUI视觉组件、渲染器/消息流呈现、必要样式与对应测试、文档。
- 不改SDK/后端/存储/API/84组件schema/审批和动作协议；不引Radix，不切换设计预设，不装第二图表或Markdown库。
- 未授权commit/push/merge；成果仅在当前worktree。

## 当前有效决定

1. 官方shadcn示例是源码基线，不是独立adapter包；取其组件组合/内容层级，Radix底层替为项目已有Base UI。
2. 官方示例不覆盖全部chat组件，未覆盖的卡片块/指标/媒体使用已安装react-ui0.18.1对应实现作为语义来源，不手写简化替代。
3. 项目固定灰度主题、728px消息轴线、字体/圆角/焦点token保持；官方Cloud页面不是OSS逐像素承诺。
4. Markdown与OpenUI流式状态共享真实isStreaming，避免plain p切到富文本导致重排；不造解析器/滚动管理器。
5. 完整UI只调整render映射，不改已通过的协议功能；容器变化按消息实际宽度响应而非viewport。
6. 同一内容/程序对照官方与本地，验生成中/完成/错误/窄屏，最终Opus独立review。

## 开始时发现的差异（历史基线）

- OverviewCard bottom是ElementNode，当前直接读value丢指标；应renderNode(bottom)。
- TextContent字号被内部Markdown固定text-md覆盖，Text普通字重过重。
- 卡片块sm:grid-cols-2按viewport，窄消息容器仍两列；奇数末项未跨满。
- 图片固定160px裁切，尺寸未提前占位。
- 主/子图统一220px，轴宽固定，多系列灰度降到8%并循环。
- Markdown未接真实streaming且纯文/富文渲染树切换。
- Tooltip在content-visibility绘制边界内可能裁切，需实屏证据再改。

## 官方参考

- https://www.openui.com/integrations/shadcn-ui
- https://www.openui.com/docs/openui-lang/examples/design-systems/shadcn
- https://github.com/thesysdev/openui/tree/main/examples/design-systems/shadcn
- https://www.openui.com/docs/openui-lang/renderer
- 本地@openuidev/react-ui0.18.1的genui-lib/components源码

## 步骤

- [x] Opus冻结UI共享契约和并行文件边界
- [x] Sonnet按边界实施、针对非平凡行为先红绿
- [x] 同内容官方/本地截图和测量、生成中/窄屏/错误/键盘验证（官方SSR图形限制见证据）
- [x] Opus独立评审，修复并复核
- [x] web测试/typecheck/build/speccheck和必要回归

## 本轮验收必须证明

| 场景 | 通过条件 |
|---|---|
| 指标与卡片 | Overview值/子说明/趋势可见，0值不消失；2/3/5卡末项布局正确；复合卡footer动作不冒泡 |
| 实际容器 | viewport不变只收窄内容，440px一列/560px两列；320/390页面不横滚 |
| 排版 | 五种TextContent的p/列表/粗体实际字号继承，Text400/Bold600；large正文下heading不倒挂 |
| 流式 | partial→final外层根稳定，Streamdown内部代码块模式切换可重挂；拷贝禁用/恢复；10k长文逐事件回放有帧耗时数据，不假定天然batch |
| 图表 | 主256/子192且显式height优先；缺失值不是0；多系列非透明度弱线；数据视图/tooltip完整可读 |
| 媒体 | 3:2 contain与naturalblock、加载/失败/换源、长alt可达 |
| 表单 | 多段同名label各控自己；range焦点节点关联hint/error；group invalid/disabled出现/解除一致 |
| 交互 | Carousel/Tabs/Accordion键盘、错误态可恢复、reduced-motion；旧动作/状态/审批回归不破坏 |

## 冻结UI契约与分工

- Markdown：`text/streaming=false/presentation=body|inherit`（可加className）；默认15/26，inherit继承组件字号/字重/颜色。同一Streamdown树，mode与isAnimating真实接线，animated=false。
- 卡片：Overview底部由Metric节点自己renderNode，普通Text400/Bold600；容器480px以下单列，以上两列，3/5张最后一张跨满，responsive=false不改其原义。复合卡已有height图表按官方节点props传192px，根图默认256px。
- 图表：保持9类型；轴/标签按实际容器和类别数量处理，不造ResizeObserver；Bar最大24px/4px数据端圆角、线2px；无数据不伪零；灰度配线型/纹理和图例/完整数据视图；Tooltip使用原生portal，不取消消息绘制优化。
- 图片：Image默认3:2预留、ImageBlock原图比例，小图按schema size/layout，不统一h40裁切；Large bold生效，错误alt不消失。
- A独占Markdown/openui-message及content文字函数；媒体代理独占同文件图片函数（局部edit不覆盖并行）；B独占layout/data/shared；C独占charts及必要ui/chart。
- 同程序对照官方；宽屏/320/390/内容区拖窄、partial→final、错误/图片失败/键盘/reduced motion均有证据后再判完成。

## 已收到的实现与待复核

- 媒体一路已返回11项定向测试/扩大82项报告通过，但实现把ImageBlock统一3:2 cover，与最终合同不符，已派跟进：Image默认contain，ImageBlock自然比例；此项不按旧测试报告直接接受。
- 官方Table示例是columns+rows，本项目chat Table是列式Col.data；只采用组合/数值对齐，不改wire签名。官方Card composition/尺寸文档已读取。
- 表单另一路限定forms.tsx：复用已有FieldGroup/Field，稳定唯一id、多段同名字段不冲突，label/hint/error关联与invalid/disabled同步，保留前轮动作校验语义。
- 媒体独立Opus复核未通过：A失败→B→A重试状态、Large bold=false、长失败alt裁切3项已交回，跟进只改媒体函数不碰文字区。
- 媒体3must-fix跟进已返回，主会话独立复跑报告19/19通过：源切换key重挂、Large bold按prop、长alt完整可达；真几何待浏览器。
- Markdown A返回13项通过，接口现命名size=inherit|body（最终需与合同presentation统一）；基准长文本逐chunk解析从约0.04ms升0.73~2.19ms，总耗时明显上升，已交Opus检查真实SSE接线与Streamdown原生优化，不能先宣称无影响。
- A独立Opus复核暂不通过：真实逐SSE更新下长段开销高，最小用React useDeferredValue在streaming调度、完成原text立即落；large正文16/H3固定15倒挂需max(1em,token)下限，接口统一presentation。已派跟进，不能用旧mock或『按帧合并』假设宣称性能通过。
- 类型汇合当前仅报charts仍引用已被B删除的seriesColor，C图表正在自包含配色，待返回后真复跑，不造shim。
- 表单UI已返回，主会话独立复跑form-ui+form-behavior13/13通过，0跳过；label/hint/error实例id接线与旧动作语义均测。
- A/B/C/表单UI仍在并行；媒体/Markdown同文件按函数边界局部编辑，避免覆盖。
- 官方文档已实际读取：shadcn card composition与--card-spacing、chart显式尺寸/accessibilityLayer/tooltip；Streamdown mode/isAnimating/animated/partial remend。

## 官方实屏基线（本轮已操作）

- ego任务空间57，实际打开官方stock-comparison只读线程，鼠标滚回首轮；截图确认5张指标为2+2+跨满末卡、标题与副标题独立层级、图表分区。
- 实测官方首标题18px/600/22.5px、指标标签14px/400/21px、末卡图标文本gap12px；这些用作结构/层级参考，项目固定字体阶梯不直接被Cloud数值覆盖。
- 官方Cloud只读线程仅为视觉参考；同程序语义对照仍用发布版OSS库，不把Cloud全部视觉等同开源shadcn示例。
- 同一份KPI/content程序已在ego p2打开官方OSS静态页：5张Snippet为2+2+末项跨满，Overview底部值/说明/趋势可见。静态页没有客户端图标/交互初始化，不能据此判图标或键盘能力。analytics SSR页也缺客户端图表测量，曲线不完整且轴标签重叠；只作组件组合/内容层级对照，不作为图形几何优劣证据。
- 官方OSS实测small/default/large分别14/16/18px、行高21/24/27px；heavy为560。项目按现有13/15/16px与400/600映射该层级，不覆盖全站令牌。

## 本地实屏结果（本轮）

- 独立API53671首次随验收器关闭并清理；修正后当前API54664，独立库oui_revision_test_15d3d671与独立Redis27766。只启API，无worker/模型调用。
- ego p3真实登录后，同程序KPI：728px轴线两张358px卡、12px间距，末卡728px。viewport固定1500，容器440px一列；560px为274+12+274、末卡560px。390/320页面overflow均0，实际卡块354/284单列。
- analytics主图256px；两张显式height140子图均140px。键盘聚焦图表ArrowRight出现6月三系列完整tooltip，实际挂BODY、fixed坐标；主图数据视图展开包含6行3系列，表格数字右齐。前三系列仅灰阶实线，后续独立图表评审需检查第二编码合同。
- content五种字号实测13/15/16/13/16px；small-heavy当前500、large-heavy600（Text/BoldText两档另验）。Image728×485.33且contain，ImageBlock728×506.26与原916×637同率；画廊237.33方形cover、轮播图contain；图片均加载且有alt。
- Tabs方向键+Enter切至明细，Accordion Enter展开对应项；Carousel Enter翻到后片并禁用Next，Previous仍可用。320px内容页面overflow0，Carousel284px；reduced-motion媒体模拟已命中，动画持续时长还需核实。
- Markdown独立Opus复核Approve，16/16定向通过；明确Streamdown切静态内部代码块会重挂、外卡根稳定。真实SSE回放结果见本节后续条目。
- 320px图表实测：主图284×256、子图260×140，键盘tooltip挂BODY，矩形x113–241/y365–449未越界；明细表容器宽284/scrollWidth284。普通tooltip通过不代表长名边界通过；独立评审另报3项（前三series无第二编码、SingleStackedBar140、长名tooltip可能越界）已派跟进。
- reduced-motion模式稳定后`document.getAnimations()`为空。手动使普通Image加载404，实际控件移除坏img并完整显示alt；脚本等待『图片加载失败』固定文案超时，随后读取实际DOM确认是纯alt呈现，未改产品去迎合探针。
- 合成消息user/assistant同一INSERT导致createdAt相同，API按ID排序后assistant在前；当前隔离fixture已把user时间前移1秒修正验证材料，不改产品API或存储语义。
- 固定carousel实测：small item/卡面均280px，Overview宽容器240px、390页面200px；轨道gap12、margin0，页面overflow0。自定义gap的双列公式已改为同一CSS变量，避免写死半gap。
- 长流生产SSE回放两轮均500事件/11056字符、约10秒发完，终态119个标题完整，刷新前后正文相同。固定前台第二轮有效窗口0.5–10s：282帧、中位33.3ms、P95 41.6ms、最大50.7ms。全程PerformanceObserver另见201/65/230/241ms长任务，尚无归因，不等同无阻塞；空闲浏览器RAF约1008ms节流，不能把此环境宣称稳定60fps。
- 第一轮采样P95约42.4ms/max1008.4ms；第二轮固定前台后不再出现该长帧。第二轮等待发送按钮可用超时是空输入disabled的探针条件错误，终态实际已到；保留有效流式窗口数据，不按该超时判产品失败。
- large正文实测16px，内H3映射h4也是16px，标题不小于正文。
- 受控渐进OpenUI（完整user前置+浏览器发开始信号）：partial仅1张卡、最终8张，均无root源码，首卡所在块根sameRoot=true；截图`.tmp/oui-ui-card-partial-controlled.png`。早先无user前置的验收会话停在欢迎态，属fixture不完整，已修验证材料。
- 表单Opus限定复核Approve，7/7通过。实屏两段同名表单：第二段Enter保存后，各组及真实range input均aria-invalid=true，range-describedby同时含hint/error且label正确；第一段range只含hint无invalid。Space切第二段邮件开关仅该实例true→false，第一段仍true。键盘将第二段预算30调至60后invalid与error关联解除，保hint及range焦点。
- 自定义gap20px的盒模型实测：728px轨道两张卡均354px，354+20+354=728，避免旧写死半gap偏差。此项验证CSS公式，样例为页面临时style模拟，不冒充wire程序提供了未定义的新字段。
- Text/BoldText实测：本月营收label400、BoldText数值128.4万600、普通Text数值¥1,024为400。
- 浅色背景#fdfdfd上5档图表线条对比度已用Chromium实际computed stroke和canvas像素换算测得17.62/9.43/5.64/5.01/3.39:1；项目只有亮色主题。
- 图表3项修正后的新构建实测：SingleStacked/Line frame均256；11条曲线dash为实线、3 3至12 3，前三条及第11条不再同型。analytics仍256/140/140，长名320px提示左锚矩形53–312、右侧锚24–312，均保8px右边距。
- 最后一轮窄修新构建：第11图例viewBox宽15、dash12+gap3完整缩放到12px图标；填充图例共用patternStep且id由useId隔离。320px视口/200px图框，tooltip矩形8–156，min-width0/max-width148，无溢出。中间null测试已补，最终Opus复核待返回。
- 完整回归的唯一失败已定位为测试矛盾：实现Line dot=false，测试却要求2个静态marker；已改断言无静态点，同时保留path仅1M/1L、缺失月份表格为“—”等真实缺口验证，不改数据语义。

## 下一步

用户已明确授权“提交PR并合并”。OpenUI成果已提交667e984；origin/main d9c5a45插件能力已整合，共享/执行、Markdown与迁移独立Opus均Approve。合并后7包typecheck、build、web57文件589项、openui:check11项及focus/contract通过。main0033/0034原样保留，新0035_pretty_tana_nile空库/main升级路径独立复跑PASS。旧固定库测试已改唯一隔离库，最终完整回归199文件1645/1645、0失败0跳过；最后失败清理补丁正在定向验证与复核。通过后提交合并记录、推送、建PR并合并，不等待CI、不监控。

## 最终结论与验证

- 最终Opus对图例周期/填充纹理、tooltip最小宽度与中间null断线的限定复核Approve；前序卡片、排版、媒体、表单评审也通过。评审筛选运行的跳过项不计全套通过证据。
- 最终前端：`pnpm test:web --reporter=json --outputFile=.tmp/openui-ui-web-delivery-results.json`：52文件、525/525，0失败0跳过。包括最后新增中间null测试与图例/tooltip修正。
- 最后改动前的完整隔离套件181文件1500/1500；最后改动只触及图表web实现/测试，随后跑上述完整前端525项。没有把此前整套结果冒充最后源码重跑。
- 最终 `pnpm --filter @agentport/web build` + `typecheck` exit0；全部7包typecheck此前通过。`openui:check`11项、focus/contract、定向biome、`git diff --check`均通过。
- 验收预览已关闭，独立库oui_revision_test_15d3d671和Redis容器oui-revision-redis-088faec6已删除；ego空间57已finish。未启停共享服务。截图/回放和JSON证据留在忽略的`.tmp/`，产品中无scratch/bench测试。
- 无提交授权：未commit/push/merge，成果尚未合入main。
- 已知边界：Streamdown模式切换会重挂内部代码块；本轮Chromium流式采样存在环境节流和未归因长任务，不承诺稳定60fps；未做Safari/Firefox或真实读屏软件验证。Carousel Overview的30rem恰好边界使用Tailwind `<30rem`（官方`≤30rem`），常规宽/窄几何已测。

## 历次验证明细

以下保留阶段失败及修复记录；最终状态以上节为准：

- `node .tmp/oui-ui-fixtures-check.mjs`：3份同程序本地/官方解析自检通过，0项不符。
- `pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/openui-card-layout-ui.test.ts packages/web/test/openui-media-ui.test.ts --reporter=json --outputFile=.tmp/openui-ui-card-media-results.json`：28/28，0失败0跳过。卡片独立评审另发现测试未覆盖的两项，修复后需复跑。
- `pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/markdown.test.ts packages/web/test/openui-content-markdown.test.ts packages/web/test/openui-form-ui.test.ts packages/web/test/openui-form-behavior.test.ts --reporter=json --outputFile=.tmp/openui-ui-text-form-results.json`：29/29，0失败0跳过；排版/表单跟进尚在收尾，最终需对应复核。
- `pnpm lint:focus` / `pnpm lint:contract`：通过。
- `pnpm openui:check`：11项全部PASS，84组件的签名/顺序/schema/元数据/原生行为与官方一致。
- `pnpm --filter @agentport/web build`：exit0（用于当前同内容预览；后续源码改变需更新构建）。
- `pnpm test:web --reporter=json --outputFile=.tmp/openui-ui-web-final-results.json`：52文件、522/522，0失败0跳过（已无scratch/bench测试；图表最后3项修正后仍须对应复跑）。
- `pnpm typecheck`：全部7包exit0。
- 动作/状态保存/断流恢复5文件定向回归：76/76，0失败0跳过（`.tmp/openui-ui-interaction-final.json`）；最终轮播13/13（`.tmp/openui-ui-carousel-gap-final.json`）。
- `git diff --check`：exit0。
- `pnpm --filter @agentport/web typecheck`：最新exit0，旧seriesColor中间态已消除。
- `pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/openui-form-ui.test.ts packages/web/test/openui-form-behavior.test.ts packages/web/test/openui-card-layout-ui.test.ts --reporter=json --outputFile=.tmp/openui-ui-reviewed-results.json`：28/28，0失败0跳过。
- `pnpm exec vitest run packages/core/test/openui-library.test.ts packages/core/test/openui-parse-parity.test.ts packages/core/test/openui-prompt.test.ts packages/core/test/openui-reactive-query.test.ts packages/core/test/openui-response.test.ts packages/core/test/openui-segment.test.ts packages/core/test/openui-upgrade-guard.test.ts packages/shared/test/chat-events.test.ts --reporter=json --outputFile=.tmp/openui-ui-protocol-results.json`：8文件、57/57，0失败0跳过。
- 独立UI环境首次启动因一次性fixture的exit0被当成失败而关闭；该轮临时库/Redis均已清理，验收启动器已交限定修复。

完整隔离回归：`node .tmp/oui-isolated-env.mjs -- pnpm test --reporter=json --outputFile=.tmp/openui-ui-all-results.json`：181文件、1498项，1497通过、1失败、0跳过；唯一失败为chart-ui缺失值断线测试在断言时无curve（预期2，实得0），需在最终图表汇合后定位渲染等待并复跑。不能按全绿交付。该轮隔离库/Redis由启动器收尾。

完整隔离复跑：`node .tmp/oui-isolated-env.mjs -- pnpm test --reporter=json --outputFile=.tmp/openui-ui-all-final-results.json`：181文件、1500/1500，0失败0跳过，exit0。测试库oui_revision_test_4dc557de及Redis容器oui-revision-redis-7606f743已由启动器删除。随后最终独立review仍发现图例缩放/纹理匹配、tooltip min-width冲突、中间缺值断线测试3项需窄修，修后按受影响范围复验。

此前1433测试通过只作为前置基础，不能证明本轮UI优化完成。
