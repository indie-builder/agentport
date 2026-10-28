# OpenUI 升级手册

> 目标：OpenUI 发新版时，用最小改动、可验证的步骤完成升级，而不是靠记忆改代码。
> 当前基线见 `docs/tasks/openui-integration.md`；行为复核与修复进展见 `docs/tasks/openui-integration-fixes.md`。

## 定义来源（先看这张图再动手）

```
packages/shared/src/openui/definitions.ts   真实 Zod 契约（唯一手工维护的组件定义）
        │  createOpenUiDefinitions(kit, renderers)
        ├─▶ packages/web/src/openui/library.tsx   注入 react-lang 原语 + shadcn 渲染器
        │        │  官方 CLI：pnpm openui:spec
        │        ▼
        │   packages/core/src/generated/openui.spec.json   提交进仓库的 LibrarySpec
        │        │
        │        ▼
        └─▶ packages/core/src/openui-prompt.ts     只读 spec 生成系统提示词（构建期不调用 web）
```

- `definitions.ts` 是**每个字段照抄官方源码**的手写 Zod；不是从 JSON Schema 反编译。
  反编译会丢 `default`、`min(2)`、`z.record` 的值类型、`.refine` 语义与 `reactive()` 绑定标记。
- `meta.ts`（组件名/描述/12 分组/提示词示例与 40 条规则）由 `pnpm openui:meta` 从官方包抽取。
- `openui.spec.json` 由官方 CLI 从真实 web 库生成，**提交进 git**；主构建只读。
- 只有 `library.tsx` 和 `definitions.ts` 接触官方契约；core 只接触生成物。

## 需要看的地方（按耦合度排序）

| 文件 | 依赖 | 升级时关注 |
|---|---|---|
| `packages/shared/src/openui/definitions.ts` | `zod` | 官方组件的字段顺序/default/枚举/`reactive` 是否变化 |
| `packages/web/src/openui/library.tsx` | `@openuidev/react-lang` | `defineComponent`/`action`/`reactive` 三个原语签名 |
| `packages/web/src/openui/components/**` | `@openuidev/react-lang` hooks | `useTriggerAction`、`useStateField`、`useIsStreaming`、`useFormValidation`、`ACTION_STEPS` |
| `packages/core/src/openui-response.ts` | `@openuidev/lang-core` | `createParser`、`mergeStatements`、`ParseResult.meta` 字段 |
| `packages/core/src/openui-prompt.ts` | `@openuidev/lang-core` | `generateSystemPrompt({library, promptOptions})` 形状 |
| `packages/shared/src/openui/segment.ts` | — | 围栏语法 `` ```openui-lang `` 是否变化 |

## 升级步骤

0. **先跑两个自检**：`pnpm openui:check`（契约）与 `pnpm openui:audit`（行为证据缺口）。
   - `openui:check` 证明真实 library、现场重生成的 spec、官方 schema/default/refine/reactive 与兼容范围一致，**不证明 UI 交互等价**。
   - `openui:audit` 输出 behavior / render / nested（可交互但尚未登记证据）/ missing 四类组件数；缺口本身不判失败，比较时须用同一范围（同一登记口径与同一批组件），既有范围**不应上升**；新增组件或能力可以带来明确登记的新缺口，写进记录即可，不算回归。数字下降才说明行为验证在收敛。
   - 升级后两条各再跑一次，从具体失败和缺口变化定位影响范围。
   - 再跑差分渲染测试，检查**已选场景与归一量**是否出现新分歧（不是覆盖全部交互的保证）：
     `pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/openui-renderer-parity.test.ts`
   - 该测试里 Range 展示用例分别使用官方 `Date` 快照与本地 ISO 字符串快照，这是唯一一处两端输入形状不同；其余用例共用同一份 `initialState`。
1. **读官方变更**：https://github.com/thesysdev/openui 的 release/CHANGELOG；涉及 Lang 语法、组件签名、promptOptions 时同步看 https://www.openui.com/docs。
2. **按兼容声明选择升级包**（本项目锁精确版本）。下列是各包的更新命令，只有本次确需变更的包才执行：

   ```bash
   pnpm add -Dw @openuidev/react-ui@<新版本> @openuidev/cli@<新版本>
   pnpm --filter @agentport/core add @openuidev/lang-core@<新版本>
   pnpm --filter @agentport/web add @openuidev/react-lang@<新版本>
   ```

   `react-ui`（生成期）与 `react-lang`（运行期）版本号不同步是上游常态；
   `openui:check` 只核对 `react-ui` 声明的 peer 范围覆盖实装 `react-lang`，
   **不要求两个版本号相等**。`lang-core` 与 `react-lang` 是同版本运行时对。
3. **同步 `definitions.ts`**：对照上游 `node_modules/@openuidev/react-ui/src/genui-lib/**/schema.ts`
   逐组件改 Zod（字段顺序、default、`.min()`、`.refine`、`reactive()`）。
   新增组件直接加；删除组件前确认历史消息不依赖它（保存储的程序按位置传参）。
4. **重新生成**：

   ```bash
   pnpm openui:spec     # meta.ts + official CLI → core/src/generated/openui.spec.json
   ```

5. **看差异**：

   ```bash
   pnpm openui:check
   pnpm exec vitest run packages/core/test/openui-library.test.ts packages/core/test/openui-parse-parity.test.ts
   ```

   这两条会精确指出：哪个组件签名漂了、哪个默认值/约束/record 类型/refine 丢了、
   解析行为与官方是否一致（不是只看 schema 文本）。它们仍只覆盖契约与解析，不覆盖本地渲染交互。
6. **补 web 实现与回归**：`packages/web/test/openui-renderer.test.ts` 要求每个组件都有渲染实现；
   `packages/web/test/openui-component-coverage.test.ts` 用最小样例点名缺失组件，并把字段多、
   需独立用例的组件（如 EditableTable、DatePicker）登记进豁免清单。**样例 + 明确豁免登记只是升级护栏，
   不等于交互等价**；豁免项必须有真实专项测试，否则等于没验证。本轮的表格与表单专项为
   `openui-editable-table.test.ts`、`openui-form-fixes.test.ts`，已通过专项验证及独立 Opus 复核，
   证据见 `docs/tasks/openui-integration-fixes.md`。复杂交互至少覆盖：
   - 表格：空表流式中补入行、state hydration / 命名空间恢复、编辑后 Save → 卸载 → reload 得到保存值；
   - DatePicker：日历点击能打开，single/range 在正负时区下按本地年月日往返；
   - CheckBoxGroup / SwitchGroup：默认项与改动项聚合后，显示值与提交载荷一致；
   - message：无效程序 → 有效程序能恢复渲染，正常表单不因该路径重挂。
7. **更新本手册的基线**与 `docs/tasks/openui-integration.md` 的版本记录；
   本轮行为修复的证据见 `docs/tasks/openui-integration-fixes.md`：实现、范围验证与独立复核已完成，
   改动仍未提交、未合入 main。

## `openui:check` 检查什么

任何一项失败即非零退出：

1. 提交的 spec 与「用官方 CLI 从当前 web 库现场重生成」的结果一致（漏跑 `openui:spec` 会红）；
2. 组件名与注册顺序和官方 chat 库一致；真正决定线格式位置参数的是各组件 props 的字段顺序，必须与签名同时核对；
3. 每个组件的签名与官方一致；
4. 每个组件的描述与官方一致；
5. 官方 12 个 `componentGroups` 原样保留；
6. JSON Schema（含 default/minItems/record 值类型）与官方一致；refine 与 reactive 另由真实行为测试证明；
7. 官方 5 个提示词示例与 40 条 `additionalRules` 原样保留；
8. shared/core 产物与当前源码一致，避免测试入口读旧 dist；
9. 执行默认值、约束、EntityList refine、reactive字段和Query重跑的定向行为对照；
10. `react-ui` 的 peer 范围覆盖实装 `react-lang`；
11. 当前项目锁定的 `lang-core` 与 `react-lang` 运行时版本一致。

上述检查是**契约与生成物对照**：`openui:check` 不进入浏览器交互，`react-lang` 的渲染、表格流式、
日历打开等本地行为不在其证明范围，需由第 6 步的 web 专项测试与实屏验收分别确认。

负向验证已执行：EntityList refine置空、移除Input.value reactive、Text.size默认sm改md，分别使真实行为或fresh spec检查失败，恢复后全过。JSON相等不能单独证明refine/reactive。

## 兼容范围（写进手册的事实）

- **官方声明的兼容范围**是 `react-ui` 的 peer：`@openuidev/react-lang >=1.0.0 <2.0.0`。
  本仓库锁定的具体版本是自身策略，不是官方要求。
- 生成物必须与**已安装**的 `react-ui`/`react-lang` 对应；不对应就是「提示词里的组件集」
  与「运行时能渲染的组件集」错位——这是最隐蔽的线上故障。
- 项目不接入 Gateway / Autofix：它们是托管推理与自动纠错选项，不是 Renderer 的前提。

## 已知风险点

| 风险 | 现状 | 升级时怎么做 |
|---|---|---|
| 解析器会提取**任意**三反引号围栏 | shared 的 `segment.ts` 只按 `openui-lang` 精确分段 | 若官方改为只认该标签，可简化分段器，但先加测试 |
| 动作事件字段（`formState`/`formName`/`context`） | 依赖渲染器自动附带；shared `protocol.ts` 定义唯一形状 | 检查 `triggerAction` 是否改名或改结构 |
| `editMode` 合并语义 | core 用官方 `mergeStatements`；root 不可达语句会被移除 | 若语义变化，先改 `openui-response.test.ts` |
| `reactive` 字段 | 真实 Zod 里用 `K.reactive(...)` 标记 | 新版若要求新原语，改 `kit.ts` 的接口再改 web 注入 |
| 渲染器 devtools | react-lang 会自动挂 devtools（jsdelivr），CSP 下失败被包内 catch | 若强制加载，需要在 web 侧关闭 |
| 生成物提交策略 | spec 提交进 git，构建只读 | 官方示例可能 gitignore；本项目按「可重生成 + check 校验」提交 |
| 组件覆盖豁免清单 | `openui-component-coverage.test.ts` 的样例与豁免登记只是升级护栏，历史上豁免项没有对应专项测试 | 新增或保留豁免时同步补真实专项，或在任务记录标注「待验证」 |

## 不建议做的事

- 不要手改 `packages/core/src/generated/openui.spec.json`（会被 `pnpm openui:spec` 覆盖，check 会红）。
- 不要从官方 JSON Schema 反编译 Zod（丢失语义，已试过）。
- 不要绕过依赖声明单独升级：按实际 dependency/peer 范围判断需要联动的包，并执行 spec 与行为检查；官方没有要求所有包同时更新。
- 不要为「跟上新版」一次性重写渲染器；先让 `openui:check` 与对照测试告诉你差在哪。
- 不要把 `@openuidev/react-ui` 引入运行时（它带 Radix 与自有视觉层，违反项目技术栈）；
  它只作为根目录 devDependency 用于生成。
