import { CONFIGURABLE_DISALLOWED_TOOLS, DEFAULT_DISALLOWED_TOOLS } from '@agentport/shared';

const blockedAllowedTools = new Set(
  DEFAULT_DISALLOWED_TOOLS.filter((tool) => !CONFIGURABLE_DISALLOWED_TOOLS.includes(tool)),
);
export function unsupportedAllowedTool(tools: string[]): string | undefined {
  const tool = tools.find((rule) => blockedAllowedTools.has(rule.split('(')[0]?.trim() ?? rule));
  return tool === undefined
    ? undefined
    : `allowedTools 中的「${tool}」被运行时固定禁用，无法放行；请移除该项`;
}
