import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  createSessionSdkSuite,
  DENIED_RESULT,
  finishedEvent,
  hasDocker,
  readIfExists,
  toolCalls,
} from './fixtures/session-sandbox-sdk-harness.js';

describe.skipIf(!hasDocker)('session sandbox with the real SDK native CLI', () => {
  const suite = createSessionSdkSuite();
  const { execute, getSpec } = suite;

  beforeAll(() =>
    suite.setup(['bashDefault', 'bashDontAsk', 'bashPlatformDeny', 'bashCommandDeny']),
  );
  beforeEach(suite.reset);
  afterAll(suite.teardown);

  it.each(['default', 'dontAsk'] as const)(
    'lets the parent agent run Bash under %s and write only to /mnt/outputs',
    async (mode) => {
      const marker = `BASH-${mode.toUpperCase()}`;
      const spec = mode === 'default' ? getSpec('bashDefault') : getSpec('bashDontAsk');
      const outputName = `parent-${mode}.txt`;
      const command = [
        `printf 'ok' > /mnt/outputs/${outputName}`,
        `if printf 'no' > /workspace/should-not-exist-${mode}.txt 2>/dev/null; then echo WORKSPACE_WRITABLE; else echo WORKSPACE_READONLY; fi`,
      ].join('; ');
      suite.toolScenarios = [
        {
          marker,
          steps: [
            {
              name: 'Bash',
              input: { command, description: 'write outputs and probe the readonly workspace' },
            },
          ],
          finalText: `DONE:${marker}`,
        },
      ];

      const result = await execute(spec, `${marker} 请执行 Bash 行为验收`, {
        permissionMode: mode,
        maxTurns: 6,
      });

      expect(result.settlement.state).toBe('stopped');
      expect(finishedEvent(result.events)?.status).toBe('succeeded');
      const bash = toolCalls(result.events).filter((call) => call.name === 'Bash');
      expect(bash).toHaveLength(1);
      // 父级自己的调用没有 parent_tool_use_id。
      expect(bash[0]?.parentToolUseId).toBeUndefined();
      expect(bash[0]?.result).toContain('WORKSPACE_READONLY');
      expect(readIfExists(join(spec.outputsDir, outputName))).toBe('ok');
      expect(readIfExists(join(spec.workspaceDir, `should-not-exist-${mode}.txt`))).toBeUndefined();
    },
    90_000,
  );

  it('keeps an explicit parent Bash deny effective', async () => {
    const marker = 'BASH-PLATFORM-DENY';
    const deniedFile = join(getSpec('bashPlatformDeny').outputsDir, 'platform-denied.txt');
    suite.toolScenarios = [
      {
        marker,
        steps: [
          {
            name: 'Bash',
            input: { command: 'echo DENIED > /mnt/outputs/platform-denied.txt' },
          },
        ],
        finalText: `DONE:${marker}`,
      },
    ];

    const result = await execute(getSpec('bashPlatformDeny'), `${marker} 尝试写入产出目录`, {
      extraDisallowedTools: ['Bash'],
      maxTurns: 6,
    });

    expect(finishedEvent(result.events)?.status).toBe('succeeded');
    const bash = toolCalls(result.events).filter((call) => call.name === 'Bash');
    expect(bash).toHaveLength(1);
    expect(bash[0]?.result).toMatch(DENIED_RESULT);
    expect(readIfExists(deniedFile)).toBeUndefined();
  }, 90_000);

  it('keeps a command-level Bash deny effective while allowing other commands', async () => {
    const marker = 'BASH-COMMAND-DENY';
    const allowedFile = join(getSpec('bashCommandDeny').outputsDir, 'command-allowed.txt');
    const deniedFile = join(getSpec('bashCommandDeny').outputsDir, 'command-denied.txt');
    suite.toolScenarios = [
      {
        marker,
        steps: [
          {
            name: 'Bash',
            input: {
              command:
                "printf 'ALLOWED_OUTPUT\\n' > /mnt/outputs/command-allowed.txt && cat /mnt/outputs/command-allowed.txt",
            },
          },
          {
            name: 'Bash',
            input: {
              command: 'echo DENIED_OUTPUT > /mnt/outputs/command-denied.txt',
            },
          },
        ],
        finalText: `DONE:${marker}`,
      },
    ];

    const result = await execute(getSpec('bashCommandDeny'), `${marker} 依次执行两条命令`, {
      extraDisallowedTools: ['Bash(echo:*)'],
      maxTurns: 8,
    });

    expect(finishedEvent(result.events)?.status).toBe('succeeded');
    const bash = toolCalls(result.events).filter((call) => call.name === 'Bash');
    expect(bash).toHaveLength(2);
    expect(bash[0]?.result).toContain('ALLOWED_OUTPUT');
    expect(bash[0]?.result).not.toMatch(DENIED_RESULT);
    expect(readIfExists(allowedFile)).toBe('ALLOWED_OUTPUT\n');
    expect(bash[1]?.result).toMatch(DENIED_RESULT);
    expect(readIfExists(deniedFile)).toBeUndefined();
  }, 90_000);
});
