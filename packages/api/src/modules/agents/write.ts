import type { repo } from '@agentport/db';
import type { AgentInput, AgentPatch } from '@agentport/shared';

type AgentConfig = Omit<
  AgentInput,
  'slug' | 'serverIds' | 'skillIds' | 'subAgentIds' | 'pluginBindings'
>;

export function toAgentConfigValues(input: AgentConfig) {
  return {
    name: input.name,
    role: input.role,
    description: input.description,
    model: input.model,
    systemPromptMd: input.systemPrompt,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    permissionMode: input.permissionMode,
    uiFormat: input.uiFormat,
    effort: input.effort ?? null,
    enabled: input.enabled,
    maxTurns: input.maxTurns,
    maxBudgetUsd: String(input.maxBudgetUsd),
    timeoutMs: input.timeoutMs,
    runtimeEnvironmentId: input.runtimeEnvironmentId,
  };
}

export function toAgentPatch(
  input: { [K in keyof AgentPatch]?: AgentPatch[K] | undefined },
): Partial<repo.agents.AgentWrite> {
  const patch: Partial<repo.agents.AgentWrite> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.role !== undefined) patch.role = input.role;
  if (input.description !== undefined) patch.description = input.description;
  if (input.model !== undefined) patch.model = input.model;
  if (input.systemPrompt !== undefined) patch.systemPromptMd = input.systemPrompt;
  if (input.allowedTools !== undefined) patch.allowedTools = input.allowedTools;
  if (input.disallowedTools !== undefined) patch.disallowedTools = input.disallowedTools;
  if (input.permissionMode !== undefined) patch.permissionMode = input.permissionMode;
  if (input.uiFormat !== undefined) patch.uiFormat = input.uiFormat;
  if (input.effort !== undefined) patch.effort = input.effort;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.maxTurns !== undefined) patch.maxTurns = input.maxTurns;
  if (input.maxBudgetUsd !== undefined) patch.maxBudgetUsd = String(input.maxBudgetUsd);
  if (input.timeoutMs !== undefined) patch.timeoutMs = input.timeoutMs;
  if (input.runtimeEnvironmentId !== undefined)
    patch.runtimeEnvironmentId = input.runtimeEnvironmentId;
  return patch;
}
