import { describe, expect, it } from 'vitest';
import { createSubAgentBoundaryHook, type SubAgentBoundary } from '../src/sub-agent-permissions.js';

const hookFor = (boundary: SubAgentBoundary) => createSubAgentBoundaryHook(boundary);

async function decide(
  boundary: SubAgentBoundary,
  toolName: string,
  toolInput: unknown = {},
  agent?: { id: string; type: string },
): Promise<'allow' | 'deny' | undefined> {
  const hook = hookFor(boundary);
  const result = await hook(
    {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      transcript_path: '/tmp/t',
      cwd: '/workspace',
      tool_name: toolName,
      tool_use_id: 't',
      tool_input: toolInput,
      ...(agent === undefined ? {} : { agent_id: agent.id, agent_type: agent.type }),
    },
    't',
    { signal: new AbortController().signal },
  );
  const output = (result as { hookSpecificOutput?: { permissionDecision?: string } })
    ?.hookSpecificOutput;
  return output?.permissionDecision as 'allow' | 'deny' | undefined;
}

const boundary = (): SubAgentBoundary => ({
  servers: new Set(['root-mcp']),
  skills: new Set(['root-skill']),
  subAgents: new Map([
    ['researcher', { servers: new Set(['child-mcp']), skills: new Set(['child-skill']) }],
  ]),
});

describe('sub-agent tool boundary', () => {
  it('lets the main session use its own servers and hides child-only servers', async () => {
    expect(await decide(boundary(), 'mcp__root-mcp__search')).toBe('allow');
    expect(await decide(boundary(), 'mcp__child-mcp__search')).toBe('deny');
    expect(await decide(boundary(), 'Bash')).toBeUndefined();
  });

  it('lets a child use only its own servers and skills', async () => {
    const researcher = { id: 'agent-1', type: 'researcher' };
    expect(await decide(boundary(), 'mcp__child-mcp__search', {}, researcher)).toBe('allow');
    expect(await decide(boundary(), 'mcp__root-mcp__search', {}, researcher)).toBe('deny');

    expect(await decide(boundary(), 'Skill', { skill: 'child-skill' }, researcher)).toBe('allow');
    expect(await decide(boundary(), 'Skill', { skill: '/child-skill' }, researcher)).toBe('allow');
    expect(await decide(boundary(), 'Skill', { skill: 'root-skill' }, researcher)).toBe('deny');
  });

  it('keeps the main session limited to its own skills', async () => {
    expect(await decide(boundary(), 'Skill', { skill: 'root-skill' })).toBe('allow');
    expect(await decide(boundary(), 'Skill', { skill: 'child-skill' })).toBe('deny');
  });

  it('does not guess server names for unknown tools', async () => {
    expect(await decide(boundary(), 'mcp__unknown__tool')).toBeUndefined();
  });
});
