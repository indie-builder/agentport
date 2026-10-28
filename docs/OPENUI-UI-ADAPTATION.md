# OpenUI UI 适配的事实基线

视觉基线是 OpenUI 官方 shadcn 示例（`examples/design-systems/shadcn`）的本地源码适配，不是独立 adapter 包；示例未覆盖的组件按已安装 `@openuidev/react-ui@0.18.1` 的 genui-lib 补全，组件集合对齐官方 chat 库的 84 个。交互原语仍是 Base UI，视觉仍是本项目令牌；不引入 Radix、OpenUI 自有主题，也不改 84 个组件的字段契约。Thesys MIT 通知保留在 `packages/shared/src/openui/LICENSE`；上游 main 可能早于或晚于发布包，字段语义以已装版本为准。

上游：

- https://github.com/thesysdev/openui/tree/main/examples/design-systems/shadcn
- https://www.openui.com/docs/openui-lang/examples/design-systems/shadcn
- https://www.openui.com/integrations/shadcn-ui

## 已落地事实

| 范围 | 事实 |
|---|---|
| Markdown / TextContent / CodeBlock | `presentation` 取 `body`（15/26 阅读字号）或 `inherit`（完全沿用父级字号、字重、颜色）。`streaming` 是真实流式状态；流式中用 `useDeferredValue` 调度较重的渲染，允许跳过中间状态；终态直接渲染原 `text`。Streamdown 从 streaming 切 static 时，库内部会重挂代码块等节点，因此只保证外层渲染树稳定，不能宣称所有 DOM 恒定 |
| 卡片容器 | `CardBlockGrid` 按消息容器宽度响应：≤480px 单列、更宽两列；2/3/5 张时奇数末卡跨满。`responsive=false` 尊重原意，不改列数 |
| 卡片图高 | 复合卡内图表未显式给 height 时补 192，显式 height 优先；无容器约束的根图默认 256 |
| Carousel | 复用 `components/ui/carousel`（shadcn）。`responsive=false` 时按官方固定卡宽：small 280、medium 320、Overview 240，容器 ≤30rem 时 Overview 200；已上屏实测 |
| 媒体 | Image 按 3:2 预留并用 `object-contain` 完整容纳；ImageBlock 按原图比例渲染，不设固定终态高度；加载失败和长 alt 可完整读取。ImageText 的40px缩略图默认值是项目适配决定；官方横向有40px默认，竖排没有对应的TypeScript默认值，不能把项目行为归为「官方统一默认40」 |
| 表单 | 用官方 shadcn Field/FieldGroup 组合；range 由 Base UI `Field.Root` 的 `invalid` 把 `aria-invalid` 传到滑块内部 input。多段同名表单的 label/hint/error 关联与真实键盘已实测 |
| 图表 | 9 类图表用 Recharts 3；主图默认 256、卡内默认 192、显式 height 优先。系列从第二项起叠加虚线/纹理，图例显示相同编码；完整数据视图与 body portal 提示保留，提示按可用空间约束并允许长名称换行。中间缺值断线有真实路径回归，最终 Opus 限定复核通过，实屏与验证结果见任务记录 |

本项目只提供亮色主题（见 `styles.css`），本轮对比度与实屏结果仅覆盖这一主题。Streamdown 的内部节点重挂与浏览器采样限制见下文。

- 稳定 60fps 未验证。一次固定前台 SSE 回放（500 事件 / 11056 字符）窗口内中位 33.3ms、P95 41.6ms、最大 50.7ms，同时有 201–241ms 长任务且未归因；只能记录该窗口的表现，不能据此外推稳定帧率。
- 视觉对照只覆盖 OSS 生成式 UI，不承诺与官方 Cloud 页面逐像素一致。

## 契约一致 ≠ 本地行为正确

`pnpm openui:check` 证明的是真实 library、现场重生成的 spec 与官方 schema/default/refine/reactive 一致，**不证明渲染器行为等价**。视觉与交互要单独验：用同一份程序分别跑官方与本地，检查打开、编辑、提交、恢复和键盘。

- 日期等本地约定不来自官方统一规范，例如纯日期按 `YYYY-MM-DD` 以本地年月日读写，这是项目为避免 UTC 偏移做的适配，不是官方对所有日期组件的规定。
- `pnpm openui:audit` 把 84 个契约组件按证据分为 behavior / render / nested（嵌套组件，另有可交互但尚未登记行为证据的子集）/ missing，各类当前数量以该命令输出为准，不在文档里固化；缺口是数字不是注释。审计只读登记表，不解析测试断言，也不计算覆盖率；`openui-renderer-parity.test.ts` 用同一程序、同一份 `initialState`（Range 展示用例按两端原生快照形状各给一份）分别渲染官方 `react-ui` 与本地组件，比较归一后的文本、勾选/选中/数值与单元格值。程序与比较面由人挑选，未写到的交互不会被自动覆盖。
- **已装版本行为差异**：当前安装的官方 `DatePicker` 把 range 快照存成 `Date` 对象，本项目持久化 ISO 字符串。这是内部不透明快照、不对外兼容，本地组件正常工作；把本项目快照喂给官方组件会触发 `from.toDateString is not a function`。该描述只针对已装版本，不对将来版本作断言；差分测试同时断言两端行为，上游改法后用例翻红再重新评估。
- 表格流式/恢复、DatePicker 触发器与时区、复选/开关默认项聚合、无效程序恢复等问题的修复与验证记录见 `docs/tasks/openui-integration-fixes.md`。

## 未来上游版本的 UI 核对步骤

1. 升级依赖后跑 `pnpm openui:check`，先确认签名、默认值、分组、prompt 与 spec 一致；再按上节单独验本地交互。
2. 对照 `node_modules/@openuidev/react-ui/src/genui-lib/**` 更新本文件的上游来源映射，再改受影响的视觉实现。
3. 用同一份程序分别跑官方与本地，对照生成中、完成、错误、窄屏（320/390）、键盘和 reduced-motion。
4. 跑现有 openui 行为回归套件；不新增命令框架，也不为「跟上新版」重写渲染器。
