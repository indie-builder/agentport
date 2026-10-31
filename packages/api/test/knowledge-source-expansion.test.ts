import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptSecrets } from '@agentport/core';
import type { FastifyInstance } from 'fastify';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { infraReady, inject, injectZip, loginCookie, startApp, unique } from './helpers.js';

const ready = await infraReady;
const UUID = '01234567-89ab-cdef-0123-456789abcdef';

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const SOURCE_TYPES = [
  'lark_wiki',
  'lark_drive',
  'notion',
  'confluence',
  'yuque',
  'dingtalk',
  'ima',
  'seafile',
  'nextcloud',
] as const;

type SourceType = (typeof SOURCE_TYPES)[number];

const sourcePayloads: Record<SourceType, Record<string, unknown>> = {
  lark_wiki: {
    config: { appId: 'cli_a' },
    secrets: { appSecret: 'FIXTURE_LARK_1' },
    ranges: [{ kind: 'wiki_space', externalId: 'spc_1' }],
  },
  lark_drive: {
    config: { appId: 'cli_a' },
    secrets: { appSecret: 'FIXTURE_LARK_1' },
    ranges: [{ kind: 'drive_folder', externalId: 'fld_1' }],
  },
  notion: {
    config: {},
    secrets: { apiKey: 'FIXTURE_NOTION_1' },
    ranges: [{ kind: 'notion_page', externalId: UUID }],
  },
  confluence: {
    config: {
      authMode: 'cloud_basic',
      baseUrl: 'https://acme.atlassian.net/wiki',
      email: 'owner@example.com',
    },
    secrets: { apiToken: 'FIXTURE_CONFLUENCE_1' },
    ranges: [{ kind: 'confluence_space', externalId: '123' }],
  },
  yuque: {
    config: {},
    secrets: { apiToken: 'FIXTURE_YUQUE_1' },
    ranges: [{ kind: 'yuque_repo', externalId: '42' }],
  },
  dingtalk: {
    config: { clientId: 'client-id', operatorUnionId: 'union-id' },
    secrets: { clientSecret: 'dingtalk-client-secret' },
    ranges: [{ kind: 'dingtalk_workspace', externalId: 'workspace-1' }],
  },
  ima: {
    config: { clientId: 'ima-client' },
    secrets: { apiKey: 'ima-api-key' },
    ranges: [{ kind: 'ima_kb', externalId: 'kb-1' }],
  },
  seafile: {
    config: { baseUrl: 'https://seafile.example.com' },
    secrets: { apiToken: 'FIXTURE_SEAFILE_1' },
    ranges: [{ kind: 'seafile_repo', externalId: UUID, paths: ['Documents', 'Manuals'] }],
  },
  nextcloud: {
    config: { baseUrl: 'https://cloud.example.com', username: 'alice' },
    secrets: { appPassword: 'FIXTURE_NEXTCLOUD_1' },
    ranges: [{ kind: 'nextcloud_path', externalId: '/Documents' }],
  },
};

describe.skipIf(!ready)('knowledge source expansion', () => {
  let app: FastifyInstance;
  let cookie = '';
  let knowledgeDir = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  async function createBase(): Promise<string> {
    const profile = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('exp-emb'),
        endpointUrl: 'http://127.0.0.1:1',
        model: 'test',
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    profileIds.push(profile.json<{ id: string }>().id);

    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: {
        slug: unique('exp-kb'),
        name: '九类来源库',
        embeddingProfileId: profileIds.at(-1),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const baseId = res.json<{ id: string }>().id;
    baseIds.push(baseId);
    return baseId;
  }

  function payload(type: SourceType, overrides: Record<string, unknown> = {}) {
    return { type, name: unique(type), ...sourcePayloads[type], ...overrides };
  }

  async function createSource(baseId: string, type: SourceType, overrides = {}) {
    const res = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/sources`,
      headers: { cookie },
      payload: payload(type, overrides),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>();
  }

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-source-expansion-'));
    app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    if (baseIds.length > 0) {
      await app.pool.query('delete from knowledge_bases where id = any($1::text[])', [baseIds]);
    }
    if (profileIds.length > 0) {
      await app.pool.query('delete from knowledge_model_profiles where id = any($1::text[])', [
        profileIds,
      ]);
    }
    await app.close();
    await rm(knowledgeDir, { recursive: true, force: true });
  });

  it('creates all nine source types, persists ranges, and never returns secrets', async () => {
    const baseId = await createBase();
    for (const type of SOURCE_TYPES) {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${baseId}/sources`,
        headers: { cookie },
        payload: payload(type),
      });
      expect(res.statusCode, `${type}: ${res.body}`).toBe(201);
      const source = res.json<{
        id: string;
        type: string;
        hasSecret: boolean;
        config: Record<string, unknown>;
        ranges: Array<{ kind: string; externalId: string; paths: string[] }>;
      }>();
      expect(source.type).toBe(type);
      expect(source.hasSecret).toBe(true);
      expect(source.config.syncDeletions).toBe(false);
      const firstRange = (
        sourcePayloads[type].ranges as Array<{ kind: string; externalId: string }>
      )[0];
      expect(source.ranges[0]).toMatchObject({
        kind: firstRange?.kind,
        externalId: firstRange?.externalId,
      });
      const secret = Object.values(sourcePayloads[type].secrets as Record<string, string>)[0] ?? '';
      expect(secret).not.toBe('');
      expect(res.body).not.toContain(secret);
      expect(source.config).not.toHaveProperty('apiKey');
      expect(source.config).not.toHaveProperty('apiToken');
      expect(source.config).not.toHaveProperty('appPassword');
    }
  });

  it('keeps identity fields immutable on PATCH while allowing credential rotation', async () => {
    const baseId = await createBase();
    const cases: Array<[SourceType, Record<string, unknown>]> = [
      ['lark_wiki', { config: { appId: 'cli_other' } }],
      ['lark_drive', { config: { appId: 'cli_other' } }],
      [
        'confluence',
        {
          config: {
            authMode: 'cloud_scoped',
            baseUrl: 'https://acme.atlassian.net/wiki',
            email: 'owner@example.com',
            cloudId: 'cloud-2',
          },
        },
      ],
      ['dingtalk', { config: { clientId: 'client-other', operatorUnionId: 'union-id' } }],
      ['ima', { config: { clientId: 'ima-other' } }],
      ['seafile', { config: { baseUrl: 'https://other-seafile.example.com' } }],
      ['nextcloud', { config: { baseUrl: 'https://cloud.example.com', username: 'bob' } }],
    ];
    for (const [type, patch] of cases) {
      const source = await createSource(baseId, type);
      const res = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/sources/${source.id}`,
        headers: { cookie },
        payload: patch,
      });
      expect(res.statusCode, `${type}: ${res.body}`).toBe(400);
      expect(res.json()).toMatchObject({ code: 'INVALID_INPUT' });
      expect(res.json<{ message: string }>().message).toContain('创建后不可修改');
    }

    // Notion/语雀使用固定 origin，没有可改身份字段：普通 config PATCH 仍成功。
    for (const type of ['notion', 'yuque'] as const) {
      const source = await createSource(baseId, type);
      const res = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/sources/${source.id}`,
        headers: { cookie },
        payload: { config: { syncDeletions: true } },
      });
      expect(res.statusCode, `${type}: ${res.body}`).toBe(200);
      expect(res.json()).toMatchObject({ config: { syncDeletions: true } });
    }

    // 凭证轮换不改变身份，允许覆盖且仍只以 hasSecret 暴露。
    const lark = await createSource(baseId, 'lark_wiki');
    const rotated = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/sources/${lark.id}`,
      headers: { cookie },
      payload: { secrets: { appSecret: 'rotated-lark-secret' } },
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.json()).toMatchObject({ hasSecret: true });
    expect(rotated.body).not.toContain('rotated-lark-secret');
    const stored = await app.pool.query<{ secrets_encrypted: string; config: unknown }>(
      'select secrets_encrypted, config from knowledge_sources where id = $1',
      [lark.id],
    );
    expect(stored.rows[0]?.secrets_encrypted ?? '').not.toContain('rotated-lark-secret');
    // 显式 secrets 是整体替换，不与旧凭证合并；缺省 secrets 才保留原值。
    expect(
      decryptSecrets(stored.rows[0]?.secrets_encrypted ?? '', app.config.APP_SECRET_KEY),
    ).toEqual({ appSecret: 'rotated-lark-secret' });
    const clear = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/sources/${lark.id}`,
      headers: { cookie },
      payload: { secrets: {} },
    });
    expect(clear.statusCode, clear.body).toBe(400);
    expect(clear.json()).toMatchObject({ code: 'INVALID_INPUT', path: 'secrets.appSecret' });
    const retained = await app.pool.query<{ secrets_encrypted: string }>(
      'select secrets_encrypted from knowledge_sources where id = $1',
      [lark.id],
    );
    expect(
      decryptSecrets(retained.rows[0]?.secrets_encrypted ?? '', app.config.APP_SECRET_KEY),
    ).toEqual({ appSecret: 'rotated-lark-secret' });
  });

  it('rejects wrong range kinds, unsafe paths, and mode/secret mismatches', async () => {
    const baseId = await createBase();
    const cases: Array<[SourceType, Record<string, unknown>, string]> = [
      ['notion', { ranges: [{ kind: 'confluence_space', externalId: '1' }] }, '类型必须属于'],
      ['notion', { ranges: [{ kind: 'notion_page', externalId: 'not-a-uuid' }] }, 'UUID'],
      ['yuque', { ranges: [{ kind: 'yuque_repo', externalId: '42x' }] }, '正整数'],
      [
        'seafile',
        {
          ranges: [{ kind: 'seafile_repo', externalId: UUID, paths: ['../etc'] }],
        },
        '库内相对路径',
      ],
      ['nextcloud', { ranges: [{ kind: 'nextcloud_path', externalId: 'Documents' }] }, '绝对路径'],
      [
        'dingtalk',
        { ranges: [{ kind: 'dingtalk_workspace', externalId: 'ws', enabled: false }] },
        '至少需要一个启用的范围',
      ],
      [
        'confluence',
        {
          config: {
            authMode: 'dc_pat',
            baseUrl: 'https://acme.atlassian.net/wiki',
          },
          secrets: { apiToken: 't' },
        },
        '缺少凭证 pat',
      ],
    ];
    for (const [type, overrides, message] of cases) {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${baseId}/sources`,
        headers: { cookie },
        payload: payload(type, overrides),
      });
      expect(res.statusCode, `${type} ${res.body}`).toBe(400);
      expect(res.json()).toMatchObject({ code: 'INVALID_INPUT' });
      expect(res.json<{ message: string }>().message).toContain(message);
    }
    const count = await app.pool.query<{ n: string }>(
      'select count(*)::text as n from knowledge_sources where base_id = $1',
      [baseId],
    );
    expect(count.rows[0]?.n).toBe('0');
  });

  it('caps provider range IDs so the composed sourceId stays under the ZIP limit', async () => {
    const baseId = await createBase();
    const caps: Record<SourceType, number> = {
      lark_wiki: 128,
      lark_drive: 128,
      notion: 36,
      confluence: 32,
      yuque: 16,
      dingtalk: 128,
      ima: 128,
      seafile: 36,
      nextcloud: 255,
    };
    const overCap: Record<SourceType, string> = {
      lark_wiki: 'x'.repeat(caps.lark_wiki + 1),
      lark_drive: 'x'.repeat(caps.lark_drive + 1),
      notion: `${UUID}a`,
      confluence: '1'.repeat(caps.confluence + 1),
      yuque: '1'.repeat(caps.yuque + 1),
      dingtalk: 'x'.repeat(caps.dingtalk + 1),
      ima: 'x'.repeat(caps.ima + 1),
      seafile: `${UUID}a`,
      nextcloud: `/${'a'.repeat(caps.nextcloud)}`,
    };
    for (const type of SOURCE_TYPES) {
      const kind = (sourcePayloads[type].ranges as Array<{ kind: string }>)[0]?.kind ?? '';
      const res = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${baseId}/sources`,
        headers: { cookie },
        payload: payload(type, {
          ranges: [{ kind, externalId: overCap[type] }],
        }),
      });
      expect(res.statusCode, `${type}: ${res.body}`).toBe(400);
      expect(res.json()).toMatchObject({ code: 'INVALID_INPUT' });
      expect(res.json<{ message: string }>().message).toContain(`超过 ${caps[type]} 字符`);
    }

    // 证据里的 480 字符 IMA KB ID 曾经能创建，直到导出才因 sourceId > 500 报 409。
    const reproduced = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/sources`,
      headers: { cookie },
      payload: payload('ima', { ranges: [{ kind: 'ima_kb', externalId: 'k'.repeat(480) }] }),
    });
    expect(reproduced.statusCode, reproduced.body).toBe(400);

    const count = await app.pool.query<{ n: string }>(
      'select count(*)::text as n from knowledge_sources where base_id = $1',
      [baseId],
    );
    expect(count.rows[0]?.n).toBe('0');

    // 上限本身仍可创建：只挡住超出 provider 实际 ID 空间的值。
    const atCap = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/sources`,
      headers: { cookie },
      payload: payload('ima', { ranges: [{ kind: 'ima_kb', externalId: 'k'.repeat(caps.ima) }] }),
    });
    expect(atCap.statusCode, atCap.body).toBe(201);
  });

  it('shares the same source validation on PATCH ranges and probe', async () => {
    const baseId = await createBase();
    const source = await createSource(baseId, 'notion');
    const badPatch = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/sources/${source.id}`,
      headers: { cookie },
      payload: { ranges: [{ kind: 'confluence_space', externalId: '1' }] },
    });
    expect(badPatch.statusCode, badPatch.body).toBe(400);
    expect(badPatch.json<{ message: string }>().message).toContain('类型必须属于');

    // 历史/绕过创建入口的破损配置：test 路由与创建共用同一校验，不入队探针。
    const brokenId = unique('ksrc_broken');
    await app.pool.query(
      `insert into knowledge_sources (id, base_id, type, name, config)
       values ($1, $2, 'lark_wiki', 'broken', '{}'::jsonb)`,
      [brokenId, baseId],
    );
    await app.pool.query(
      `insert into knowledge_source_ranges (id, source_id, kind, external_id)
       values ($1, $2, 'wiki_space', 'spc_broken')`,
      [unique('krng_broken'), brokenId],
    );
    const probe = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/sources/${brokenId}/test`,
      headers: { cookie },
    });
    expect(probe.statusCode, probe.body).toBe(400);
    expect(probe.json<{ message: string }>().message).toContain('缺少 config.appId');
  });

  it('accepts the three Confluence auth modes and both credential shapes', async () => {
    const baseId = await createBase();
    const modes = [
      {
        config: {
          authMode: 'cloud_basic',
          baseUrl: 'https://acme.atlassian.net/wiki',
          email: 'owner@example.com',
        },
        secrets: { apiToken: 't' },
      },
      {
        config: {
          authMode: 'cloud_scoped',
          baseUrl: 'https://acme.atlassian.net/wiki',
          email: 'owner@example.com',
          cloudId: 'cloud-1',
        },
        secrets: { apiToken: 't' },
      },
      {
        config: { authMode: 'dc_pat', baseUrl: 'https://confluence.example.com' },
        secrets: { pat: 'p' },
      },
    ];
    for (const mode of modes) {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${baseId}/sources`,
        headers: { cookie },
        payload: payload('confluence', {
          name: unique('confluence-mode'),
          ranges: [{ kind: 'confluence_page', externalId: '456' }],
          ...mode,
        }),
      });
      expect(res.statusCode, res.body).toBe(201);
    }
  });

  it('DB CHECK accepts all new enum values and rejects unknown ones', async () => {
    const baseId = await createBase();
    for (const type of SOURCE_TYPES) {
      await expect(
        app.pool.query(
          'insert into knowledge_sources (id, base_id, type, name) values ($1, $2, $3, $4)',
          [unique('ksrc_db'), baseId, type, type],
        ),
      ).resolves.toBeDefined();
    }
    const unknownType = app.pool.query(
      'insert into knowledge_sources (id, base_id, type, name) values ($1, $2, $3, $4)',
      [unique('ksrc_db'), baseId, 'unknown_source', 'unknown'],
    );
    await expect(unknownType).rejects.toMatchObject({ code: '23514' });

    const [source] = (
      await app.pool.query<{ id: string }>(
        'select id from knowledge_sources where base_id = $1 limit 1',
        [baseId],
      )
    ).rows;
    const sourceId = source?.id ?? '';
    expect(sourceId).not.toBe('');
    const kinds = [
      'notion_page',
      'notion_database',
      'notion_data_source',
      'confluence_space',
      'confluence_page',
      'yuque_repo',
      'dingtalk_workspace',
      'dingtalk_node',
      'ima_kb',
      'seafile_repo',
      'nextcloud_path',
    ];
    for (const kind of kinds) {
      await expect(
        app.pool.query(
          'insert into knowledge_source_ranges (id, source_id, kind, external_id) values ($1, $2, $3, $4)',
          [unique('krng_db'), sourceId, kind, unique('ext')],
        ),
      ).resolves.toBeDefined();
    }
    await expect(
      app.pool.query(
        'insert into knowledge_source_ranges (id, source_id, kind, external_id) values ($1, $2, $3, $4)',
        [unique('krng_db'), sourceId, 'unknown_kind', 'ext'],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    for (const type of SOURCE_TYPES) {
      await expect(
        app.pool.query(
          `insert into knowledge_documents (id, base_id, title, source_type, mime_type)
           values ($1, $2, $3, $4, 'text/markdown')`,
          [unique('kdoc_db'), baseId, type, type],
        ),
      ).resolves.toBeDefined();
    }
    await expect(
      app.pool.query(
        `insert into knowledge_documents (id, base_id, title, source_type, mime_type)
         values ($1, $2, 'unknown', 'unknown_source', 'text/markdown')`,
        [unique('kdoc_db'), baseId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('round-trips all nine source types through the knowledge ZIP package', async () => {
    const baseId = await createBase();
    const embeddingProfileId = profileIds.at(-1) ?? '';
    expect(embeddingProfileId).not.toBe('');

    type Fixture = {
      sourceId: string;
      documentId: string;
      versionId: string;
      chunkIds: [string, string];
      original: Buffer;
      markdown: Buffer;
      sourcePath: string;
      mimeType: string;
      blobSha256: string;
      markdownSha256: string;
    };
    const fixtures = new Map<SourceType, Fixture>();

    for (const type of SOURCE_TYPES) {
      const source = await createSource(baseId, type);
      const original = Buffer.from(`# ${type}\n\n来源原件 ${type}\n`, 'utf8');
      const markdown = Buffer.from(`# ${type}\n\n来源正文 ${type}\n`, 'utf8');
      const mimeType = type === 'nextcloud' ? 'text/plain' : 'text/markdown';
      const upload = await inject(app, {
        method: 'PUT',
        url: `/api/knowledge/bases/${baseId}/documents/upload`,
        headers: { cookie },
        payload: {
          filename: `${type}.md`,
          mimeType,
          dataBase64: original.toString('base64'),
        },
      });
      expect(upload.statusCode, upload.body).toBe(202);
      const documentId = upload.json<{ documentId: string }>().documentId;
      const versionId = `kdv_${randomUUID().replace(/-/g, '')}`;
      const chunkIds: [string, string] = [
        `kchk_${randomUUID().replace(/-/g, '')}`,
        `kchk_${randomUUID().replace(/-/g, '')}`,
      ];
      const blobSha256 = sha256(original);
      const markdownSha256 = sha256(markdown);

      await mkdir(join(knowledgeDir, 'docs', documentId, versionId), { recursive: true });
      await writeFile(join(knowledgeDir, 'docs', documentId, versionId, 'markdown.md'), markdown);
      await app.pool.query(
        `insert into knowledge_document_versions
           (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
            size_bytes, source_revision, parse_status, page_map, images, embedding_profile_id, metadata)
         values ($1, $2, 1, $3, $4, $5, $6, $7, $8, 'parsed', $9::jsonb, '[]'::jsonb, $10, $11::jsonb)`,
        [
          versionId,
          documentId,
          blobSha256,
          markdownSha256,
          `${type}.md`,
          mimeType,
          original.length,
          `${type}-rev-1`,
          JSON.stringify([{ page: 1, startOffset: 0, endOffset: markdown.length }]),
          embeddingProfileId,
          JSON.stringify({
            faqImport: { batchId: 'kbatch_stale' },
            faqImportJobId: 'kjob_stale',
            marker: 'keep',
          }),
        ],
      );
      await app.pool.query(
        `insert into knowledge_chunks
           (id, base_id, document_id, version_id, ordinal, parent_ordinal, index_role, kind,
            heading, content, search_text, enabled, edited_by_user, token_count, metadata)
         values ($1, $2, $3, $4, 0, null, 'parent', 'text', null, $5, '', true, false, 10, '{}'::jsonb)`,
        [chunkIds[0], baseId, documentId, versionId, `parent body ${type}`],
      );
      await app.pool.query(
        `insert into knowledge_chunks
           (id, base_id, document_id, version_id, ordinal, parent_ordinal, index_role, kind,
            heading, content, search_text, enabled, edited_by_user, page_from, page_to, locator,
            token_count, metadata)
         values ($1, $2, $3, $4, 1, 0, 'leaf', 'text', $5, $6, '', true, true, 1, 1, $7::jsonb, 3, '{}'::jsonb)`,
        [
          chunkIds[1],
          baseId,
          documentId,
          versionId,
          `${type} heading`,
          `leaf body ${type}`,
          JSON.stringify({ pageFrom: 1, pageTo: 1, headingPath: [type] }),
        ],
      );

      const sourcePath = type === 'nextcloud' ? `/Documents/${type}.md` : `sources/${type}/page.md`;
      // 真实连接 ID 参与 sourceId，模拟 worker 的 `<connectionId>:<leaf externalId>`。
      const sourceId = `${source.id}:${type}:item-1`;
      expect(sourceId.length).toBeLessThanOrEqual(500);
      await app.pool.query(
        `update knowledge_documents
            set source_type = $2, source_id = $3, source_connection_id = $4, source_path = $5,
                source_url = null, mime_type = $6, size_bytes = $7, status = 'ready',
                current_version_id = $8, metadata = $9::jsonb
          where id = $1`,
        [
          documentId,
          type,
          sourceId,
          source.id,
          sourcePath,
          mimeType,
          original.length,
          versionId,
          JSON.stringify({ knowledgeSourceId: source.id, note: 'keep' }),
        ],
      );
      fixtures.set(type, {
        sourceId,
        documentId,
        versionId,
        chunkIds,
        original,
        markdown,
        sourcePath,
        mimeType,
        blobSha256,
        markdownSha256,
      });
    }

    const exported = await injectZip(app, 'GET', `/api/knowledge/bases/${baseId}/export`, cookie);
    expect(exported.statusCode, exported.body).toBe(200);
    const zip = exported.rawPayload;
    const entries = unzipSync(new Uint8Array(zip));
    type ManifestDocument = {
      sourceType: SourceType;
      sourceId: string | null;
      sourcePath: string | null;
      mimeType: string;
      currentVersionId: string | null;
      metadata: Record<string, unknown>;
      versions: Array<{
        id: string;
        originalPath: string;
        markdownPath: string | null;
        sourceRevision: string | null;
        chunks: Array<{
          id: string;
          ordinal: number;
          parentOrdinal: number | null;
          indexRole: string;
          locator: Record<string, unknown> | null;
        }>;
      }>;
    };
    const manifestFile = entries['manifest.json'] ?? new Uint8Array();
    const manifest = JSON.parse(new TextDecoder().decode(manifestFile)) as {
      documents: ManifestDocument[];
    };
    expect(manifest.documents).toHaveLength(SOURCE_TYPES.length);

    for (const type of SOURCE_TYPES) {
      const fixture = fixtures.get(type)!;
      const document = manifest.documents.find((item) => item.sourceType === type);
      expect(document, type).toBeDefined();
      expect(document).toMatchObject({
        sourceId: fixture.sourceId,
        sourcePath: fixture.sourcePath,
        mimeType: fixture.mimeType,
        currentVersionId: fixture.versionId,
      });
      // 来源归属属于本机同步状态，不随包导出。
      expect(document!.metadata).toEqual({ note: 'keep' });
      const version = document!.versions[0]!;
      expect(version.id).toBe(fixture.versionId);
      expect(version.sourceRevision).toBe(`${type}-rev-1`);
      expect(Buffer.from(entries[version.originalPath] ?? [])).toEqual(fixture.original);
      expect(Buffer.from(entries[version.markdownPath ?? ''] ?? [])).toEqual(fixture.markdown);
      expect(version.chunks.map((chunk) => chunk.locator)).toEqual([
        null,
        { pageFrom: 1, pageTo: 1, headingPath: [type] },
      ]);
    }

    const packageBytes = Buffer.concat(Object.values(entries));
    for (const type of SOURCE_TYPES) {
      const secret = Object.values(sourcePayloads[type].secrets as Record<string, string>)[0] ?? '';
      expect(secret).not.toBe('');
      expect(packageBytes.includes(Buffer.from(secret)), `${type} secret leaked`).toBe(false);
    }

    // 导出后删除原库及其内置 server，复用同一 embedding profile 导入新库。
    const originalBase = await app.pool.query<{ slug: string }>(
      'select slug from knowledge_bases where id = $1',
      [baseId],
    );
    await app.pool.query('delete from knowledge_bases where id = $1', [baseId]);
    await app.pool.query('delete from servers where name = $1', [
      `kb-${originalBase.rows[0]?.slug ?? ''}`,
    ]);
    const imported = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, zip);
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<{ baseId: string }>();
    baseIds.push(result.baseId);

    // 来源凭证/游标/连接不随包迁移：新库没有 knowledge_sources，文档连接置空。
    const sources = await app.pool.query<{ n: string }>(
      'select count(*)::text as n from knowledge_sources where base_id = $1',
      [result.baseId],
    );
    expect(sources.rows[0]?.n).toBe('0');

    const rows = await app.pool.query<{
      document_id: string;
      source_type: string;
      source_id: string;
      source_path: string | null;
      mime_type: string;
      source_connection_id: string | null;
      current_version_id: string;
      metadata: Record<string, unknown>;
      version_id: string;
      blob_sha256: string;
      markdown_sha256: string;
      source_revision: string | null;
      version_metadata: Record<string, unknown>;
    }>(
      `select d.id as document_id, d.source_type, d.source_id, d.source_path, d.mime_type,
              d.source_connection_id, d.current_version_id, d.metadata, v.id as version_id,
              v.blob_sha256, v.markdown_sha256, v.source_revision, v.metadata as version_metadata
         from knowledge_documents d
         join knowledge_document_versions v on v.id = d.current_version_id
        where d.base_id = $1`,
      [result.baseId],
    );
    expect(rows.rows).toHaveLength(SOURCE_TYPES.length);
    for (const row of rows.rows) {
      const type = row.source_type as SourceType;
      const fixture = fixtures.get(type)!;
      expect(row).toMatchObject({
        source_id: fixture.sourceId,
        source_path: fixture.sourcePath,
        mime_type: fixture.mimeType,
        source_connection_id: null,
        blob_sha256: fixture.blobSha256,
        markdown_sha256: fixture.markdownSha256,
        source_revision: `${type}-rev-1`,
      });
      expect(row.current_version_id).not.toBe(fixture.versionId);
      expect(row.version_id).toBe(row.current_version_id);
      expect(row.metadata).toEqual({ note: 'keep' });
      expect(row.version_metadata).toEqual({ marker: 'keep' });

      const blob = await readFile(
        join(knowledgeDir, 'blobs', fixture.blobSha256.slice(0, 2), fixture.blobSha256),
      );
      expect(blob).toEqual(fixture.original);

      const chunks = await app.pool.query<{
        id: string;
        version_id: string;
        ordinal: number;
        parent_ordinal: number | null;
        index_role: string;
        content: string;
        edited_by_user: boolean;
        locator: Record<string, unknown> | null;
      }>(
        `select id, version_id, ordinal, parent_ordinal, index_role, content, edited_by_user, locator
           from knowledge_chunks where document_id = $1 order by ordinal`,
        [row.document_id],
      );
      expect(chunks.rows.map((chunk) => chunk.id)).not.toContain(fixture.chunkIds[0]);
      expect(chunks.rows.map((chunk) => chunk.id)).not.toContain(fixture.chunkIds[1]);
      expect(chunks.rows).toMatchObject([
        {
          version_id: row.current_version_id,
          ordinal: 0,
          parent_ordinal: null,
          index_role: 'parent',
          content: `parent body ${type}`,
          locator: null,
        },
        {
          version_id: row.current_version_id,
          ordinal: 1,
          parent_ordinal: 0,
          index_role: 'leaf',
          content: `leaf body ${type}`,
          edited_by_user: true,
          locator: { pageFrom: 1, pageTo: 1, headingPath: [type] },
        },
      ]);
    }
  });
});
