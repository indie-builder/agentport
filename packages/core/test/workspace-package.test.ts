import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import type { WorkspaceFiles } from '../src/workspace.js';
import { renderWorkspace } from '../src/workspace.js';
import {
  ARCHIVE_LIMITS,
  buildWorkspaceArchive,
  parseWorkspaceArchive,
} from '../src/workspace-package.js';

const agent = {
  slug: 'assistant',
  name: '助手',
  model: 'claude-sonnet-5-5',
  systemPrompt: '你是助手。',
  maxTurns: 9,
  permissionMode: 'dontAsk',
};

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])),
  );
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).code;
  }
  throw new Error('expected AppError');
}

/** 改写本地文件头声明的解压后大小，模拟「声明长度与实际不符」的压缩炸弹。 */
function patchDeclaredSize(archive: Uint8Array, name: string, size: number): Uint8Array {
  const copy = archive.slice();
  const view = new DataView(copy.buffer);
  const needle = strToU8(name);
  for (let i = 0; i + 30 <= copy.length; i += 1) {
    if (view.getUint32(i, true) !== 0x04034b50) continue;
    if (view.getUint16(i + 26, true) !== needle.length) continue;
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (copy[i + 30 + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    view.setUint32(i + 22, size, true);
    return copy;
  }
  throw new Error(`local header not found: ${name}`);
}

/** 改写中央目录声明的条目数，模拟声明与实际不符的归档。 */
function patchEntryCount(archive: Uint8Array, count: number): Uint8Array {
  const copy = archive.slice();
  const view = new DataView(copy.buffer);
  for (let i = copy.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) !== 0x06054b50) continue;
    view.setUint16(i + 10, count, true);
    return copy;
  }
  throw new Error('EOCD not found');
}

function fullFiles(): WorkspaceFiles {
  return renderWorkspace({
    agent,
    servers: [
      {
        name: 'docs',
        entry: { command: 'node', args: ['server.js'], env: { TOKEN: '[redacted]' } },
      },
    ],
    skills: [
      {
        slug: 'deploy',
        name: '部署',
        description: '发布到生产环境',
        body: '按步骤执行。',
        files: [{ path: 'references/中文说明.md', content: '# 说明\n\n中文内容。' }],
      },
    ],
    subAgents: [
      {
        slug: 'worker',
        name: '执行者',
        description: '负责执行具体任务',
        model: 'claude-haiku-4-5',
        systemPrompt: '你负责执行。',
        maxTurns: 4,
        permissionMode: 'plan',
        allowedTools: [],
        disallowedTools: [],
      },
    ],
    rules: [{ slug: 'api', content: '# API 规则', globs: 'src/**/*.{ts,tsx}, docs/**' }],
    outputStyles: [
      { slug: 'review', description: '代码评审', keepCodingInstructions: true, body: '严格评审。' },
    ],
    selectedOutputStyle: 'review',
  });
}

describe('buildWorkspaceArchive', () => {
  it('writes the official .claude layout with the root prompt instead of the runtime CLAUDE.md', () => {
    const files = fullFiles();
    const archive = buildWorkspaceArchive({
      files,
      agent: { name: agent.name, systemPrompt: agent.systemPrompt },
    });
    const entries = unzipSync(archive);
    const names = Object.keys(entries).sort();

    expect(names).toEqual([
      '.claude/agents/worker.md',
      '.claude/output-styles/review.md',
      '.claude/rules/api.md',
      '.claude/settings.json',
      '.claude/skills/deploy/SKILL.md',
      '.claude/skills/deploy/references/中文说明.md',
      '.mcp.json',
      'CLAUDE.md',
    ]);
    expect(strFromU8(entries['CLAUDE.md'] as Uint8Array)).toBe('# 助手\n\n你是助手。\n');
    expect(strFromU8(entries['CLAUDE.md'] as Uint8Array)).not.toContain('## 工具使用');
  });

  it('omits settings.json when there is no settings content', () => {
    const files = { ...fullFiles(), selectedOutputStyle: null, settingsJson: null };
    const entries = unzipSync(
      buildWorkspaceArchive({ files, agent: { name: '助手', systemPrompt: '你是助手。' } }),
    );
    expect(entries['.claude/settings.json']).toBeUndefined();
  });
});

describe('parseWorkspaceArchive', () => {
  it('round-trips agents, subagents, skills, rules, output styles, MCP and settings', () => {
    const files = fullFiles();
    const parsed = parseWorkspaceArchive(
      buildWorkspaceArchive({
        files,
        agent: { name: agent.name, systemPrompt: agent.systemPrompt },
      }),
    );

    expect(parsed.agent).toEqual({ name: '助手', systemPrompt: '你是助手。' });
    expect(parsed.mcp).toEqual({
      docs: { command: 'node', args: ['server.js'], env: { TOKEN: '[redacted]' } },
    });
    expect(parsed.settings).toEqual({ outputStyle: 'review' });

    expect(parsed.subAgents).toHaveLength(1);
    expect(parsed.subAgents[0]).toMatchObject({
      slug: 'worker',
      name: 'worker',
      description: '负责执行具体任务',
      model: 'claude-haiku-4-5',
      permissionMode: 'plan',
      maxTurns: 4,
      allowedTools: [],
      skills: [],
    });
    expect(parsed.subAgents[0]?.systemPrompt).toContain('你负责执行。');
    expect(parsed.subAgents[0]?.disallowedTools).toContain('Read');

    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0]).toEqual({
      slug: 'deploy',
      name: '部署',
      description: '发布到生产环境',
      body: '按步骤执行。',
      files: [{ path: 'references/中文说明.md', content: '# 说明\n\n中文内容。' }],
    });

    expect(parsed.rules).toEqual([
      { slug: 'api', content: '# API 规则', globs: 'src/**/*.{ts,tsx}, docs/**' },
    ]);
    expect(parsed.outputStyles).toEqual([
      {
        slug: 'review',
        description: '代码评审',
        keepCodingInstructions: true,
        body: '严格评审。',
        isSelected: true,
      },
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it('keeps skill license, compatibility and metadata', () => {
    const archive = zip({
      'CLAUDE.md': '# A\n\nprompt\n',
      '.mcp.json': '{}',
      '.claude/skills/s/SKILL.md':
        '---\nname: s\ndescription: d\nlicense: MIT\ncompatibility: ">=1"\nmetadata:\n  owner: team\n---\n\n# S\n\nbody\n',
    });
    const parsed = parseWorkspaceArchive(archive);
    expect(parsed.skills[0]).toMatchObject({
      slug: 's',
      name: 'S',
      license: 'MIT',
      compatibility: '>=1',
      metadata: { owner: 'team' },
    });
  });

  it('uses settings model and defaultMode as subagent defaults', () => {
    const archive = zip({
      'CLAUDE.md': '# A\n\nprompt\n',
      '.mcp.json': '{}\n',
      '.claude/settings.json': JSON.stringify({
        model: 'claude-opus-5-5',
        permissions: { defaultMode: 'plan' },
      }),
      '.claude/agents/child.md': '---\nname: child\ndescription: d\n---\n\nchild prompt\n',
    });
    const parsed = parseWorkspaceArchive(archive);
    expect(parsed.settings).toEqual({
      model: 'claude-opus-5-5',
      permissions: { defaultMode: 'plan' },
    });
    expect(parsed.subAgents[0]).toMatchObject({
      model: 'claude-opus-5-5',
      permissionMode: 'plan',
    });
  });

  it('accepts an empty .mcp.json', () => {
    const parsed = parseWorkspaceArchive(zip({ 'CLAUDE.md': '# A\n\nprompt\n', '.mcp.json': '' }));
    expect(parsed.mcp).toEqual({});
    expect(parsed.settings).toEqual({});
  });

  it('resolves a subagent model: inherit to the parent model from settings', () => {
    const parsed = parseWorkspaceArchive(
      zip({
        'CLAUDE.md': '# A\n\nprompt\n',
        '.mcp.json': '{}',
        '.claude/settings.json': JSON.stringify({ model: 'claude-opus-5-5' }),
        '.claude/agents/child.md':
          '---\nname: child\ndescription: d\nmodel: inherit\n---\n\nchild prompt\n',
      }),
    );
    expect(parsed.subAgents[0]?.model).toBe('claude-opus-5-5');
  });

  it('uses the platform default when inherit has no parent model to resolve', () => {
    const parsed = parseWorkspaceArchive(
      zip({
        'CLAUDE.md': '# A\n\nprompt\n',
        '.mcp.json': '{}',
        '.claude/agents/child.md':
          '---\nname: child\ndescription: d\nmodel: inherit\n---\n\nchild prompt\n',
      }),
    );
    expect(parsed.subAgents[0]?.model).toBe('claude-sonnet-5-5');
  });

  it('rejects an archive truncated before the central directory', () => {
    const archive = zip({
      'CLAUDE.md': '# A\n\nprompt\n',
      '.mcp.json': '{}',
      '.claude/agents/child.md': '---\nname: child\ndescription: d\n---\n\nchild prompt\n',
    });
    // 截掉 EOCD 后 fflate 仍会正常结束；完整性由中央目录校验兜底。
    expect(errorCode(() => parseWorkspaceArchive(archive.slice(0, archive.length - 10)))).toBe(
      'INVALID_INPUT',
    );
  });

  it('rejects an archive whose declared entry count differs from the actual entries', () => {
    const archive = zip({ 'CLAUDE.md': '# A\n\nprompt\n', '.mcp.json': '{}' });
    expect(errorCode(() => parseWorkspaceArchive(patchEntryCount(archive, 3)))).toBe(
      'INVALID_INPUT',
    );
  });

  it('rejects a compression bomb whose declared size hides the real output', () => {
    const archive = patchDeclaredSize(
      zip({
        'CLAUDE.md': '# A\n\nprompt\n',
        '.mcp.json': '{}',
        '.claude/skills/s/bomb.txt': 'x'.repeat(2 * 1024 * 1024),
      }),
      '.claude/skills/s/bomb.txt',
      10,
    );
    expect(errorCode(() => parseWorkspaceArchive(archive))).toBe('PAYLOAD_TOO_LARGE');
  });

  it('streams a file whose compressed data spans multiple pushes', () => {
    let seed = 123456789;
    const body = Array.from({ length: 100_000 }, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return String.fromCharCode(33 + (seed % 90));
    }).join('');
    const parsed = parseWorkspaceArchive(
      zip({
        'CLAUDE.md': '# A\n\nprompt\n',
        '.mcp.json': '{}',
        '.claude/skills/s/SKILL.md': '---\nname: s\ndescription: d\n---\n\n# S\n\nbody\n',
        '.claude/skills/s/notes.txt': body,
      }),
    );
    expect(parsed.skills[0]?.files[0]?.content).toBe(body);
  });

  it('keeps a section named 工具使用 inside the root prompt', () => {
    const parsed = parseWorkspaceArchive(
      zip({
        'CLAUDE.md': '# A\n\nprompt\n\n## 工具使用\n\n- 先读文件。\n',
        '.mcp.json': '{}',
      }),
    );
    expect(parsed.agent.name).toBe('A');
    expect(parsed.agent.systemPrompt).toBe('prompt\n\n## 工具使用\n\n- 先读文件。');
  });

  it('rejects path traversal', () => {
    const archive = zip({
      'CLAUDE.md': '# A\n\nprompt\n',
      '../evil.md': 'x',
    });
    expect(errorCode(() => parseWorkspaceArchive(archive))).toBe('INVALID_INPUT');
  });

  it('rejects case-insensitive duplicate paths', () => {
    const archive = zip({ 'CLAUDE.md': '# A\n\nprompt\n', 'claude.md': '# B\n\nprompt\n' });
    expect(errorCode(() => parseWorkspaceArchive(archive))).toBe('INVALID_INPUT');
  });

  it('rejects unknown files instead of dropping them', () => {
    expect(errorCode(() => parseWorkspaceArchive(zip({ 'README.md': 'x' })))).toBe('INVALID_INPUT');
  });

  it('requires CLAUDE.md', () => {
    expect(errorCode(() => parseWorkspaceArchive(zip({ '.mcp.json': '{}' })))).toBe(
      'INVALID_INPUT',
    );
  });

  it('rejects an archive over the compressed size limit', () => {
    expect(
      errorCode(() => parseWorkspaceArchive(new Uint8Array(ARCHIVE_LIMITS.archiveBytes + 1))),
    ).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects a single file over the per-file limit', () => {
    const archive = zip({ 'CLAUDE.md': `# A\n\n${'x'.repeat(ARCHIVE_LIMITS.fileBytes)}` });
    expect(errorCode(() => parseWorkspaceArchive(archive))).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects an archive over the unpacked size limit', () => {
    const files: Record<string, string> = { 'CLAUDE.md': '# A\n\nprompt\n', '.mcp.json': '{}' };
    for (let i = 0; i < 9; i += 1) {
      files[`.claude/skills/s/files/${i}.txt`] = 'x'.repeat(ARCHIVE_LIMITS.fileBytes);
    }
    expect(errorCode(() => parseWorkspaceArchive(zip(files)))).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects too many entries', () => {
    const files: Record<string, string> = { 'CLAUDE.md': '# A\n\nprompt\n', '.mcp.json': '{}' };
    for (let i = 0; i <= ARCHIVE_LIMITS.entries; i += 1) files[`f${i}.txt`] = '';
    expect(errorCode(() => parseWorkspaceArchive(zip(files)))).toBe('PAYLOAD_TOO_LARGE');
  });

  it('drops force-for-plugin with a warning', () => {
    const parsed = parseWorkspaceArchive(
      zip({
        'CLAUDE.md': '# A\n\nprompt\n',
        '.claude/output-styles/x.md':
          '---\nname: x\nforce-for-plugin: true\nkeep-coding-instructions: false\n---\n\nbody\n',
      }),
    );
    expect(parsed.outputStyles[0]?.isSelected).toBe(false);
    expect(parsed.warnings.join()).toContain('force-for-plugin');
  });
});
