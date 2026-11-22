import { OPENUI_PROMPT_OPTIONS } from './meta.js';
import type { OpenUiToolDescriptor } from './protocol.js';

export * from './definitions.js';
export * from './kit.js';
export * from './meta.js';
export * from './protocol.js';
export * from './segment.js';

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
