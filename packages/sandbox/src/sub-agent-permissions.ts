import type { HookCallback, PreToolUseHookSpecificOutput } from '@anthropic-ai/claude-agent-sdk';

interface SubAgentBinding {
  servers: Set<string>;
  skills: Set<string>;
}

export interface SubAgentBoundary {
  /** 主会话自己绑定的 server；工作区 .mcp.json 是父 + 启用子级的并集。 */
  servers: Set<string>;
  skills: Set<string>;
  pluginSkills?: Set<string>;
  subAgents: Map<string, SubAgentBinding>;
}

/** MCP 工具名 `mcp__<server>__<tool>`；server 名本身可能含 `__`，取最长匹配前缀。 */
function serverOf(toolName: string, known: Set<string>): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  let match: string | null = null;
  for (const server of known) {
    if (
      toolName.startsWith(`mcp__${server}__`) &&
      (match === null || server.length > match.length)
    ) {
      match = server;
    }
  }
  return match;
}

function skillOf(toolInput: unknown): string | null {
  if (typeof toolInput !== 'object' || toolInput === null) return null;
  const value = (toolInput as { skill?: unknown }).skill;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^\//, '');
  return normalized.length > 0 ? normalized : null;
}

function allowedSkill(skill: string, allowed: Set<string>): boolean {
  if (allowed.has(skill)) return true;
  const colon = skill.indexOf(':');
  return colon > 0 && allowed.has(skill.slice(0, colon));
}

function isPluginSkill(skill: string, pluginSkills: Set<string> | undefined): boolean {
  if (pluginSkills === undefined) return false;
  const colon = skill.indexOf(':');
  if (colon <= 0) return false;
  const plugin = skill.slice(0, colon);
  for (const name of pluginSkills) {
    if (name.startsWith(`${plugin}:`)) return true;
  }
  return false;
}

export function createSubAgentBoundaryHook(boundary: SubAgentBoundary): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};

    const output: PreToolUseHookSpecificOutput = { hookEventName: 'PreToolUse' };
    const deny = (reason: string) => ({
      hookSpecificOutput: {
        ...output,
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    });
    const allow = () => ({
      hookSpecificOutput: { ...output, permissionDecision: 'allow' },
    });

    const subAgent =
      input.agent_id === undefined ? null : boundary.subAgents.get(input.agent_type ?? '');
    if (input.agent_id !== undefined && subAgent === undefined) return {};

    if (input.tool_name === 'Skill') {
      const skill = skillOf(input.tool_input);
      if (skill === null) return {};
      if (isPluginSkill(skill, boundary.pluginSkills)) {
        return subAgent === null
          ? allow()
          : deny(`Skill ${skill} comes from a plugin, which is not bound to sub-agents.`);
      }
      const allowed = subAgent?.skills ?? boundary.skills;
      return allowedSkill(skill, allowed)
        ? allow()
        : deny(`Skill ${skill} is not bound to this agent.`);
    }

    const server = serverOf(
      input.tool_name,
      new Set([
        ...boundary.servers,
        ...[...boundary.subAgents.values()].flatMap((sub) => [...sub.servers]),
      ]),
    );
    if (server === null) return {};
    const allowedServers = subAgent?.servers ?? boundary.servers;
    return allowedServers.has(server)
      ? allow()
      : deny(`MCP server ${server} is not bound to this agent.`);
  };
}
