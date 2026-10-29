import { AppError } from '@agentport/core';
import type { Agent } from '@agentport/shared';
import { AGENT_PACKAGE_MAX_BYTES, AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packAgentPackage } from '../src/features/agent-package.js';
import { decodePackage, encodePackage } from '../src/features/agent-package-zip.js';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  injectZip,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';
import { sidecarOf, unzipPackage } from './package-fixtures.js';

const ready = await infraReady;

const pack = (files: Record<string, string>) =>
  packAgentPackage({ files, slug: 'limit', warnings: [] });

const conflictOf = (run: () => unknown): AppError => {
  try {
    run();
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return error;
  }
  throw new Error('expected the package to be rejected');
};

describe('agent package packing limits', () => {
  it('packs exactly at the uncompressed limit and rejects one byte more', () => {
    const exact = { 'CLAUDE.md': 'a'.repeat(AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES) };
    const packed = pack(exact);
    expect(packed.byteLength).toBeLessThanOrEqual(AGENT_PACKAGE_MAX_BYTES);
    expect(decodePackage(packed).get('CLAUDE.md')).toHaveLength(
      AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES,
    );

    const error = conflictOf(() =>
      pack({ 'CLAUDE.md': 'a'.repeat(AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES + 1) }),
    );
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('4 MiB');
  });

  it('counts UTF-8 bytes, not characters, across every file', () => {
    // 1_398_000 个「中」= 4_194_000 字节，加上 304 个 ASCII 字节正好到 4 MiB。
    const chinese = '中'.repeat(1_398_000);
    const packed = pack({ 'CLAUDE.md': chinese, '.claude/rules/guide.md': 'a'.repeat(304) });
    expect(packed.byteLength).toBeLessThanOrEqual(AGENT_PACKAGE_MAX_BYTES);
    expect(decodePackage(packed).get('CLAUDE.md')).toBe(chinese);

    const over = { 'CLAUDE.md': chinese, '.claude/rules/guide.md': 'a'.repeat(305) };
    // 字符数远低于上限，压缩后也只有几 KB：拒绝只能来自解压后字节上限。
    expect(encodePackage(over).byteLength).toBeLessThan(AGENT_PACKAGE_MAX_BYTES);
    expect(conflictOf(() => pack(over)).code).toBe('CONFLICT');
  });

  it('rejects a package whose ZIP entry overhead would exceed the import limit', () => {
    // 两个文件的 UTF-8 总字节正好等于上限；极小条目的 deflate 开销会让导入端
    // 按中央目录的 max(原始, 压缩) 累加时越限，导出不能产出这种导不回的包。
    const files = {
      'CLAUDE.md': 'a'.repeat(AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES - 1),
      '.claude/rules/guide.md': 'x',
    };
    const error = conflictOf(() => pack(files));
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('解压后总大小');

    const under = {
      'CLAUDE.md': 'a'.repeat(AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES - 4),
      '.claude/rules/guide.md': 'x',
    };
    expect(decodePackage(pack(under)).get('CLAUDE.md')).toHaveLength(
      AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES - 4,
    );
  });
});

describe.skipIf(!ready)('agent package export limits', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents });
    await app.close();
  });

  const writeRule = async (agentId: string, slug: string, content: string) => {
    const res = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agentId}/rules/${slug}`,
      headers: { cookie },
      payload: { content, globs: '' },
    });
    expect(res.statusCode, res.body).toBe(200);
  };

  const writeStyle = async (agentId: string, slug: string, body: string) => {
    const res = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agentId}/output-styles/${slug}`,
      headers: { cookie },
      payload: { description: body, keepCodingInstructions: false, body },
    });
    expect(res.statusCode, res.body).toBe(200);
  };

  const readRules = async (agentId: string) => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agentId}/rules`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Array<{ slug: string; content: string }>>();
  };

  const readStyles = async (agentId: string) => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agentId}/output-styles`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Array<{ slug: string; body: string }>>();
  };

  const exportAgent = (id: string) => injectZip(app, 'GET', `/api/export/agents/${id}`, cookie);
  const importZip = (zip: Buffer) => injectZip(app, 'POST', '/api/import/agents', cookie, zip);

  it('keeps rule and output-style slug namespaces separate for root and child definitions', async () => {
    const slug = unique('pkg-ns-root');
    const childSlug = unique('pkg-ns-child');
    createdAgents.push(slug, childSlug);
    const root = (await createAgent(app, cookie, { slug, track: createdAgents })).json<Agent>();
    const child = (
      await createAgent(app, cookie, { slug: childSlug, track: createdAgents })
    ).json<Agent>();
    const attached = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${root.id}`,
      headers: { cookie },
      payload: { subAgentIds: [child.id] },
    });
    expect(attached.statusCode, attached.body).toBe(200);

    // 规则与输出风格分属不同目录：同名是合法的，导入端也按各自目录分别校验。
    await writeRule(root.id, 'guide', 'Root rule.');
    await writeStyle(root.id, 'guide', 'Root style.');
    await writeRule(child.id, 'guide', 'Child rule.');
    await writeStyle(child.id, 'guide', 'Child style.');

    const exported = await exportAgent(root.id);
    expect(exported.statusCode, exported.body).toBe(200);
    const files = unzipPackage(exported.rawPayload);
    expect(files.get('.claude/rules/guide.md')).toContain('Root rule.');
    expect(files.get('.claude/output-styles/guide.md')).toContain('Root style.');
    const childMeta = sidecarOf(files).subAgents.find((entry) => entry.slug === childSlug);
    expect(childMeta?.rules.map((entry) => entry.slug)).toEqual(['guide']);
    expect(childMeta?.outputStyles.map((entry) => entry.slug)).toEqual(['guide']);

    const imported = await importZip(exported.rawPayload);
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<{ agent: Agent; createdSubAgents: string[] }>();
    createdAgents.push(result.agent.slug, ...result.createdSubAgents);

    expect(await readRules(result.agent.id)).toMatchObject([
      { slug: 'guide', content: 'Root rule.' },
    ]);
    expect(await readStyles(result.agent.id)).toMatchObject([
      { slug: 'guide', body: 'Root style.' },
    ]);

    const importedChild = await app.pool.query<{ id: string }>(
      'select id from agents where slug = $1',
      [result.createdSubAgents[0]],
    );
    const childId = importedChild.rows[0]?.id ?? '';
    expect(await readRules(childId)).toMatchObject([{ slug: 'guide', content: 'Child rule.' }]);
    expect(await readStyles(childId)).toMatchObject([{ slug: 'guide', body: 'Child style.' }]);
  });

  it('rejects an export whose decompressed rules exceed the import limit', async () => {
    const slug = unique('pkg-undercap');
    createdAgents.push(slug);
    const agent = (await createAgent(app, cookie, { slug, track: createdAgents })).json<Agent>();
    // 50 × 100_000 个 ASCII 字符高度可压缩：ZIP 只有十几 KB，但解压后超过 4 MiB。
    const content = 'a'.repeat(100_000);
    for (let index = 0; index < 50; index += 1) {
      await writeRule(agent.id, `rule-${index}`, content);
    }

    const exported = await exportAgent(agent.id);
    expect(exported.statusCode, `zip ${exported.rawPayload.byteLength} bytes`).toBe(409);
    const problem = expectProblem(exported, 'CONFLICT');
    expect(problem.message).toContain('解压');
    expect(problem.message).toContain('4 MiB');
  });

  it('round-trips a package whose decompressed size stays under the limit', async () => {
    const slug = unique('pkg-under');
    createdAgents.push(slug);
    const agent = (await createAgent(app, cookie, { slug, track: createdAgents })).json<Agent>();
    const content = '中'.repeat(20_000);
    for (let index = 0; index < 50; index += 1) {
      await writeRule(agent.id, `rule-${index}`, content);
    }

    const exported = await exportAgent(agent.id);
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.rawPayload.byteLength).toBeLessThanOrEqual(AGENT_PACKAGE_MAX_BYTES);

    const imported = await importZip(exported.rawPayload);
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<{ agent: Agent }>();
    createdAgents.push(result.agent.slug);

    const rules = await app.pool.query<{ count: string; longest: number }>(
      'select count(*)::text as count, max(length(content)) as longest from agent_rules where agent_id = $1',
      [result.agent.id],
    );
    expect(rules.rows).toEqual([{ count: '50', longest: 20_000 }]);
  });
});
