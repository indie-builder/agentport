import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  installPlugin,
  listNativePlugins,
  readPlugin,
  runNativePluginAction,
} from '../src/native-plugins.js';

/**
 * fake CLI：用 argv 决定行为，install 时按真实 CLI 的形态在缓存目录写插件。
 * 只替换子进程边界，其余解析、路径校验与快照逻辑都走真实代码。
 */
const FAKE_CLI = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const cache = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
// CLI 只拿白名单环境（FAKE_* 不会传进来），行为开关改从配置目录读。
const flagsFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'fake-flags.json');
const flags = fs.existsSync(flagsFile) ? JSON.parse(fs.readFileSync(flagsFile, 'utf8')) : {};
const [command, sub, ...rest] = process.argv.slice(2);
if (command !== 'plugin') process.exit(9);
const dbFile = path.join(cache, 'fake-installed.json');
const db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : [];
function save(next) {
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(dbFile, JSON.stringify(next));
}
if (sub === 'list') {
  process.stdout.write(JSON.stringify(flags.listOverride ?? db));
} else if (sub === 'install') {
  const plugin = rest[0];
  if (flags.fail === true) {
    process.stdout.write(JSON.stringify({ command: 'install', outcome: 'failed', message: 'fixture refusal', failureCode: 'not_found', shownCommand: { command: 'curl evil' } }) + '\\n');
    process.exit(1);
  }
  if (flags.garbage === true) {
    process.stdout.write('not json\\n');
    process.exit(0);
  }
  const id = plugin + '@fixture-market';
  const dir = path.join(cache, 'cache', 'fixture-market', plugin, '1.2.3');
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: plugin, version: '1.2.3' }));
  fs.writeFileSync(path.join(dir, 'hooks', 'run.sh'), '#!/bin/sh\\necho hi\\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, '.orphaned_at'), 'marker');
  if (flags.symlink === true) fs.symlinkSync('/etc/passwd', path.join(dir, 'leak'));
  if (flags.binary === true) fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2]));
  if (flags.nodeModules === true) fs.mkdirSync(path.join(dir, 'node_modules'));
  const installPath = typeof flags.installPath === 'string' ? flags.installPath : dir;
  save([{ id, version: '1.2.3', scope: 'user', installPath }]);
  process.stdout.write(JSON.stringify({ command: 'install', outcome: 'ok', plugin: id, pluginId: id, scope: 'user' }) + '\\n');
} else {
  process.exit(9);
}
`;

let root = '';
let cliPath = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'native-plugin-runner-'));
  cliPath = join(root, 'fake-cli.mjs');
  await writeFile(cliPath, FAKE_CLI, { mode: 0o755 });
  await chmod(cliPath, 0o755);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

interface CaseOptions {
  cliPath: string;
  cacheRoot: string;
}

/** 每个用例独立的缓存根；行为开关写进 CLI 会读的配置目录。 */
async function options(flags: Record<string, unknown> = {}): Promise<CaseOptions> {
  const dir = await mkdtemp(join(root, 'case-'));
  const cacheRoot = join(dir, 'cache-root');
  await mkdir(join(cacheRoot, 'config'), { recursive: true });
  if (Object.keys(flags).length > 0) {
    await writeFile(join(cacheRoot, 'config', 'fake-flags.json'), JSON.stringify(flags));
  }
  return { cliPath, cacheRoot };
}

describe('native plugin sandbox runner', () => {
  it('lists installed plugins without host paths', async () => {
    const opts = await options();
    const installed = await installPlugin({ marketplace: 'owner/repo', plugin: 'demo' }, opts);

    expect(installed.ok).toBe(true);
    expect(await listNativePlugins(opts)).toEqual({
      ok: true,
      installed: [{ pluginId: 'demo@fixture-market', version: '1.2.3' }],
    });
  });

  it('installs once and snapshots text files with the executable bit', async () => {
    const opts = await options();
    const output = await installPlugin({ marketplace: 'owner/repo', plugin: 'demo' }, opts);

    expect(output).toMatchObject({
      ok: true,
      plugin: { pluginId: 'demo@fixture-market', version: '1.2.3' },
    });
    if (!output.ok || !('files' in output)) throw new Error('expected snapshot');
    // .orphaned_at 是官方内部标记，其余文件全部保留。
    expect(output.files.map((file) => file.path)).toEqual([
      '.claude-plugin/plugin.json',
      'hooks/run.sh',
    ]);
    expect(output.files.find((file) => file.path === 'hooks/run.sh')?.executable).toBe(true);
  });

  it('reads an already installed plugin without running install again', async () => {
    const opts = await options();
    await installPlugin({ marketplace: 'owner/repo', plugin: 'demo' }, opts);

    expect(await readPlugin('demo@fixture-market', opts)).toMatchObject({
      ok: true,
      plugin: { pluginId: 'demo@fixture-market' },
    });
  });

  it('reports a missing plugin instead of an empty snapshot', async () => {
    const opts = await options();
    expect(await readPlugin('absent@fixture-market', opts)).toEqual({
      ok: false,
      error: '读取失败：插件未安装：absent@fixture-market',
    });
  });

  it('turns a CLI refusal into a phase error without leaking the shown command', async () => {
    const opts = await options({ fail: true });
    const output = await runNativePluginAction(
      { action: 'install', marketplace: 'owner/repo', plugin: 'demo' },
      opts,
    );

    expect(output).toEqual({
      ok: false,
      error: '安装失败：fixture refusal（not_found）；市场要求执行的命令需要人工确认，未自动执行',
    });
    expect(JSON.stringify(output)).not.toContain('curl evil');
  });

  it('rejects garbage install output', async () => {
    const opts = await options({ garbage: true });
    expect(
      await runNativePluginAction(
        { action: 'install', marketplace: 'owner/repo', plugin: 'demo' },
        opts,
      ),
    ).toEqual({ ok: false, error: '安装失败：CLI 安装结果不是合法 JSON' });
  });

  it('refuses symlinks, binaries and node_modules instead of dropping them', async () => {
    for (const [flag, expected] of [
      ['symlink', '符号链接'],
      ['binary', '二进制'],
      ['nodeModules', 'node_modules'],
    ] as const) {
      const opts = await options({ [flag]: true });
      const output = await installPlugin({ marketplace: 'owner/repo', plugin: 'demo' }, opts);

      expect(output.ok).toBe(false);
      if (!output.ok) expect(output.error).toContain(expected);
    }
  });

  it('rejects an installPath outside the cache root', async () => {
    const opts = await options({ installPath: '/etc' });
    expect(await installPlugin({ marketplace: 'owner/repo', plugin: 'demo' }, opts)).toEqual({
      ok: false,
      error: '读取失败：插件目录不在平台缓存内',
    });
  });
});
