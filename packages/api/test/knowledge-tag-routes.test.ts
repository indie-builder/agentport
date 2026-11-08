import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cookieOf,
  createAccount,
  createRole,
  expectProblem,
  grants,
  login,
} from './access-helpers.js';
import { infraReady, loginCookie, request, startApp, type TestApp, unique } from './helpers.js';

const ready = await infraReady;
const PASSWORD = 'test-password-123';

describe.skipIf(!ready)('knowledge tag routes', () => {
  let app: TestApp;
  let cookie = '';
  let knowledgeDir = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-tag-routes-'));
    app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
    cookie = await loginCookie(app);
  });

  afterEach(async () => {
    if (baseIds.length > 0) {
      // 知识库 server 是独立行；删 server 会级联删库，避免留下 kb-<slug> 名称占用。
      await app.client.unsafe(
        "delete from servers where kind = 'knowledge' and config->>'knowledgeBaseId' = any($1::text[])",
        [app.client.array(baseIds, 'TEXT')],
      );
      await app.client.unsafe('delete from knowledge_bases where id = any($1::text[])', [
        app.client.array(baseIds, 'TEXT'),
      ]);
      baseIds.length = 0;
    }
    if (profileIds.length > 0) {
      await app.client.unsafe('delete from knowledge_model_profiles where id = any($1::text[])', [
        app.client.array(profileIds, 'TEXT'),
      ]);
      profileIds.length = 0;
    }
  });

  afterAll(async () => {
    await app.close();
    await rm(knowledgeDir, { recursive: true, force: true });
  });

  async function createBase(): Promise<string> {
    const profile = await request(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('tag-emb'),
        endpointUrl: 'http://127.0.0.1:1',
        model: 'test',
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    const profileId = profile.json<{ id: string }>().id;
    profileIds.push(profileId);

    const res = await request(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: { slug: unique('tag-kb'), name: '标签库', embeddingProfileId: profileId },
    });
    expect(res.statusCode, res.body).toBe(201);
    const baseId = res.json<{ id: string }>().id;
    baseIds.push(baseId);
    return baseId;
  }

  async function createTag(baseId: string, name: string) {
    const res = await request(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/tags`,
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string; name: string }>();
  }

  function rename(tagId: string, name: string, actorCookie = cookie) {
    return request(app, {
      method: 'PATCH',
      url: `/api/knowledge/tags/${tagId}`,
      headers: { cookie: actorCookie },
      payload: { name },
    });
  }

  async function documentTags(documentId: string): Promise<string[]> {
    const res = await request(app, {
      method: 'GET',
      url: `/api/knowledge/documents/${documentId}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ tags: string[] }>().tags;
  }

  it('renames a tag and the documents carrying it show the new name', async () => {
    const baseId = await createBase();
    const tag = await createTag(baseId, '流程');

    const created = await request(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/manual`,
      headers: { cookie },
      payload: { title: '发布流程', content: '发布前需要双方确认。', tags: ['流程'] },
    });
    expect(created.statusCode, created.body).toBe(202);
    const documentId = created.json<{ documentId: string }>().documentId;
    expect(await documentTags(documentId)).toEqual(['流程']);

    const res = await rename(tag.id, '流程规范');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ id: string; name: string }>()).toMatchObject({
      id: tag.id,
      name: '流程规范',
    });

    expect(await documentTags(documentId)).toEqual(['流程规范']);
    const tags = await request(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/tags`,
      headers: { cookie },
    });
    expect(tags.statusCode, tags.body).toBe(200);
    expect(tags.json<{ name: string }[]>().map((entry) => entry.name)).toEqual(['流程规范']);
  });

  it('rejects a rename that collides with another tag in the same base', async () => {
    const baseId = await createBase();
    const first = await createTag(baseId, '流程');
    await createTag(baseId, '规范');

    expectProblem(await rename(first.id, '规范'), 'CONFLICT');
  });

  it('rejects renaming a missing tag', async () => {
    expectProblem(await rename(unique('ktag'), '任意'), 'NOT_FOUND');
  });

  it('requires knowledge.content.manage to rename a tag', async () => {
    const baseId = await createBase();
    const tag = await createTag(baseId, '流程');
    const readerRole = await createRole(
      app,
      cookie,
      unique('tag-reader'),
      grants(['knowledge.read', 'platform']),
    );
    const account = await createAccount(app, cookie, {
      roleIds: [readerRole.id],
      password: PASSWORD,
    });
    expect(account.statusCode, account.body).toBe(201);
    const signIn = await login(app, account.account.username, PASSWORD);
    expect(signIn.statusCode, signIn.body).toBe(200);

    expectProblem(await rename(tag.id, '流程规范', cookieOf(signIn)), 'FORBIDDEN');
  });

  it('writes an audit record for the rename', async () => {
    const baseId = await createBase();
    const tag = await createTag(baseId, '流程');

    expect((await rename(tag.id, '流程规范')).statusCode).toBe(200);

    const rows = await app.client.unsafe<{ action: string; actor: string }[]>(
      "select action, actor from audit_log where target = $1 and action = 'knowledge.tag.renamed'",
      [tag.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.actor).toBeTruthy();
  });
});
