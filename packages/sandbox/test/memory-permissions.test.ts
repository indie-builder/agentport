import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileBoundaryHook, createMemoryHook } from '../src/memory-permissions.js';

let dir: string;
let memory: string;
let hook: ReturnType<typeof createMemoryHook>;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'memory-permissions-')));
  memory = join(dir, 'memory');
  hook = createMemoryHook(memory);
  await mkdir(memory);
  await writeFile(join(memory, 'MEMORY.md'), '# memory');
  await writeFile(join(dir, 'outside.md'), 'secret');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function check(tool: string, input: unknown, agentId?: string) {
  const event: PreToolUseHookInput = {
    hook_event_name: 'PreToolUse',
    session_id: 'session',
    transcript_path: '/tmp/transcript',
    cwd: memory,
    tool_name: tool,
    tool_input: input,
    tool_use_id: 'tool',
    ...(agentId === undefined ? {} : { agent_id: agentId }),
  };
  return hook(event, 'tool', { signal: new AbortController().signal });
}

function decision(value: 'allow' | 'deny') {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: value } };
}

describe('native memory filesystem boundary', () => {
  it.each(['Read', 'Write', 'Edit'])(
    'permits %s for an existing ordinary Markdown file',
    async (tool) => {
      expect(await check(tool, { file_path: join(memory, 'MEMORY.md') })).toMatchObject(
        decision('allow'),
      );
    },
  );

  it('allows Write with missing parents but rejects missing Read or Edit targets', async () => {
    const file_path = join(memory, 'topics', 'nested', 'new.md');
    expect(await check('Write', { file_path })).toMatchObject(decision('allow'));
    expect(await check('Read', { file_path })).toMatchObject(decision('deny'));
    expect(await check('Edit', { file_path })).toMatchObject(decision('deny'));
  });

  it.each(['Read', 'Write', 'Edit'])(
    'rejects %s outside memory, credentials, traversal, and relative paths',
    async (tool) => {
      for (const file_path of [
        join(dir, 'outside.md'),
        join(dir, 'memory-other', 'secret.md'),
        '/workspace/.mcp.json',
        '/home/node/.claude/.credentials.json',
        join(memory, '.mcp.json'),
        `${memory}/../missing.md`,
        `${memory}/missing/../../outside.md`,
        'MEMORY.md',
        './MEMORY.md',
        memory,
        `${memory}/bad\0.md`,
      ]) {
        expect(await check(tool, { file_path }), file_path).toMatchObject(decision('deny'));
      }
      for (const input of [null, {}, [], { file_path: 3 }, { file_path: '' }]) {
        expect(await check(tool, input)).toMatchObject(decision('deny'));
      }
    },
  );

  it('rejects symlink files and directories, including missing descendants and dangling links', async () => {
    await symlink(join(dir, 'outside.md'), join(memory, 'link.md'));
    await symlink(dir, join(memory, 'linked-dir'));
    await symlink(join(dir, 'missing'), join(memory, 'dangling'));
    await symlink(join(memory, 'MEMORY.md'), join(memory, 'internal-link.md'));
    for (const tool of ['Read', 'Write', 'Edit']) {
      for (const path of [
        'link.md',
        'linked-dir/outside.md',
        'linked-dir/new/deep.md',
        'dangling/new.md',
        'internal-link.md',
      ]) {
        expect(await check(tool, { file_path: join(memory, path) }), path).toMatchObject(
          decision('deny'),
        );
      }
    }
  });

  it('rechecks existing parents for each call rather than trusting a previous approval', async () => {
    await mkdir(join(memory, 'topics'));
    const file_path = join(memory, 'topics', 'new.md');
    expect(await check('Write', { file_path })).toMatchObject(decision('allow'));
    await rm(join(memory, 'topics'), { recursive: true });
    await symlink(dir, join(memory, 'topics'));
    expect(await check('Write', { file_path })).toMatchObject(decision('deny'));
  });

  it('rejects nonordinary targets and hard links', async () => {
    await mkdir(join(memory, 'directory.md'));
    await link(join(dir, 'outside.md'), join(memory, 'hard-link.md'));
    execFileSync('mkfifo', [join(memory, 'fifo.md')]);
    for (const tool of ['Read', 'Write', 'Edit']) {
      for (const path of ['directory.md', 'hard-link.md', 'fifo.md', 'MEMORY.md/child.md']) {
        expect(await check(tool, { file_path: join(memory, path) }), path).toMatchObject(
          decision('deny'),
        );
      }
    }
  });

  it('rejects subagent file access even inside parent memory', async () => {
    for (const tool of ['Read', 'Write', 'Edit']) {
      expect(await check(tool, { file_path: join(memory, 'MEMORY.md') }, 'child')).toMatchObject(
        decision('deny'),
      );
    }
  });

  it('denies other built-in filesystem tools and leaves MCP permissions to the SDK', async () => {
    for (const tool of ['Glob', 'Grep', 'NotebookEdit']) {
      expect(await check(tool, {})).toMatchObject(decision('deny'));
    }
    expect(await check('mcp__demo__read', {})).toEqual({});
  });

  it('rejects a missing or symlinked memory root', async () => {
    await rm(memory, { recursive: true });
    expect(await check('Write', { file_path: join(memory, 'new.md') })).toMatchObject(
      decision('deny'),
    );
    await symlink(dir, memory);
    expect(await check('Read', { file_path: join(memory, 'outside.md') })).toMatchObject(
      decision('deny'),
    );
  });
});

describe('skill reference read-only boundary', () => {
  let skills: string;
  let skillHook: ReturnType<typeof createFileBoundaryHook>;

  beforeEach(async () => {
    skills = join(dir, 'skills');
    skillHook = createFileBoundaryHook(memory, skills);
    await mkdir(join(skills, 'demo', 'references'), { recursive: true });
    await writeFile(join(skills, 'demo', 'references', 'api.md'), '# api');
    await writeFile(join(skills, 'demo', 'references', 'notes.json'), '{}');
    await writeFile(join(skills, 'demo', 'SKILL.md'), '# skill');
  });

  const call = (tool: string, file_path: string) =>
    skillHook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '/tmp/t',
        cwd: memory,
        tool_name: tool,
        tool_input: { file_path },
        tool_use_id: 't',
      },
      'tool',
      { signal: new AbortController().signal },
    );

  it('allows Read under <slug>/references/*.md', async () => {
    expect(await call('Read', join(skills, 'demo', 'references', 'api.md'))).toMatchObject(
      decision('allow'),
    );
  });

  it('denies Write/Edit even inside references, and denies non-.md or non-reference paths', async () => {
    // 大写 slug 文件真实存在，确保拒绝来自 slug 正则而非文件不存在。
    await mkdir(join(skills, 'Demo', 'references'), { recursive: true });
    await writeFile(join(skills, 'Demo', 'references', 'api.md'), '# api');
    for (const [tool, path] of [
      ['Write', join(skills, 'demo', 'references', 'api.md')],
      ['Edit', join(skills, 'demo', 'references', 'api.md')],
      ['Read', join(skills, 'demo', 'references', 'notes.json')],
      ['Read', join(skills, 'demo', 'SKILL.md')],
      ['Read', join(skills, 'demo', 'references', 'missing.md')],
      ['Read', join(skills, 'Demo', 'references', 'api.md')],
    ] as const) {
      expect(await call(tool, path), `${tool} ${path}`).toMatchObject(decision('deny'));
    }
  });
});
