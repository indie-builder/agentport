import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installPlugin,
  listNativePlugins,
  readPlugin,
  resolveNativeCli,
} from '../src/native-plugins.js';

// 真实 CLI 的启动开销小，30s 足够覆盖冷启动与本地 marketplace 安装。
const TIMEOUT = 30_000;

const require = createRequire(import.meta.url);

// SDK 自己的可选依赖里可能没有当前平台的 CLI；缺包时显式跳过，不把安装问题报成插件失败。
function hasNativeCli(): boolean {
  try {
    const fromSdk = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'));
    const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const names = process.platform === 'linux' ? [base, `${base}-musl`] : [base];
    const exe = process.platform === 'win32' ? '.exe' : '';
    return names.some((name) => {
      try {
        fromSdk.resolve(`${name}/claude${exe}`);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

const nativeCli = hasNativeCli();

/** 本地官方 marketplace fixture；生产输入不允许本地路径，这里只做真实 CLI 验证。 */
async function marketFixture(root: string): Promise<string> {
  const market = join(root, 'market');
  const plugin = join(market, 'plugins', 'demo');
  await mkdir(join(market, '.claude-plugin'), { recursive: true });
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
  await mkdir(join(plugin, 'skills', 'hello'), { recursive: true });
  await mkdir(join(plugin, 'hooks'), { recursive: true });
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
    JSON.stringify({ name: 'demo', version: '1.2.3', description: 'fixture' }),
  );
  await writeFile(
    join(plugin, 'skills', 'hello', 'SKILL.md'),
    '---\nname: hello\ndescription: Fixture skill.\n---\n\nNo-op.\n',
  );
  const hook = join(plugin, 'hooks', 'run.sh');
  await writeFile(hook, '#!/bin/sh\necho hi\n');
  await chmod(hook, 0o755);
  return market;
}

describe('real CLI native plugin install', () => {
  it(
    'installs a local marketplace plugin once and reads it from cache without the source',
    async (ctx) => {
      if (!nativeCli) ctx.skip(`no native CLI installed for ${process.platform}-${process.arch}`);
      const root = await mkdtemp(join(tmpdir(), 'native-plugin-cli-'));
      try {
        const market = await marketFixture(root);
        const options = { cliPath: resolveNativeCli(), cacheRoot: join(root, 'cache-root') };

        const installed = await installPlugin({ marketplace: market, plugin: 'demo' }, options);
        expect(installed).toMatchObject({
          ok: true,
          plugin: { pluginId: 'demo@fixture-market', version: '1.2.3' },
        });
        if (!installed.ok || !('files' in installed)) throw new Error('expected snapshot');
        expect(installed.files.find((file) => file.path === 'hooks/run.sh')?.executable).toBe(true);

        // 第二次不再安装：删掉市场来源后 list/read 仍须从缓存返回。
        await rm(market, { recursive: true, force: true });
        expect(await listNativePlugins(options)).toEqual({
          ok: true,
          installed: [{ pluginId: 'demo@fixture-market', version: '1.2.3' }],
        });
        expect(await readPlugin('demo@fixture-market', options)).toMatchObject({
          ok: true,
          plugin: { pluginId: 'demo@fixture-market' },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
