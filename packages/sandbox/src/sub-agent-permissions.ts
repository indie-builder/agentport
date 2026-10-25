import type { HookCallback, PreToolUseHookSpecificOutput } from '@anthropic-ai/claude-agent-sdk';

interface SubAgentBinding {
  servers: Set<string>;
  skills: Set<string>;
}

export interface SubAgentBoundary {
  /** 主会话自己绑定的 server；工作区 .mcp.json 是父 + 启用子级的并集。 */
  servers: Set<string>;
  skills: Set<string>;
  /**
   * 本次加载的插件技能全名（`<plugin>:<skill>`）。插件是会话级能力，v1 不做子级绑定：
   * 主会话可用，子智能体一律拒绝。
   */
  pluginSkills?: Set<string>;
  /** 子智能体 slug → 它自己的绑定。 */
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

/** `Skill` 的入参是 `{ skill, args }`；允许 `/name` 与 `plugin:name` 的前缀写法。 */
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

/**
 * 插件技能带插件命名空间（`<plugin>:<skill>`，技能段是目录名或 frontmatter name）。
 * 这类名字只归主会话：子智能体没有插件绑定，v1 也不做下放。
 */
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

/**
 * 运行时工具边界：
 * - 子智能体只能调用自己绑定的 MCP server 与技能；父级绑定不隐式下放；
 * - 主会话不能调用只属于子智能体的 server；
 * - 用 `mcp__*` / 整个 server 的 disallowedTools 会把所有 MCP 工具一起否掉，
 *   所以子级边界不写在 frontmatter，而在每次调用前按调用方判断。
 */
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
    // 未登记的调用方（例如内置 general-purpose）不改变原有授权，交给权限规则处理。
    if (input.agent_id !== undefined && subAgent === null) return {};

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
