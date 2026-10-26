import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/client.js';
import { newId } from '../src/id.js';
import { updateAgent } from '../src/repo/agents.js';
import * as pluginsRepo from '../src/repo/plugins.js';
import { agents, plugins } from '../src/schema.js';

const url = process.env.DATABASE_URL ?? 'postgres://agentport:agentport@localhost:5432/agentport';
const { db, pool } = createDb(url);
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

describe.skipIf(!ready)('plugin repo', () => {
  const agentId = newId('agent');
  const slug = `test-plugin-${agentId}`;
  let pluginId = '';

  afterAll(async () => {
    // 删插件级联清掉文件与绑定；删 agent 兜底。
    if (pluginId) await db.delete(plugins).where(eq(plugins.id, pluginId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await pool.end();
  });

  it('creates with files and exposes them by plugin id', async () => {
    await db.insert(agents).values({ id: agentId, slug: `p-${agentId}`, name: 'p', model: 'test' });

    const created = await pluginsRepo.createPluginWithFiles(
      db,
      { slug, runtimeName: slug, name: 'Test plugin' },
      [
        { path: '.claude-plugin/plugin.json', content: '{}' },
        { path: 'scripts/run.sh', content: 'echo hi', executable: true },
      ],
    );
    pluginId = created.id;

    const files = await pluginsRepo.listPluginFiles(db, pluginId);
    expect(files.map((file) => file.path)).toEqual([
      '.claude-plugin/plugin.json',
      'scripts/run.sh',
    ]);
    expect(files.find((file) => file.path === 'scripts/run.sh')?.executable).toBe(true);

    expect((await pluginsRepo.getPlugin(db, pluginId))?.slug).toBe(slug);
    expect((await pluginsRepo.listPlugins(db)).find((row) => row.id === pluginId)?.agentCount).toBe(
      0,
    );

    const map = await pluginsRepo.getPluginFilesByPluginIds(db, [pluginId]);
    expect(map.get(pluginId)).toHaveLength(2);
  });

  it('binds through the real write path and counts bindings', async () => {
    // 绑定只走 updateAgent 这类公开写入口，不另设一份可绕过锁顺序的写入口。
    await updateAgent(db, agentId, {}, undefined, undefined, null, undefined, undefined, [
      { pluginId, allowHooks: true, allowMcp: false },
    ]);
    expect(await pluginsRepo.listAgentPluginBindings(db, agentId)).toEqual([
      { plugin: expect.objectContaining({ id: pluginId }), allowHooks: true, allowMcp: false },
    ]);
    expect((await pluginsRepo.listPlugins(db)).find((row) => row.id === pluginId)?.agentCount).toBe(
      1,
    );

    await updateAgent(db, agentId, {}, undefined, undefined, null, undefined, undefined, []);
    expect(await pluginsRepo.listAgentPluginBindings(db, agentId)).toEqual([]);
  });

  it('returns null / false for missing rows', async () => {
    const missing = newId('plugin');
    expect(await pluginsRepo.getPlugin(db, missing)).toBeNull();
    expect(await pluginsRepo.deletePlugin(db, missing)).toBe(false);
  });

  it('dedupes native sources by name@marketplace and leaves ZIP rows null', async () => {
    const sourceId = `${slug}@test-market`;
    await db.update(plugins).set({ sourceId }).where(eq(plugins.id, pluginId));

    expect((await pluginsRepo.getPluginBySourceId(db, sourceId))?.id).toBe(pluginId);
    expect(await pluginsRepo.getPluginBySourceId(db, `${slug}@other`)).toBeNull();
    expect((await pluginsRepo.listPlugins(db)).find((row) => row.id === pluginId)?.sourceId).toBe(
      sourceId,
    );

    // ZIP 插件 sourceId 为 null，多个 null 不冲突。
    const zip = await pluginsRepo.createPluginWithFiles(
      db,
      { slug: `${slug}-zip`, runtimeName: `${slug}-zip`, name: 'ZIP plugin' },
      [],
    );
    try {
      expect(zip.sourceId).toBeNull();
      await expect(
        pluginsRepo.createPluginWithFiles(
          db,
          {
            slug: `${slug}-dup`,
            runtimeName: `${slug}-dup`,
            name: 'Duplicate source',
            sourceId,
          },
          [],
        ),
      ).rejects.toMatchObject({ cause: { code: '23505' } });
    } finally {
      await db.delete(plugins).where(eq(plugins.id, zip.id));
    }
  });
});
