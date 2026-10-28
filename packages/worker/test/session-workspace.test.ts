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
