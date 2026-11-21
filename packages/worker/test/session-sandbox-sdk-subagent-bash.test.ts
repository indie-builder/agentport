import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DockerSandboxProvider } from '../src/sandbox/docker.js';
import type { SessionSandboxes } from '../src/sandbox/sessions.js';
import {
  createSessionSdkSuite,
  DENIED_RESULT,
  finishedEvent,
  hasDocker,
  lastUserText,
  memoryTask,
  readIfExists,
  SUBAGENT_MEMORY_ROOT,
  sessionsFor,
  systemText,
  toolCalls,
  withTimeout,
} from './fixtures/session-sandbox-sdk-harness.js';

describe.skipIf(!hasDocker)('session sandbox with the real SDK native CLI', () => {
  const suite = createSessionSdkSuite();
  const { createProvider, execute, getSpec, startRun, subAgentHost } = suite;

  beforeAll(() => suite.setup(['bashChild', 'bashChildDeny', 'memory']));
  beforeEach(suite.reset);
  afterAll(suite.teardown);

  it('lets a delegated subagent run Bash and write outputs', async () => {
    const parentMarker = 'BASH-CHILD-PARENT';
    const childMarker = 'BASH-CHILD-WORK';
    const childFile = join(getSpec('bashChild').outputsDir, 'child.txt');
    suite.toolScenarios = [
      {
        marker: parentMarker,
        steps: [
          {
            name: 'Agent',
            input: {
              subagent_type: 'bash-child',
              description: 'child bash check',
              prompt: `${childMarker} 在子智能体里执行 Bash`,
            },
          },
        ],
        finalText: `DONE:${parentMarker}`,
      },
      {
        marker: childMarker,
        steps: [
          {
            name: 'Bash',
            input: { command: 'echo CHILD-RAN > /mnt/outputs/child.txt && echo CHILD-RAN' },
          },
        ],
        finalText: `DONE:${childMarker}`,
      },
    ];

    const result = await execute(
      getSpec('bashChild'),
      `${parentMarker} 委派子智能体执行 Bash`,
      {
        allowSubAgents: true,
        subAgents: [{ slug: 'bash-child' }],
        maxTurns: 10,
      },
      120_000,
    );

    expect(finishedEvent(result.events)?.status).toBe('succeeded');
    const calls = toolCalls(result.events);
    const agent = calls.find((call) => call.name === 'Agent');
    expect(agent?.input).toContain(childMarker);
    const childBash = calls.find(
      (call) => call.name === 'Bash' && call.parentToolUseId !== undefined,
    );
    expect(childBash?.parentToolUseId).toBe(agent?.id);
    expect(childBash?.result).toContain('CHILD-RAN');
    expect(readIfExists(childFile)).toBe('CHILD-RAN\n');
    expect(
      result.events.some(
        (event) => event.type === 'assistant_text' && event.parentToolUseId === agent?.id,
      ),
    ).toBe(true);
  }, 120_000);

  it('keeps a subagent Bash deny scoped to that subagent', async () => {
    const parentMarker = 'BASH-CHILD-DENY-PARENT';
    const childMarker = 'BASH-CHILD-DENY-WORK';
    const beforeFile = join(getSpec('bashChildDeny').outputsDir, 'parent-before.txt');
    const afterFile = join(getSpec('bashChildDeny').outputsDir, 'parent-after.txt');
    const childFile = join(getSpec('bashChildDeny').outputsDir, 'child-denied.txt');
    suite.toolScenarios = [
      {
        marker: parentMarker,
        steps: [
          {
            name: 'Bash',
            input: {
              command:
                'echo PARENT-BEFORE > /mnt/outputs/parent-before.txt && echo PARENT-BEFORE-RAN',
            },
          },
          {
            name: 'Agent',
            input: {
              subagent_type: 'bash-child-denied',
              description: 'child denied bash',
              prompt: `${childMarker} 在子智能体里尝试 Bash`,
            },
          },
          {
            name: 'Bash',
            input: {
              command: 'echo PARENT-AFTER > /mnt/outputs/parent-after.txt && echo PARENT-AFTER-RAN',
            },
          },
        ],
        finalText: `DONE:${parentMarker}`,
      },
      {
        marker: childMarker,
        steps: [
          {
            name: 'Bash',
            input: { command: 'echo CHILD-DENIED > /mnt/outputs/child-denied.txt' },
          },
        ],
        finalText: `DONE:${childMarker}`,
      },
    ];

    const result = await execute(
      getSpec('bashChildDeny'),
      `${parentMarker} 先执行 Bash，再委派拒绝 Bash 的子智能体`,
      {
        allowSubAgents: true,
        subAgents: [{ slug: 'bash-child-denied' }],
        maxTurns: 12,
      },
      120_000,
    );

    expect(finishedEvent(result.events)?.status).toBe('succeeded');
    const calls = toolCalls(result.events);
    const parentBash = calls.filter(
      (call) => call.name === 'Bash' && call.parentToolUseId === undefined,
    );
    expect(parentBash).toHaveLength(2);
    expect(parentBash[0]?.result).toContain('PARENT-BEFORE-RAN');
    expect(parentBash[1]?.result).toContain('PARENT-AFTER-RAN');
    expect(readIfExists(beforeFile)).toBe('PARENT-BEFORE\n');
    expect(readIfExists(afterFile)).toBe('PARENT-AFTER\n');

    const agent = calls.find((call) => call.name === 'Agent');
    const childBash = calls.find(
      (call) => call.name === 'Bash' && call.parentToolUseId !== undefined,
    );
    expect(childBash?.parentToolUseId).toBe(agent?.id);
    expect(childBash?.result).toMatch(DENIED_RESULT);
    expect(readIfExists(childFile)).toBeUndefined();
  }, 120_000);

  it('persists subagent project memory across runs and containers', async () => {
    const { fake } = suite;
    const spec = getSpec('memory');
    const hostDir = subAgentHost('memory', 'mem-child');
    const memoryPath = `${SUBAGENT_MEMORY_ROOT}/mem-child/MEMORY.md`;
    const topicPath = `${SUBAGENT_MEMORY_ROOT}/mem-child/topics/one.md`;
    const firstMemory = '# Memory\n\n- SENTINEL-MEM-1\n- [Topic one](topics/one.md)\n';
    const firstTopic = '# Topic one\n\nSENTINEL-TOPIC-1\n';
    const editedMemory = `${firstMemory}- SENTINEL-MEM-1-EDITED\n`;

    const provider = createProvider();
    const sessions = sessionsFor(provider);
    let provider2: DockerSandboxProvider | undefined;
    let sessions2: SessionSandboxes | undefined;
    try {
      suite.toolScenarios = [
        {
          marker: 'MEM-PARENT-1',
          steps: [
            {
              name: 'Agent',
              input: {
                subagent_type: 'mem-child',
                description: 'write memory',
                prompt: 'MEM-CHILD-1 写入你的项目记忆',
              },
            },
          ],
          finalText: 'DONE:MEM-PARENT-1',
        },
        {
          marker: 'MEM-CHILD-1',
          steps: [
            { name: 'Write', input: { file_path: memoryPath, content: firstMemory } },
            { name: 'Write', input: { file_path: topicPath, content: firstTopic } },
            {
              name: 'Edit',
              input: {
                file_path: memoryPath,
                old_string: '- [Topic one](topics/one.md)\n',
                new_string: '- [Topic one](topics/one.md)\n- SENTINEL-MEM-1-EDITED\n',
              },
            },
          ],
          finalText: 'DONE:MEM-CHILD-1',
        },
      ];

      const lease1 = await sessions.acquire(
        spec,
        new AbortController().signal,
        `run-${randomUUID()}`,
      );
      const firstSandboxId = lease1.sandboxId;
      const run1 = await startRun(
        lease1,
        'MEM-PARENT-1 委派子智能体写入项目记忆',
        undefined,
        memoryTask(['mem-child']),
      );
      expect((await withTimeout(run1.execution.done, 60_000, 'memory run 1')).state).toBe(
        'stopped',
      );
      expect(finishedEvent(run1.events)?.status).toBe('succeeded');

      expect(readFileSync(join(hostDir, 'MEMORY.md'), 'utf8')).toBe(editedMemory);
      expect(readFileSync(join(hostDir, 'topics', 'one.md'), 'utf8')).toBe(firstTopic);
      const firstAgent = toolCalls(run1.events).find((call) => call.name === 'Agent');
      const firstChildTools = toolCalls(run1.events).filter(
        (call) => call.parentToolUseId !== undefined,
      );
      expect(firstChildTools.map((call) => call.name)).toEqual(['Write', 'Write', 'Edit']);
      expect(firstChildTools.every((call) => call.parentToolUseId === firstAgent?.id)).toBe(true);
      expect(firstChildTools.every((call) => !DENIED_RESULT.test(call.result ?? ''))).toBe(true);

      await lease1.release({ reuse: true });
      fake.requests.length = 0;
      suite.toolScenarios = [
        {
          marker: 'MEM-PARENT-2',
          steps: [
            {
              name: 'Agent',
              input: {
                subagent_type: 'mem-child',
                description: 'read memory',
                prompt: 'MEM-CHILD-2 读取你的项目记忆',
              },
            },
          ],
          finalText: 'DONE:MEM-PARENT-2',
        },
        {
          marker: 'MEM-CHILD-2',
          steps: [
            { name: 'Read', input: { file_path: memoryPath } },
            { name: 'Read', input: { file_path: topicPath } },
          ],
          finalText: 'DONE:MEM-CHILD-2',
        },
      ];

      const lease2 = await sessions.acquire(
        spec,
        new AbortController().signal,
        `run-${randomUUID()}`,
      );
      expect(lease2.sandboxId).toBe(firstSandboxId);
      const run2 = await startRun(
        lease2,
        'MEM-PARENT-2 再委派子智能体读取项目记忆',
        undefined,
        memoryTask(['mem-child']),
      );
      expect((await withTimeout(run2.execution.done, 60_000, 'memory run 2')).state).toBe(
        'stopped',
      );
      expect(finishedEvent(run2.events)?.status).toBe('succeeded');
      const secondChildRequest = fake
        .messageRequests()
        .find((request) => lastUserText(request.body).includes('MEM-CHILD-2'));
      expect(secondChildRequest).toBeDefined();
      const secondSystem = systemText(secondChildRequest?.body);
      // MEMORY.md 由官方 SDK 自动注入子智能体 system，而不是只有显式 Read 才可见。
      expect(secondSystem).toContain('SENTINEL-MEM-1');
      expect(secondSystem).toContain(`${SUBAGENT_MEMORY_ROOT}/mem-child`);
      const secondChildReads = toolCalls(run2.events).filter(
        (call) => call.parentToolUseId !== undefined && call.name === 'Read',
      );
      expect(secondChildReads).toHaveLength(2);
      expect(secondChildReads[0]?.result).toContain('SENTINEL-MEM-1');
      expect(secondChildReads[1]?.result).toContain('SENTINEL-TOPIC-1');

      await lease2.release({ reuse: true });
      await sessions.close();
      await provider.destroyAll().catch(() => undefined);
      fake.requests.length = 0;
      suite.toolScenarios = [
        {
          marker: 'MEM-PARENT-3',
          steps: [
            {
              name: 'Agent',
              input: {
                subagent_type: 'mem-child',
                description: 'read memory after restart',
                prompt: 'MEM-CHILD-3 新会话读取你的项目记忆',
              },
            },
          ],
          finalText: 'DONE:MEM-PARENT-3',
        },
        {
          marker: 'MEM-CHILD-3',
          steps: [{ name: 'Read', input: { file_path: memoryPath } }],
          finalText: 'DONE:MEM-CHILD-3',
        },
      ];

      provider2 = createProvider();
      sessions2 = sessionsFor(provider2);
      const lease3 = await sessions2.acquire(
        spec,
        new AbortController().signal,
        `run-${randomUUID()}`,
      );
      expect(lease3.sandboxId).not.toBe(firstSandboxId);
      const run3 = await startRun(
        lease3,
        'MEM-PARENT-3 新容器再委派子智能体',
        undefined,
        memoryTask(['mem-child']),
      );
      expect((await withTimeout(run3.execution.done, 60_000, 'memory run 3')).state).toBe(
        'stopped',
      );
      expect(finishedEvent(run3.events)?.status).toBe('succeeded');
      const thirdChildRequest = fake
        .messageRequests()
        .find((request) => lastUserText(request.body).includes('MEM-CHILD-3'));
      expect(thirdChildRequest).toBeDefined();
      expect(systemText(thirdChildRequest?.body)).toContain('SENTINEL-MEM-1');
      const thirdChildRead = toolCalls(run3.events).find(
        (call) => call.parentToolUseId !== undefined && call.name === 'Read',
      );
      expect(thirdChildRead?.result).toContain('SENTINEL-MEM-1');
      await lease3.release({ reuse: true });
    } finally {
      await sessions.close().catch(() => undefined);
      await sessions2?.close().catch(() => undefined);
      await provider.destroyAll().catch(() => undefined);
      await provider2?.destroyAll().catch(() => undefined);
    }
  }, 240_000);
});
