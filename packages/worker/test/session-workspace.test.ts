import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSessionWorkspace, refreshSessionDirectory } from '../src/session-workspace.js';

let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
describe('stable session workspace', () => {
  it('precreates sorted child memory hosts and in-workspace mount targets', async () => {
    root = await mkdtemp(join(tmpdir(), 'session-workspace-'));
    const paths = await ensureSessionWorkspace({
      workspacesDir: root,
      slug: 'demo',
      conversationId: 'conversation-1',
      subAgentSlugs: ['child-b', 'child-a'],
    });
    expect(paths.subAgentMemoryDirs).toEqual([
      { slug: 'child-a', memoryDir: join(root, 'child-a', 'agent-memory') },
      { slug: 'child-b', memoryDir: join(root, 'child-b', 'agent-memory') },
    ]);
    for (const slug of ['child-a', 'child-b']) {
      const host = await lstat(join(root, slug, 'agent-memory'));
      expect(host.isDirectory()).toBe(true);
      expect(host.isSymbolicLink()).toBe(false);
      const target = await lstat(join(paths.workspaceDir, '.claude', 'agent-memory', slug));
      expect(target.isDirectory()).toBe(true);
    }
  });

  it('rejects a symlinked child memory host', async () => {
    root = await mkdtemp(join(tmpdir(), 'session-workspace-'));
    await mkdir(join(root, 'child'));
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(root, 'child', 'agent-memory'));
    await expect(
      ensureSessionWorkspace({
        workspacesDir: root,
        slug: 'demo',
        conversationId: 'conversation-1',
        subAgentSlugs: ['child'],
      }),
    ).rejects.toThrow(/real directory/);
  });

  it('keeps the child memory mount subtree and its inodes while refreshing definitions', async () => {
    root = await mkdtemp(join(tmpdir(), 'session-workspace-'));
    const paths = await ensureSessionWorkspace({
      workspacesDir: root,
      slug: 'demo',
      conversationId: 'conversation-1',
      subAgentSlugs: ['child'],
    });
    const memory = join(paths.workspaceDir, '.claude', 'agent-memory', 'child');
    await writeFile(join(memory, 'MEMORY.md'), 'kept');
    const inode = async (path: string) => (await stat(path)).ino;
    const inodes = {
      workspace: await inode(paths.workspaceDir),
      claude: await inode(join(paths.workspaceDir, '.claude')),
      memory: await inode(join(paths.workspaceDir, '.claude', 'agent-memory')),
      child: await inode(memory),
    };

    const source = join(root, 'rendered');
    await mkdir(join(source, '.claude/skills/old'), { recursive: true });
    await writeFile(join(source, '.claude/skills/old/SKILL.md'), 'old');
    await writeFile(join(source, '.mcp.json'), 'first-token');
    await refreshSessionDirectory(source, paths.workspaceDir, { preserveMemoryMount: true });

    // 来源即使带了同名记忆目录也不得覆盖挂载子树。
    await rm(join(source, '.claude/skills/old'), { recursive: true });
    await mkdir(join(source, '.claude/agent-memory/child'), { recursive: true });
    await writeFile(join(source, '.claude/agent-memory/child/MEMORY.md'), 'from-source');
    await writeFile(join(source, '.claude/settings.json'), 'settings');
    await writeFile(join(source, '.mcp.json'), 'second-token');
    await refreshSessionDirectory(source, paths.workspaceDir, { preserveMemoryMount: true });

    expect(await inode(paths.workspaceDir)).toBe(inodes.workspace);
    expect(await inode(join(paths.workspaceDir, '.claude'))).toBe(inodes.claude);
    expect(await inode(join(paths.workspaceDir, '.claude', 'agent-memory'))).toBe(inodes.memory);
    expect(await inode(memory)).toBe(inodes.child);
    expect(await readFile(join(memory, 'MEMORY.md'), 'utf8')).toBe('kept');
    await expect(lstat(join(paths.workspaceDir, '.claude/skills/old'))).rejects.toThrow(/ENOENT/);
    expect(await readFile(join(paths.workspaceDir, '.claude/settings.json'), 'utf8')).toBe(
      'settings',
    );
    expect(await readFile(join(paths.workspaceDir, '.mcp.json'), 'utf8')).toBe('second-token');
  });

  it('fully replaces output sources, including a same-named agent-memory directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'session-workspace-'));
    const paths = await ensureSessionWorkspace({
      workspacesDir: root,
      slug: 'demo',
      conversationId: 'conversation-1',
    });
    // 产出目录没有挂载根，`.claude/agent-memory` 只是用户文件，必须随来源整棵复制。
    const source = join(root, 'rendered-outputs');
    await mkdir(join(source, '.claude/agent-memory'), { recursive: true });
    await writeFile(join(source, '.claude/agent-memory/note.md'), 'first');
    await writeFile(join(source, 'report.md'), 'one');
    await refreshSessionDirectory(source, paths.outputsDir);
    expect(await readFile(join(paths.outputsDir, '.claude/agent-memory/note.md'), 'utf8')).toBe(
      'first',
    );

    // 下一版本要覆盖同名目录里的旧内容。
    await writeFile(join(source, '.claude/agent-memory/note.md'), 'second');
    await writeFile(join(source, 'report.md'), 'two');
    await refreshSessionDirectory(source, paths.outputsDir);
    expect(await readFile(join(paths.outputsDir, '.claude/agent-memory/note.md'), 'utf8')).toBe(
      'second',
    );
    expect(await readFile(join(paths.outputsDir, 'report.md'), 'utf8')).toBe('two');

    // 来源删除后目标同步删除，不保留上一版残留。
    await rm(join(source, '.claude'), { recursive: true });
    await refreshSessionDirectory(source, paths.outputsDir);
    await expect(lstat(join(paths.outputsDir, '.claude'))).rejects.toThrow(/ENOENT/);
  });

  it('copies a regular .claude file from an output source', async () => {
    root = await mkdtemp(join(tmpdir(), 'session-workspace-'));
    const paths = await ensureSessionWorkspace({
      workspacesDir: root,
      slug: 'demo',
      conversationId: 'conversation-1',
    });
    const source = join(root, 'rendered-outputs');
    await mkdir(source);
    await writeFile(join(source, '.claude'), 'artifact');
    await writeFile(join(source, 'report.md'), 'one');
    await refreshSessionDirectory(source, paths.outputsDir);
    expect(await readFile(join(paths.outputsDir, '.claude'), 'utf8')).toBe('artifact');
    expect(await readFile(join(paths.outputsDir, 'report.md'), 'utf8')).toBe('one');
  });

  it('replaces a leftover regular .claude from a previous output version', async () => {
    root = await mkdtemp(join(tmpdir(), 'session-workspace-'));
    const paths = await ensureSessionWorkspace({
      workspacesDir: root,
      slug: 'demo',
      conversationId: 'conversation-1',
    });
    await writeFile(join(paths.outputsDir, '.claude'), 'legacy');
    await writeFile(join(paths.outputsDir, 'stale.txt'), 'stale');
    const source = join(root, 'rendered-outputs');
    await mkdir(source);
    await writeFile(join(source, 'report.md'), 'fresh');
    await refreshSessionDirectory(source, paths.outputsDir);
    expect(await readFile(join(paths.outputsDir, 'report.md'), 'utf8')).toBe('fresh');
    await expect(lstat(join(paths.outputsDir, '.claude'))).rejects.toThrow(/ENOENT/);
    await expect(lstat(join(paths.outputsDir, 'stale.txt'))).rejects.toThrow(/ENOENT/);
  });

  it('refreshes all official files and removes unbound skills without replacing mount roots', async () => {
    root = await mkdtemp(join(tmpdir(), 'session-workspace-'));
    const paths = await ensureSessionWorkspace({
      workspacesDir: root,
      slug: 'demo',
      conversationId: 'conversation-1',
    });
    const source = join(root, 'rendered');
    await mkdir(join(source, '.claude/skills/old'), { recursive: true });
    await writeFile(join(source, '.claude/skills/old/SKILL.md'), 'old');
    await writeFile(join(source, '.mcp.json'), 'first-token');
    const inode = (await stat(paths.workspaceDir)).ino;
    await refreshSessionDirectory(source, paths.workspaceDir);
    await rm(join(source, '.claude/skills/old'), { recursive: true });
    await mkdir(join(source, '.claude/plugins/native/.claude-plugin'), { recursive: true });
    await writeFile(join(source, '.claude/plugins/native/.claude-plugin/plugin.json'), 'plugin');
    await writeFile(join(source, '.claude/settings.json'), 'settings');
    await writeFile(join(source, '.mcp.json'), 'second-token');
    await refreshSessionDirectory(source, paths.workspaceDir);
    expect((await stat(paths.workspaceDir)).ino).toBe(inode);
    await expect(lstat(join(paths.workspaceDir, '.claude/skills/old'))).rejects.toThrow(/ENOENT/);
    expect(await readFile(join(paths.workspaceDir, '.mcp.json'), 'utf8')).toBe('second-token');
    expect(await readFile(join(paths.workspaceDir, '.claude/settings.json'), 'utf8')).toBe(
      'settings',
    );
    expect(
      await readFile(
        join(paths.workspaceDir, '.claude/plugins/native/.claude-plugin/plugin.json'),
        'utf8',
      ),
    ).toBe('plugin');
    expect((await stat(paths.outputsDir)).isDirectory()).toBe(true);
  });

  it('precreates inputs even for an attachment-free first turn', async () => {
    root = await mkdtemp(join(tmpdir(), 'session-workspace-'));
    const paths = await ensureSessionWorkspace({
      workspacesDir: root,
      slug: 'demo',
      conversationId: 'conversation-1',
    });
    expect((await stat(paths.inputsDir)).isDirectory()).toBe(true);
    await writeFile(join(paths.inputsDir, 'later.txt'), 'new attachment');
    const again = await ensureSessionWorkspace({
      workspacesDir: root,
      slug: 'demo',
      conversationId: 'conversation-1',
    });
    expect(again.inputsDir).toBe(paths.inputsDir);
    expect(await readFile(join(again.inputsDir, 'later.txt'), 'utf8')).toBe('new attachment');
  });

  it('precreates the private personal memory directory at the workspace root', async () => {
    root = await mkdtemp(join(tmpdir(), 'session-workspace-'));
    const paths = await ensureSessionWorkspace({
      workspacesDir: root,
      slug: 'demo',
      conversationId: 'conversation-1',
    });
    expect(paths.personalDir).toBe(join(root, '_user'));
    const info = await stat(paths.personalDir);
    expect(info.isDirectory()).toBe(true);
    expect(info.mode & 0o777).toBe(0o700);
  });

  it('rejects a symlinked personal directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'session-workspace-'));
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, '_user'));
    await expect(
      ensureSessionWorkspace({
        workspacesDir: root,
        slug: 'demo',
        conversationId: 'conversation-1',
      }),
    ).rejects.toThrow(/real directory/);
  });

  it('rejects links before clearing the existing mount content', async () => {
    root = await mkdtemp(join(tmpdir(), 'session-workspace-'));
    const paths = await ensureSessionWorkspace({
      workspacesDir: root,
      slug: 'demo',
      conversationId: 'conversation-1',
    });
    await writeFile(join(paths.outputsDir, 'existing.txt'), 'preserved');
    const source = join(root, 'unsafe');
    await mkdir(source);
    await symlink('/etc/passwd', join(source, 'link'));
    await expect(refreshSessionDirectory(source, paths.outputsDir)).rejects.toThrow(
      /link|regular/i,
    );
    expect(await readFile(join(paths.outputsDir, 'existing.txt'), 'utf8')).toBe('preserved');
  });
});
