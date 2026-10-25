import type { OpenUiKit } from '@agentport/shared';
import { createOpenUiDefinitions, openUiPromptOptions } from '@agentport/shared';
import {
  action,
  type ComponentRenderer,
  createLibrary,
  type DefinedComponent,
  defineComponent,
  type Library,
  reactive,
} from '@openuidev/react-lang';
import { OPENUI_RENDERERS } from './components/index.js';

/**
 * 浏览器侧的完整组件库：契约来自 shared 的真实 Zod（与服务端提示词同源），
 * 这里注入 react-lang 的三个原语和项目自己的 shadcn 实现，模块级构建一次。
 *
 * `openui:spec` 从这个文件的 `library` 导出生成服务端 spec；
 * 两者不一致时，模型签名与实际渲染就会错位。
 */
// 项目渲染器的 props 各自声明；官方 ComponentRenderProps 是协变的，
// 用 never 表达「任意渲染器都能放进这个库」。
type AnyRenderer = ComponentRenderer<never>;

const kit: OpenUiKit<AnyRenderer> = { defineComponent, action, reactive };
const renderers = OPENUI_RENDERERS as Record<string, AnyRenderer>;
const definitions = createOpenUiDefinitions(kit, renderers);

// createLibrary 的签名固定 `ComponentRenderer<any>`；渲染器参数类型是反变的，
// 只有在这一处边界需要收窄，组件定义本身仍是真实的 Zod 对象。
export const library: Library = createLibrary({
  root: definitions.root,
  components: definitions.components as DefinedComponent[],
  componentGroups: definitions.componentGroups,
});

/** 提示词示例与规则（官方原文 + 平台的 inline/edit 模式），随 spec 一起生成。 */
export const promptOptions = openUiPromptOptions();

/** 兼容旧导出名；同一实例，不要另行 createLibrary。 */
export const openUiLibrary = library;
