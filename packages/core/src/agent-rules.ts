import { DEFAULT_DISALLOWED_TOOLS } from './workspace.js';

/**
 * 运行时安全规则：创建、PATCH、单文件导入三个入口共用。
 * 导入走 parseAgentMd（core），无法依赖 API 层，所以规则放在这里。
 */

/** default/acceptEdits 直接透传 SDK；auto 依赖无法审计的模型分类器，暂不开放。 */
const unsupportedPermissionModes = new Set(['auto']);

export function unsupportedPermissionMode(mode: string | undefined): string | undefined {
  return mode !== undefined && unsupportedPermissionModes.has(mode)
    ? `permissionMode "${mode}" 依赖模型分类器，平台暂不开放；可用 dontAsk、plan、default、acceptEdits`
    : undefined;
}

// 这些默认禁用的工具可以按智能体显式放行；其余不能通过配置解除。
const blockedAllowedTools = new Set(
  DEFAULT_DISALLOWED_TOOLS.filter(
    (tool) => !['Agent', 'TaskStop', 'ListAgents', 'SendMessage'].includes(tool),
  ),
);

export function unsupportedAllowedTool(tools: string[]): string | undefined {
  const tool = tools.find((rule) => blockedAllowedTools.has(rule.split('(')[0]?.trim() ?? rule));
  return tool === undefined
    ? undefined
    : `allowedTools 中的「${tool}」被运行时固定禁用，无法放行；请移除该项`;
}

/** 创建、PATCH、单文件导入共用：返回第一条违反运行时安全规则的字段与文案。 */
export function unsupportedAgentRuntime(input: {
  permissionMode?: string | undefined;
  allowedTools?: string[] | undefined;
}): { field: 'permissionMode' | 'allowedTools'; message: string } | undefined {
  const mode = unsupportedPermissionMode(input.permissionMode);
  if (mode) return { field: 'permissionMode', message: mode };
  const tool = unsupportedAllowedTool(input.allowedTools ?? []);
  return tool === undefined ? undefined : { field: 'allowedTools', message: tool };
}
