import {
  OPENUI_COMPONENT_GROUPS,
  OPENUI_COMPONENT_NAMES,
  OPENUI_DESCRIPTIONS,
  OPENUI_PROMPT_OPTIONS,
  OPENUI_ROOT,
} from './meta.js';
import type { OpenUiToolDescriptor } from './protocol.js';

export * from './definitions.js';
export * from './kit.js';
export * from './meta.js';
export * from './protocol.js';
export * from './segment.js';

export { OPENUI_COMPONENT_GROUPS, OPENUI_COMPONENT_NAMES, OPENUI_DESCRIPTIONS, OPENUI_ROOT };

/** 本平台追加的规则；官方规则保持不变。 */
export function openUiPromptOptions(
  input: { tools?: OpenUiToolDescriptor[]; extraRules?: string[] } = {},
): {
  inlineMode: true;
  editMode: true;
  examples: string[];
  additionalRules: string[];
  tools?: OpenUiToolDescriptor[];
} {
  const { tools, extraRules } = input;
  return {
    inlineMode: true,
    editMode: true,
    examples: [...OPENUI_PROMPT_OPTIONS.examples],
    additionalRules: [...OPENUI_PROMPT_OPTIONS.additionalRules, ...(extraRules ?? [])],
    ...(tools && tools.length > 0 ? { tools } : {}),
  };
}

/** 工具目录的稳定缓存键：名字、入参 schema 与描述任何一项变化都要重算提示词。 */
export function openUiToolsCacheKey(tools: OpenUiToolDescriptor[]): string {
  return tools
    .map(
      (tool) =>
        `${tool.name}:${tool.description}:${JSON.stringify(tool.inputSchema ?? null)}:${JSON.stringify(tool.outputSchema ?? null)}`,
    )
    .sort()
    .join('|');
}
