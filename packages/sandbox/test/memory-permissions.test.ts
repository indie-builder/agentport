import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PreToolUseHookInput,
  UserPromptSubmitHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFileBoundaryHook,
  createMemoryHook,
  createPersonalMemoryHook,
  PERSONAL_MEMORY_MAX_BYTES,
  PERSONAL_MEMORY_MAX_CHARS,
} from '../src/memory-permissions.js';

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

describe('run outputs boundary', () => {
  let outputs: string;
  let outputHook: ReturnType<typeof createFileBoundaryHook>;

  /** 记忆目录与产出目录是两个独立挂载，hook 按各自根判断。 */
  const call = (tool: string, file_path: string, agentId?: string) =>
    outputHook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '/tmp/t',
        cwd: memory,
        tool_name: tool,
        tool_input: { file_path },
        tool_use_id: 't',
        ...(agentId === undefined ? {} : { agent_id: agentId }),
      },
      'tool',
      { signal: new AbortController().signal },
    );

  beforeEach(async () => {
    outputs = join(dir, 'outputs');
    outputHook = createFileBoundaryHook(memory, join(dir, 'skills'), join(dir, 'plugins'), outputs);
    await mkdir(join(outputs, 'reports'), { recursive: true });
    await writeFile(join(outputs, 'reports', 'final.md'), '# final');
    await writeFile(join(outputs, 'data.csv'), 'a,b');
    await writeFile(join(outputs, 'sheet.xlsx'), 'binary');
  });

  it('lets the main agent read and write any delivered file type inside outputs', async () => {
    for (const tool of ['Read', 'Write', 'Edit']) {
      for (const name of ['reports/final.md', 'data.csv', 'sheet.xlsx']) {
        expect(await call(tool, join(outputs, name)), `${tool} ${name}`).toMatchObject(
          decision('allow'),
        );
      }
    }
  });

  it('allows Write to a missing nested outputs path but not a missing Read target', async () => {
    const file_path = join(outputs, 'new', 'deep', 'report.md');
    expect(await call('Write', file_path)).toMatchObject(decision('allow'));
    expect(await call('Read', file_path)).toMatchObject(decision('deny'));
  });

  it('keeps memory markdown-only while outputs accept any file', async () => {
    const notes = join(memory, 'notes.txt');
    expect(await call('Write', notes)).toMatchObject(decision('deny'));
    expect(await call('Write', join(outputs, 'notes.txt'))).toMatchObject(decision('allow'));
  });

  it('rejects sub-agent output access, traversal, and paths outside both roots', async () => {
    await mkdir(join(dir, 'outputs-other'));
    await writeFile(join(dir, 'outputs-other', 'secret.csv'), 'secret');
    for (const tool of ['Read', 'Write', 'Edit']) {
      expect(await call(tool, join(outputs, 'data.csv'), 'child')).toMatchObject(decision('deny'));
      for (const file_path of [
        `${outputs}/../outside.md`,
        `${outputs}/reports/../../outside.md`,
        join(dir, 'outside.md'),
        // 前缀相同但不是同一目录。
        join(dir, 'outputs-other', 'secret.csv'),
        outputs,
        'data.csv',
      ]) {
        expect(await call(tool, file_path), file_path).toMatchObject(decision('deny'));
      }
    }
  });

  it('rejects symlinked or hard-linked output files and directories', async () => {
    await symlink(join(dir, 'outside.md'), join(outputs, 'link.csv'));
    await symlink(dir, join(outputs, 'linked-dir'));
    await link(join(dir, 'outside.md'), join(outputs, 'hard.csv'));
    for (const tool of ['Read', 'Write', 'Edit']) {
      for (const name of ['link.csv', 'linked-dir/outside.md', 'hard.csv']) {
        expect(await call(tool, join(outputs, name)), name).toMatchObject(decision('deny'));
      }
    }
  });

  it('rejects a missing or symlinked outputs mount', async () => {
    await rm(outputs, { recursive: true });
    expect(await call('Write', join(outputs, 'new.csv'))).toMatchObject(decision('deny'));
    await symlink(dir, outputs);
    expect(await call('Read', join(outputs, 'outside.md'))).toMatchObject(decision('deny'));
  });

  it('keeps Glob/Grep/NotebookEdit denied', async () => {
    for (const tool of ['Glob', 'Grep', 'NotebookEdit']) {
      expect(await call(tool, join(outputs, 'data.csv'))).toMatchObject(decision('deny'));
    }
  });
});

describe('subagent project memory boundary', () => {
  let projectMemory: string;
  let childHook: ReturnType<typeof createFileBoundaryHook>;

  const call = (tool: string, file_path: string, agentType = 'child') =>
    childHook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '/tmp/t',
        cwd: memory,
        tool_name: tool,
        tool_input: { file_path },
        tool_use_id: 't',
        agent_id: 'agent-child',
        agent_type: agentType,
      },
      'tool',
      { signal: new AbortController().signal },
    );

  const callUntyped = (tool: string, file_path: string) =>
    childHook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '/tmp/t',
        cwd: memory,
        tool_name: tool,
        tool_input: { file_path },
        tool_use_id: 't',
        agent_id: 'agent-child',
      },
      'tool',
      { signal: new AbortController().signal },
    );

  beforeEach(async () => {
    projectMemory = join(dir, 'agent-memory');
    childHook = createFileBoundaryHook(memory, undefined, undefined, undefined, undefined, {
      projectMemoryDir: projectMemory,
      subAgentSlugs: new Set(['child']),
    });
    await mkdir(join(projectMemory, 'child', 'topics'), { recursive: true });
    await mkdir(join(projectMemory, 'sibling'));
    await writeFile(join(projectMemory, 'child', 'MEMORY.md'), '# child');
    await writeFile(join(projectMemory, 'child', 'topics', 'note.md'), '# note');
    await writeFile(join(projectMemory, 'sibling', 'MEMORY.md'), '# sibling');
  });

  it('lets a known child read and write Markdown only in its own memory', async () => {
    for (const tool of ['Read', 'Write', 'Edit']) {
      for (const name of ['MEMORY.md', 'topics/note.md']) {
        expect(
          await call(tool, join(projectMemory, 'child', name)),
          `${tool} ${name}`,
        ).toMatchObject(decision('allow'));
      }
      expect(
        await call(tool, join(projectMemory, 'sibling', 'MEMORY.md')),
        `${tool} sibling`,
      ).toMatchObject(decision('deny'));
    }
    // 缺失的父目录允许 Write 创建，Read/Edit 仍要目标已存在。
    expect(
      await call('Write', join(projectMemory, 'child', 'topics', 'deep', 'new.md')),
    ).toMatchObject(decision('allow'));
    expect(
      await call('Read', join(projectMemory, 'child', 'topics', 'deep', 'new.md')),
    ).toMatchObject(decision('deny'));
  });

  it('denies parent memory, outputs, inputs, non-Markdown, and traversal for children', async () => {
    for (const [tool, file_path] of [
      ['Read', join(memory, 'MEMORY.md')],
      ['Write', join(dir, 'outputs', 'report.csv')],
      ['Read', join(dir, 'inputs', 'brief.pdf')],
      ['Write', join(projectMemory, 'child', 'notes.txt')],
      ['Read', `${projectMemory}/child/../sibling/MEMORY.md`],
      ['Read', projectMemory],
      ['Read', join(projectMemory, 'child')],
      ['Read', 'relative.md'],
    ] as const) {
      expect(await call(tool, file_path), `${tool} ${file_path}`).toMatchObject(decision('deny'));
    }
  });

  it('denies unknown or unidentified children even inside a known child directory', async () => {
    expect(await call('Read', join(projectMemory, 'child', 'MEMORY.md'), 'stranger')).toMatchObject(
      decision('deny'),
    );
    expect(await callUntyped('Read', join(projectMemory, 'child', 'MEMORY.md'))).toMatchObject(
      decision('deny'),
    );
    await mkdir(join(projectMemory, 'stranger'));
    await writeFile(join(projectMemory, 'stranger', 'MEMORY.md'), '# stranger');
    expect(
      await call('Read', join(projectMemory, 'stranger', 'MEMORY.md'), 'stranger'),
    ).toMatchObject(decision('deny'));
  });

  it('keeps the main session and non-file tools out of child memory', async () => {
    const main = (tool: string, file_path: string) =>
      childHook(
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
    for (const tool of ['Read', 'Write', 'Edit']) {
      expect(await main(tool, join(projectMemory, 'child', 'MEMORY.md'))).toMatchObject(
        decision('deny'),
      );
      for (const other of ['Glob', 'Grep', 'NotebookEdit']) {
        expect(await call(other, join(projectMemory, 'child', 'MEMORY.md'))).toMatchObject(
          decision('deny'),
        );
      }
    }
  });

  it('rejects symlinked and hard-linked files inside the child memory', async () => {
    await symlink(join(dir, 'outside.md'), join(projectMemory, 'child', 'link.md'));
    await link(join(dir, 'outside.md'), join(projectMemory, 'child', 'hard.md'));
    await symlink(join(projectMemory, 'sibling'), join(projectMemory, 'child', 'linked-dir'));
    for (const tool of ['Read', 'Write', 'Edit']) {
      for (const name of ['link.md', 'hard.md', 'linked-dir/MEMORY.md']) {
        expect(
          await call(tool, join(projectMemory, 'child', name)),
          `${tool} ${name}`,
        ).toMatchObject(decision('deny'));
      }
    }
  });
});

describe('conversation inputs read-only boundary', () => {
  let inputs: string;
  let inputsHook: ReturnType<typeof createFileBoundaryHook>;

  const call = (tool: string, file_path: string, agentId?: string) =>
    inputsHook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '/tmp/t',
        cwd: memory,
        tool_name: tool,
        tool_input: { file_path },
        tool_use_id: 't',
        ...(agentId === undefined ? {} : { agent_id: agentId }),
      },
      'tool',
      { signal: new AbortController().signal },
    );

  beforeEach(async () => {
    inputs = join(dir, 'inputs');
    inputsHook = createFileBoundaryHook(
      memory,
      join(dir, 'skills'),
      join(dir, 'plugins'),
      join(dir, 'outputs'),
      inputs,
    );
    await mkdir(join(inputs, 'reports'), { recursive: true });
    for (const name of ['brief.pdf', 'photo.png', 'data.csv', 'notes.txt', 'reports/a.json']) {
      await writeFile(join(inputs, name), 'content');
    }
  });

  it('lets the main session Read any ordinary file type under inputs', async () => {
    for (const name of ['brief.pdf', 'photo.png', 'data.csv', 'notes.txt', 'reports/a.json']) {
      expect(await call('Read', join(inputs, name)), name).toMatchObject(decision('allow'));
    }
  });

  it('keeps inputs read-only and rejects sub-agent reads', async () => {
    for (const tool of ['Write', 'Edit']) {
      expect(await call(tool, join(inputs, 'data.csv')), tool).toMatchObject(decision('deny'));
    }
    expect(await call('Read', join(inputs, 'brief.pdf'), 'child')).toMatchObject(decision('deny'));
  });

  it('rejects symlinked and hard-linked input files', async () => {
    await symlink(join(dir, 'outside.md'), join(inputs, 'link.pdf'));
    await symlink(dir, join(inputs, 'linked-dir'));
    await link(join(dir, 'outside.md'), join(inputs, 'hard.pdf'));
    for (const name of ['link.pdf', 'linked-dir/outside.md', 'hard.pdf']) {
      expect(await call('Read', join(inputs, name)), name).toMatchObject(decision('deny'));
    }
  });

  it('rejects missing files, the mount root itself, and paths outside inputs', async () => {
    for (const file_path of [
      join(inputs, 'missing.pdf'),
      inputs,
      `${inputs}/../outside.md`,
      join(dir, 'outside.md'),
      'data.csv',
    ]) {
      expect(await call('Read', file_path), file_path).toMatchObject(decision('deny'));
    }
  });

  it('rejects reads when the inputs mount is absent', async () => {
    await rm(inputs, { recursive: true });
    expect(await call('Read', join(inputs, 'data.csv'))).toMatchObject(decision('deny'));
  });
});

describe('plugin skill read-only boundary', () => {
  let pluginHook: ReturnType<typeof createFileBoundaryHook>;
  let plugRoot: string;
  let skillsDirForPlugin: string;

  beforeEach(async () => {
    skillsDirForPlugin = join(dir, 'skills');
    plugRoot = join(dir, 'plugins');
    pluginHook = createFileBoundaryHook(memory, skillsDirForPlugin, plugRoot);
    await mkdir(join(plugRoot, 'demo', 'skills', 'review', 'references'), { recursive: true });
    await writeFile(join(plugRoot, 'demo', 'skills', 'review', 'SKILL.md'), '# review');
    await writeFile(join(plugRoot, 'demo', 'skills', 'review', 'references', 'a.md'), '# a');
    await mkdir(join(plugRoot, 'demo', '.claude-plugin'), { recursive: true });
    await writeFile(join(plugRoot, 'demo', '.claude-plugin', 'plugin.json'), '{}');
    await writeFile(join(plugRoot, 'demo', 'private.md'), '# private');
  });

  const read = (tool: string, file_path: string, agentId?: string) =>
    pluginHook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '/tmp/t',
        cwd: memory,
        tool_name: tool,
        tool_input: { file_path },
        tool_use_id: 't',
        ...(agentId === undefined ? {} : { agent_id: agentId }),
      },
      'tool',
      { signal: new AbortController().signal },
    );

  it('lets the main session read a plugin skill body and its resources', async () => {
    expect(
      await read('Read', join(plugRoot, 'demo', 'skills', 'review', 'SKILL.md')),
    ).toMatchObject(decision('allow'));
    expect(
      await read('Read', join(plugRoot, 'demo', 'skills', 'review', 'references', 'a.md')),
    ).toMatchObject(decision('allow'));
  });

  it('rejects sub-agent reads and linked plugin resources', async () => {
    const skillRoot = join(plugRoot, 'demo', 'skills', 'review');
    expect(await read('Read', join(skillRoot, 'SKILL.md'), 'child')).toMatchObject(
      decision('deny'),
    );
    await symlink(join(dir, 'outside.md'), join(skillRoot, 'linked.md'));
    await link(join(dir, 'outside.md'), join(skillRoot, 'hardlinked.md'));
    for (const name of ['linked.md', 'hardlinked.md']) {
      expect(await read('Read', join(skillRoot, name))).toMatchObject(decision('deny'));
    }
  });

  it('keeps plugin files read-only and out of the plugin root itself', async () => {
    for (const [tool, path] of [
      ['Write', join(plugRoot, 'demo', 'skills', 'review', 'SKILL.md')],
      ['Edit', join(plugRoot, 'demo', 'skills', 'review', 'SKILL.md')],
      ['Read', join(plugRoot, 'demo', '.claude-plugin', 'plugin.json')],
      ['Read', join(plugRoot, 'demo', 'private.md')],
      ['Read', join(plugRoot, 'demo', 'skills', 'review', 'notes.json')],
    ] as const) {
      expect(await read(tool, path), `${tool} ${path}`).toMatchObject(decision('deny'));
    }
  });
});

describe('personal memory prompt injection', () => {
  const file = () => join(dir, 'user', 'CLAUDE.md');
  const event = (): UserPromptSubmitHookInput => ({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session',
    transcript_path: '/tmp/transcript',
    cwd: '/workspace',
    prompt: 'hi',
  });
  const call = (
    hook: ReturnType<typeof createPersonalMemoryHook>,
  ): Promise<Awaited<ReturnType<ReturnType<typeof createPersonalMemoryHook>>>> =>
    hook(event(), undefined, { signal: new AbortController().signal });

  it('returns nothing when the file is missing or blank', async () => {
    const hook = createPersonalMemoryHook(file());
    expect(await call(hook)).toEqual({});
    await mkdir(join(dir, 'user'));
    await writeFile(file(), '  \n');
    expect(await call(hook)).toEqual({});
  });

  it('injects the exact file content and re-reads it every turn', async () => {
    await mkdir(join(dir, 'user'));
    const hook = createPersonalMemoryHook(file());
    await writeFile(file(), '# 偏好\n\n喜欢简洁的答复。\n');
    expect(await call(hook)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '# 偏好\n\n喜欢简洁的答复。\n',
      },
    });
    await writeFile(file(), '恢复会话后的新内容');
    expect(await call(hook)).toMatchObject({
      hookSpecificOutput: { additionalContext: '恢复会话后的新内容' },
    });
  });

  it('injects 9000 Unicode characters and blocks one more', async () => {
    await mkdir(join(dir, 'user'));
    const hook = createPersonalMemoryHook(file());
    const atLimit = '界'.repeat(PERSONAL_MEMORY_MAX_CHARS);
    await writeFile(file(), atLimit);
    expect(await call(hook)).toMatchObject({
      hookSpecificOutput: { additionalContext: atLimit },
    });

    await writeFile(file(), '界'.repeat(PERSONAL_MEMORY_MAX_CHARS + 1));
    const result = await call(hook);
    expect(result).toMatchObject({ decision: 'block' });
    expect((result as { reason?: string }).reason).toBe('个人偏好最多 9000 个字符，本轮未启动');
  });

  it('blocks a file above the 36 KiB byte guard', async () => {
    await mkdir(join(dir, 'user'));
    await writeFile(file(), 'x'.repeat(PERSONAL_MEMORY_MAX_BYTES + 1));
    const errors: string[] = [];
    const result = await call(createPersonalMemoryHook(file(), (message) => errors.push(message)));
    expect(result).toMatchObject({ decision: 'block' });
    expect((result as { reason?: string }).reason).toBe('个人偏好最多 9000 个字符，本轮未启动');
    expect(errors).toHaveLength(1);
  });

  it('blocks symlinked personal memory instead of following it', async () => {
    await mkdir(join(dir, 'user'));
    await symlink(join(dir, 'outside.md'), file());
    const errors: string[] = [];
    const result = await call(createPersonalMemoryHook(file(), (message) => errors.push(message)));
    expect(result).toMatchObject({ decision: 'block' });
    expect(errors).toHaveLength(1);
  });

  it('ignores non-prompt hook events', async () => {
    const hook = createPersonalMemoryHook(file());
    expect(
      await hook(
        {
          hook_event_name: 'Stop',
          session_id: 's',
          transcript_path: '/tmp/t',
          cwd: '/workspace',
          stop_hook_active: false,
        },
        undefined,
        { signal: new AbortController().signal },
      ),
    ).toEqual({});
  });
});
