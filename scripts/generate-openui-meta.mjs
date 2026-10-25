// 从已安装的官方 @openuidev/react-ui 抽取「非 schema」的元数据：
// 组件名與注册顺序、官方描述、12 个分组、提示词示例与规则。
//
// 组件契约本身以 definitions.ts 的真实 Zod 为唯一来源；这里只搬官方文案，
// 避免在仓库里手抄 5 个示例和 42 条规则后与上游漂移。
//
// 用法：pnpm openui:meta（pnpm openui:spec 会先跑它）
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openuiChatComponentGroups,
  openuiChatLibrary,
  openuiChatPromptOptions,
} from '@openuidev/react-ui/genui-lib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = openuiChatLibrary.toSpec();
// 顺序即注册顺序：组件表、$defs 与提示词都按它排列，不能排序。
const names = Object.keys(spec.components);
const descriptions = Object.fromEntries(
  names.map((name) => [name, spec.components[name]?.description ?? '']),
);

const componentGroups = openuiChatComponentGroups.map((group) => ({
  name: group.name,
  components: [...group.components],
  ...(group.notes === undefined ? {} : { notes: [...group.notes] }),
}));

const source = `// 由官方 @openuidev/react-ui 的 chat 库生成，请勿手改。
// 重新生成：pnpm openui:meta（openui:spec 会先跑它）
// 组件契约的权威定义在 definitions.ts（真实 Zod）；这里只存官方文案与分组。
import type { OpenUiPromptOptions } from './protocol.js';

export const OPENUI_ROOT = ${JSON.stringify(spec.root)} as const;

/** 官方 chat 库的 ${names.length} 个组件，顺序与官方注册顺序一致。 */
export const OPENUI_COMPONENT_NAMES = ${JSON.stringify(names)} as const;
export type OpenUiComponentName = (typeof OPENUI_COMPONENT_NAMES)[number];

export const OPENUI_DESCRIPTIONS: Record<OpenUiComponentName, string> = ${JSON.stringify(
  descriptions,
  null,
  2,
)};

export const OPENUI_COMPONENT_GROUPS = ${JSON.stringify(componentGroups, null, 2)} as const;

export const OPENUI_PROMPT_OPTIONS: OpenUiPromptOptions = ${JSON.stringify(
  {
    examples: openuiChatPromptOptions.examples,
    additionalRules: openuiChatPromptOptions.additionalRules,
  },
  null,
  2,
)};
`;

const target = resolve(root, 'packages/shared/src/openui/meta.ts');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, source);
console.log(`wrote ${target} (${names.length} components, ${componentGroups.length} groups)`);
