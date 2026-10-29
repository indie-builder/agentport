import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { renderPlugin, WORKSPACE_DIR_MODE, WORKSPACE_FILE_MODE } from '@agentport/core';
import type { Plugin } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { infraReady, inject, injectZip, loginCookie, startApp, unique } from './helpers.js';

const ready = await infraReady;
const ENCODER = new TextEncoder();
const RUNNER = '#!/bin/sh\nprintf ran\n';
const HELPER = '#!/bin/sh\nexit 0\n';

/** 用 fflate 官方的文件级 os/attrs 写真实 Unix mode。 */
function zipWithModes(
  files: Array<{ path: string; content: string; executable: boolean }>,
): Buffer {
  const entries: Record<string, [Uint8Array, { os: number; attrs: number }]> = {};
  for (const file of files) {
    entries[file.path] = [
      ENCODER.encode(file.content),
      { os: 3, attrs: ((file.executable ? 0o100755 : 0o100644) << 16) >>> 0 },
    ];
  }
  return Buffer.from(zipSync(entries));
}

/** 不带 Unix 元数据的普通 ZIP（fflate 默认 os/attrs 为 0）。 */
function plainZip(files: Record<string, string>): Buffer {
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, content]) => [path, ENCODER.encode(content)]),
      ),
    ),
  );
}

describe.skipIf(!ready)('plugin ZIP executable permissions', () => {
  let app: FastifyInstance;
  let cookie: string;
  const slugs: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    if (slugs.length > 0) {
      await app.pool.query('delete from plugins where slug = any($1::text[])', [slugs]);
    }
    await app.close();
  });

  async function importPlugin(slug: string, archive: Buffer): Promise<Plugin> {
    slugs.push(slug);
    const res = await injectZip(app, 'POST', `/api/plugins/import?slug=${slug}`, cookie, archive);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ plugin: Plugin }>().plugin;
  }

  const filesOf = (plugin: Plugin): Map<string, Plugin['files'][number]> =>
    new Map(plugin.files.map((file) => [file.path, file]));

  const manifest = (slug: string) => JSON.stringify({ name: slug });

  it('uses the ZIP executable bit instead of the file extension on import', async () => {
    const slug = unique('zip-exec');
    const plugin = await importPlugin(
      slug,
      zipWithModes([
        { path: '.claude-plugin/plugin.json', content: manifest(slug), executable: false },
        { path: 'scripts/run', content: RUNNER, executable: true },
        { path: 'scripts/helper.sh', content: HELPER, executable: false },
      ]),
    );

    const files = filesOf(plugin);
    expect(files.get('scripts/run')?.executable).toBe(true);
    expect(files.get('scripts/helper.sh')?.executable).toBe(false);
  });

  it('treats entries without Unix attributes as non-executable', async () => {
    const slug = unique('zip-plain');
    const plugin = await importPlugin(
      slug,
      plainZip({
        '.claude-plugin/plugin.json': manifest(slug),
        'scripts/run': RUNNER,
        'scripts/helper.sh': HELPER,
      }),
    );

    const files = filesOf(plugin);
    expect(files.get('scripts/run')?.executable).toBe(false);
    expect(files.get('scripts/helper.sh')?.executable).toBe(false);
  });

  it('preserves the executable bit through export and re-import', async () => {
    const slug = unique('zip-round');
    const plugin = await importPlugin(
      slug,
      zipWithModes([
        { path: '.claude-plugin/plugin.json', content: manifest(slug), executable: false },
        { path: 'scripts/run', content: RUNNER, executable: true },
        { path: 'scripts/helper.sh', content: HELPER, executable: false },
      ]),
    );

    const exported = await injectZip(app, 'GET', `/api/plugins/${plugin.id}/export`, cookie);
    expect(exported.statusCode, exported.body).toBe(200);

    // 导出包沿用原 manifest 名称；删掉原行后同 slug 再导入，才能验证真实往返。
    const deleted = await inject(app, {
      method: 'DELETE',
      url: `/api/plugins/${plugin.id}`,
      headers: { cookie },
    });
    expect(deleted.statusCode, deleted.body).toBe(204);

    const reimported = await importPlugin(slug, exported.rawPayload);
    const files = filesOf(reimported);
    expect(files.get('scripts/run')?.executable).toBe(true);
    expect(files.get('scripts/helper.sh')?.executable).toBe(false);
  });

  it('writes the rendered executable file with worker permissions and runs it', async () => {
    const slug = unique('zip-disk');
    const plugin = await importPlugin(
      slug,
      zipWithModes([
        { path: '.claude-plugin/plugin.json', content: manifest(slug), executable: false },
        { path: 'scripts/run', content: RUNNER, executable: true },
        { path: 'scripts/helper.sh', content: HELPER, executable: false },
      ]),
    );

    const rendered = renderPlugin({
      slug: plugin.slug,
      runtimeName: plugin.runtimeName,
      allowHooks: true,
      allowMcp: true,
      files: plugin.files,
    });
    const renderedFiles = new Map(rendered.files.map((file) => [file.path, file]));
    expect(renderedFiles.get('scripts/run')?.executable).toBe(true);
    expect(renderedFiles.get('scripts/helper.sh')?.executable).toBe(false);

    const root = await mkdtemp(join(tmpdir(), 'agentport-plugin-perm-'));
    try {
      for (const file of rendered.files) {
        const target = join(root, file.path);
        await mkdir(dirname(target), { recursive: true, mode: WORKSPACE_DIR_MODE });
        // 与 worker writeWorkspace 的插件写入规则一致（该函数未导出）。
        await writeFile(target, file.content, {
          mode: file.executable ? WORKSPACE_DIR_MODE : WORKSPACE_FILE_MODE,
        });
      }
      const runner = join(root, 'scripts/run');
      expect((await stat(runner)).mode & 0o111).not.toBe(0);
      expect((await stat(join(root, 'scripts/helper.sh'))).mode & 0o111).toBe(0);

      const { stdout } = await promisify(execFile)(runner);
      expect(stdout).toBe('ran');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
