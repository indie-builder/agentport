import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listNativePlugins, readPlugin, resolveNativeCli } from '../src/native-plugins.js';

// 真实 CLI 的启动开销小，30s 足够覆盖冷启动。
const TIMEOUT = 30_000;

/**
 * 真实 CLI 的 list/read 不得联网。macOS 上用一个先安装好插件的临时缓存，
 * 在 deny network 的 sandbox 里跑同一个 CLI，确认只有本地文件被读取。
 * 非 macOS 没有等价的轻量网络隔离，跳过而不是假装验证过。
 */
const canDenyNetwork = process.platform === 'darwin' && !process.env.CI;

async function marketFixture(root: string): Promise<string> {
  const market = join(root, 'market');
  const plugin = join(market, 'plugins', 'demo');
  await mkdir(join(market, '.claude-plugin'), { recursive: true });
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
  await mkdir(join(plugin, 'skills', 'hello'), { recursive: true });
  await writeFile(
    join(market, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'fixture-market',
      owner: { name: 'Fixture' },
      plugins: [{ name: 'demo', source: './plugins/demo' }],
    }),
  );
  await writeFile(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', version: '1.2.3' }),
  );
  await writeFile(
    join(plugin, 'skills', 'hello', 'SKILL.md'),
    '---\nname: hello\ndescription: Fixture skill.\n---\n\nNo-op.\n',
  );
  return market;
}

describe.skipIf(!canDenyNetwork)('offline reads', () => {
  it(
    'lists and reads an installed plugin with network denied',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'native-plugin-offline-'));
      try {
        const cacheRoot = join(root, 'cache-root');
        const market = await marketFixture(root);
        const cli = resolveNativeCli();
        const env = {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: '/tmp',
          TMPDIR: '/tmp',
          LANG: 'C.UTF-8',
          CLAUDE_CONFIG_DIR: join(cacheRoot, 'config'),
          CLAUDE_CODE_PLUGIN_CACHE_DIR: join(cacheRoot, 'plugins'),
          DISABLE_AUTOUPDATER: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        };
        execFileSync(cli, ['plugin', 'install', 'demo', '--marketplace', market, '--json'], {
          env,
          encoding: 'utf8',
        });
        // 市场来源已删除，任何联网刷新都不可能成功；能 list/read 就证明走的是缓存。
        await rm(market, { recursive: true, force: true });

        const offlineCli = join(root, 'offline-cli.sh');
        await writeFile(
          offlineCli,
          `#!/bin/sh\nexec sandbox-exec -p '(version 1)(allow default)(deny network*)' "${cli}" "$@"\n`,
        );
        await chmod(offlineCli, 0o755);
        const options = { cliPath: offlineCli, cacheRoot };

        expect(await listNativePlugins(options)).toEqual({
          ok: true,
          installed: [{ pluginId: 'demo@fixture-market', version: '1.2.3' }],
        });
        const read = await readPlugin('demo@fixture-market', options);
        expect(read).toMatchObject({ ok: true, plugin: { pluginId: 'demo@fixture-market' } });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
