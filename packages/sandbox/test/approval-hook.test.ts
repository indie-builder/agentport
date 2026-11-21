import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxTaskSchema } from '@agentport/shared';
import { createApprovalHook } from '../src/approval-hook.js';

const originalFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'approval-hook-'));
  dirs.push(dir);
  await writeFile(
    join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        srv: {
          kind: 'http',
          url: 'http://127.0.0.1:9/mcp/srv_1',
          headers: { authorization: 'Bearer token', 'x-agentport-run-id': 'run_1' },
        },
      },
    }),
  );
  const task = sandboxTaskSchema.parse({
    prompt: '',
    model: 'test',
    maxTurns: 1,
    maxBudgetUsd: 1,
    userMessageUuid: crypto.randomUUID(),
    mcpServers: ['srv'],
    mcpServerIds: { srv: 'srv_1' },
    mcpApprovalTools: [{ server: 'srv', tool: 'tool' }],
  });
  return createApprovalHook(task, dir, new AbortController().signal);
}

function input(dir: string) {
  return {
    session_id: 'session',
    transcript_path: join(dir, 'transcript.jsonl'),
    cwd: dir,
    hook_event_name: 'PreToolUse' as const,
    tool_name: 'mcp__srv__tool',
    tool_input: {},
    tool_use_id: 'tool-use',
  };
}

describe('approval hook', () => {
  it('pins the first approval id and denies when that approval is invalidated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'approval-hook-input-'));
    dirs.push(dir);
    const hook = await setup();
    const calls: Array<{ method: string; url: string }> = [];
    globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(request) });
      if (calls.length === 1) {
        return Response.json({
          status: 'pending',
          approvalId: 'approval-1',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      return Response.json({ code: 'CONFLICT', status: 409 }, { status: 409 });
    }) as typeof fetch;

    const result = await hook(input(dir), 'tool-use', {
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(calls.map((call) => call.method)).toEqual(['PUT', 'GET']);
    expect(new URL(calls[1]?.url ?? '').searchParams.get('approvalId')).toBe('approval-1');
  });

  it('never switches to a different approval id returned while waiting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'approval-hook-switch-'));
    dirs.push(dir);
    const hook = await setup();
    const calls: Array<{ method: string; url: string }> = [];
    globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(request) });
      return Response.json({
        status: 'pending',
        approvalId: calls.length === 1 ? 'approval-1' : 'approval-2',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }) as typeof fetch;

    const result = await hook(input(dir), 'tool-use', {
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(calls).toHaveLength(2);
  });
});
