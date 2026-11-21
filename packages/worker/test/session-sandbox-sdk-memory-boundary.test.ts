import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSessionSdkSuite,
  DENIED_RESULT,
  DENY_CASES,
  FILE_BOUNDARY_REASON,
  finishedEvent,
  hasDocker,
  memoryTask,
  readIfExists,
  SUBAGENT_MEMORY_ROOT,
  systemText,
  type ToolStep,
  toolCalls,
} from './fixtures/session-sandbox-sdk-harness.js';

describe.skipIf(!hasDocker)('session sandbox with the real SDK native CLI', () => {
  const suite = createSessionSdkSuite();
  const { execute, getSpec, subAgentHost } = suite;

  beforeAll(() =>
    suite.setup(['boundary', ...DENY_CASES.map(({ specKey }) => specKey), 'unknown']),
  );
  beforeEach(suite.reset);
  afterAll(suite.teardown);

  it('enforces child project-memory boundaries while parent memory keeps working', async () => {
    const spec = getSpec('boundary');
    const childHost = subAgentHost('boundary', 'mem-child');
    const siblingHost = subAgentHost('boundary', 'mem-sibling');
    const parentMemoryPath = join(spec.memoryDir, 'MEMORY.md');
    const ownMemoryPath = `${SUBAGENT_MEMORY_ROOT}/mem-child/MEMORY.md`;
    const siblingMemoryPath = `${SUBAGENT_MEMORY_ROOT}/mem-sibling/MEMORY.md`;
    const ownContent = '# Child Memory\n\nSENTINEL-CHILD-OWN\n';
    const parentContent = '# Parent Memory\n\nSENTINEL-PARENT-OWN\n';
    const parentMarker = 'MEM-BOUNDARY-PARENT';
    const childMarker = 'MEM-BOUNDARY-CHILD';

    suite.toolScenarios = [
      {
        marker: parentMarker,
        steps: [
          {
            name: 'Write',
            input: { file_path: '/mnt/agent-memory/MEMORY.md', content: parentContent },
          },
          { name: 'Read', input: { file_path: '/mnt/agent-memory/MEMORY.md' } },
          {
            name: 'Agent',
            input: {
              subagent_type: 'mem-child',
              description: 'memory boundary check',
              prompt: `${childMarker} 检查文件工具边界`,
            },
          },
          { name: 'Read', input: { file_path: ownMemoryPath } },
          { name: 'Read', input: { file_path: '/mnt/agent-memory/MEMORY.md' } },
        ],
        finalText: `DONE:${parentMarker}`,
      },
      {
        marker: childMarker,
        steps: [
          { name: 'Write', input: { file_path: ownMemoryPath, content: ownContent } },
          { name: 'Read', input: { file_path: ownMemoryPath } },
          { name: 'Read', input: { file_path: siblingMemoryPath } },
          {
            name: 'Write',
            input: {
              file_path: `${SUBAGENT_MEMORY_ROOT}/mem-sibling/INTRUDER.md`,
              content: 'SIBLING-INTRUDER',
            },
          },
          { name: 'Read', input: { file_path: '/mnt/agent-memory/MEMORY.md' } },
          {
            name: 'Write',
            input: { file_path: '/mnt/agent-memory/CHILD-WROTE-PARENT.md', content: 'CHILD-WROTE' },
          },
          { name: 'Read', input: { file_path: `${SUBAGENT_MEMORY_ROOT}/ghost/MEMORY.md` } },
        ],
        finalText: `DONE:${childMarker}`,
      },
    ];

    const result = await execute(
      spec,
      `${parentMarker} 检查父与子的记忆边界`,
      memoryTask(['mem-child', 'mem-sibling']),
      180_000,
    );
    expect(finishedEvent(result.events)?.status).toBe('succeeded');
    const calls = toolCalls(result.events);
    const parentCalls = calls.filter((call) => call.parentToolUseId === undefined);
    const childCalls = calls.filter((call) => call.parentToolUseId !== undefined);

    const parentWrites = parentCalls.filter((call) => call.name === 'Write');
    expect(parentWrites).toHaveLength(1);
    expect(parentWrites[0]?.result).not.toMatch(DENIED_RESULT);
    const parentOwnReads = parentCalls.filter(
      (call) => call.name === 'Read' && call.input?.includes('/mnt/agent-memory/MEMORY.md'),
    );
    expect(parentOwnReads).toHaveLength(2);
    expect(parentOwnReads[0]?.result).toContain('SENTINEL-PARENT-OWN');
    // 第二次同文件读取可能被 SDK 去重为 "Wasted call"；关键是仍被放行，不是 deny。
    expect(parentOwnReads[1]?.result).not.toMatch(DENIED_RESULT);

    const parentReadsChild = parentCalls.find(
      (call) => call.name === 'Read' && call.input?.includes(ownMemoryPath),
    );
    expect(parentReadsChild?.result).toContain(FILE_BOUNDARY_REASON);
    expect(parentReadsChild?.result).not.toContain('SENTINEL-CHILD-OWN');

    const childOwnWrite = childCalls.find(
      (call) => call.name === 'Write' && call.input?.includes(ownMemoryPath),
    );
    expect(childOwnWrite?.result).not.toMatch(DENIED_RESULT);
    const childOwnRead = childCalls.find(
      (call) => call.name === 'Read' && call.input?.includes(ownMemoryPath),
    );
    expect(childOwnRead?.result).toContain('SENTINEL-CHILD-OWN');

    const siblingRead = childCalls.find(
      (call) => call.name === 'Read' && call.input?.includes(siblingMemoryPath),
    );
    expect(siblingRead?.result).toContain(FILE_BOUNDARY_REASON);
    expect(siblingRead?.result).not.toContain('SIBLING-SECRET');
    const siblingWrite = childCalls.find(
      (call) => call.name === 'Write' && call.input?.includes('INTRUDER.md'),
    );
    expect(siblingWrite?.result).toContain(FILE_BOUNDARY_REASON);
    const parentMemoryRead = childCalls.find(
      (call) => call.name === 'Read' && call.input?.includes('/mnt/agent-memory/MEMORY.md'),
    );
    expect(parentMemoryRead?.result).toContain(FILE_BOUNDARY_REASON);
    expect(parentMemoryRead?.result).not.toContain('SENTINEL-PARENT-OWN');
    const parentMemoryWrite = childCalls.find(
      (call) => call.name === 'Write' && call.input?.includes('CHILD-WROTE-PARENT.md'),
    );
    expect(parentMemoryWrite?.result).toContain(FILE_BOUNDARY_REASON);
    const ghostRead = childCalls.find(
      (call) => call.name === 'Read' && call.input?.includes('/ghost/'),
    );
    expect(ghostRead?.result).toContain(FILE_BOUNDARY_REASON);

    expect(readIfExists(join(childHost, 'MEMORY.md'))).toBe(ownContent);
    expect(readIfExists(join(siblingHost, 'MEMORY.md'))).toBe('SIBLING-SECRET\n');
    expect(readIfExists(join(siblingHost, 'INTRUDER.md'))).toBeUndefined();
    expect(readIfExists(parentMemoryPath)).toBe(parentContent);
    expect(readIfExists(join(spec.memoryDir, 'CHILD-WROTE-PARENT.md'))).toBeUndefined();
  }, 240_000);

  it.each(DENY_CASES)(
    'keeps an explicit bare $tool deny for a memory:project subagent',
    async ({ name, specKey, tool, slug, initial }) => {
      const { fake } = suite;
      const containerPath = `${SUBAGENT_MEMORY_ROOT}/${slug}/topics/deny.md`;
      const hostPath = join(subAgentHost(name, slug), 'topics', 'deny.md');
      const parentMarker = `DENY-PARENT-${tool.toUpperCase()}`;
      const childMarker = `DENY-CHILD-${tool.toUpperCase()}`;
      const step: ToolStep =
        tool === 'Read'
          ? { name: 'Read', input: { file_path: containerPath } }
          : tool === 'Write'
            ? {
                name: 'Write',
                input: { file_path: containerPath, content: 'OVERWRITTEN-BY-CHILD\n' },
              }
            : {
                name: 'Edit',
                input: {
                  file_path: containerPath,
                  old_string: initial.trim(),
                  new_string: 'CHANGED-BY-CHILD',
                },
              };
      suite.toolScenarios = [
        {
          marker: parentMarker,
          steps: [
            {
              name: 'Agent',
              input: {
                subagent_type: slug,
                description: `deny ${tool.toLowerCase()}`,
                prompt: `${childMarker} 尝试调用 ${tool}`,
              },
            },
          ],
          finalText: `DONE:${parentMarker}`,
        },
        { marker: childMarker, steps: [step], finalText: `DONE:${childMarker}` },
      ];

      const result = await execute(
        getSpec(specKey),
        `${parentMarker} 委派拒绝 ${tool} 的子智能体`,
        memoryTask([slug]),
        120_000,
      );

      expect(finishedEvent(result.events)?.status).toBe('succeeded');
      const calls = toolCalls(result.events);
      const agent = calls.find((call) => call.name === 'Agent');
      const child = calls.find((call) => call.name === tool && call.parentToolUseId !== undefined);
      expect(agent).toBeDefined();
      expect(child?.parentToolUseId).toBe(agent?.id);
      expect(child?.result).toContain(`No such tool available: ${tool}`);

      if (tool === 'Read') {
        expect(child?.result).not.toContain(initial.trim());
        const childRequest = fake
          .messageRequests()
          .find((request) => systemText(request.body).includes(`${SUBAGENT_MEMORY_ROOT}/${slug}`));
        expect(childRequest).toBeDefined();
        expect(systemText(childRequest?.body)).toContain(`AUTO-${name.toUpperCase()}`);
        expect(systemText(childRequest?.body)).not.toContain(initial.trim());
      } else {
        expect(readFileSync(hostPath, 'utf8')).toBe(initial);
      }
    },
    120_000,
  );

  it('denies file tools to the undeclared built-in general-purpose subagent', async () => {
    const parentMarker = 'UNKNOWN-PARENT';
    const childMarker = 'UNKNOWN-CHILD';
    suite.toolScenarios = [
      {
        marker: parentMarker,
        steps: [
          {
            name: 'Agent',
            input: {
              subagent_type: 'general-purpose',
              description: 'unknown agent file check',
              prompt: `${childMarker} 尝试读取本轮附件`,
            },
          },
        ],
        finalText: `DONE:${parentMarker}`,
      },
      {
        marker: childMarker,
        steps: [{ name: 'Read', input: { file_path: '/mnt/inputs/note.txt' } }],
        finalText: `DONE:${childMarker}`,
      },
    ];

    const result = await execute(
      getSpec('unknown'),
      `${parentMarker} 委派内置 general-purpose 读取附件`,
      { allowSubAgents: true, maxTurns: 12 },
      120_000,
    );

    expect(finishedEvent(result.events)?.status).toBe('succeeded');
    const calls = toolCalls(result.events);
    const agent = calls.find((call) => call.name === 'Agent');
    expect(agent).toBeDefined();
    const childRead = calls.find(
      (call) => call.name === 'Read' && call.parentToolUseId !== undefined,
    );
    expect(childRead?.parentToolUseId).toBe(agent?.id);
    expect(childRead?.result).toContain(FILE_BOUNDARY_REASON);
    expect(childRead?.result).not.toContain('session sandbox fixture');
  }, 120_000);
});
