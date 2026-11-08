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

interface ActivityItem {
  id: string;
  action: string;
  actor: string;
  status: string;
  targetKind: 'base' | 'document' | 'tag';
  createdAt: string;
}

interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
}

describe.skipIf(!ready)('knowledge base activity', () => {
  let app: TestApp;
  let cookie = '';
  let knowledgeDir = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-activity-'));
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
        name: unique('activity-emb'),
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
      payload: { slug: unique('activity-kb'), name: '活动库', embeddingProfileId: profileId },
    });
    expect(res.statusCode, res.body).toBe(201);
    const baseId = res.json<{ id: string }>().id;
    baseIds.push(baseId);
    return baseId;
  }

  async function uploadDocument(baseId: string): Promise<string> {
    const res = await request(app, {
      method: 'PUT',
      url: `/api/knowledge/bases/${baseId}/documents/upload`,
      headers: { cookie },
      payload: {
        filename: 'notes.md',
        mimeType: 'text/markdown',
        dataBase64: Buffer.from('# 记录\n\n活动流的文档事件。', 'utf8').toString('base64'),
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    return res.json<{ documentId: string }>().documentId;
  }

  async function createTag(baseId: string, name: string) {
    const res = await request(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/tags`,
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>();
  }

  function renameTag(tagId: string, name: string) {
    return request(app, {
      method: 'PATCH',
      url: `/api/knowledge/tags/${tagId}`,
      headers: { cookie },
      payload: { name },
    });
  }

  function activity(baseId: string, query: Record<string, string> = {}) {
    return request(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/activity`,
      headers: { cookie },
      query,
    });
  }

  function patchBase(baseId: string, payload: Record<string, unknown>) {
    return request(app, {
      method: 'PATCH',
      url: `/api/knowledge/bases/${baseId}`,
      headers: { cookie },
      payload,
    });
  }

  it('feeds base, document and tag events newest first with their target kind', async () => {
    const baseId = await createBase();
    // 文档与标签的审计 target 是自身 id，活动流按库归属回连，不是直接命中 baseId。
    await uploadDocument(baseId);
    const tag = await createTag(baseId, '流程');
    expect((await renameTag(tag.id, '流程规范')).statusCode).toBe(200);

    const res = await activity(baseId);
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json<ActivityPage>();

    expect(page.items.map((item) => [item.action, item.targetKind])).toEqual([
      ['knowledge.tag.renamed', 'tag'],
      ['knowledge.document.uploaded', 'document'],
      ['knowledge.base.created', 'base'],
    ]);
    expect(page.items.every((item) => item.status === 'ok')).toBe(true);
    expect(page.items.every((item) => item.actor.length > 0)).toBe(true);
    expect(page.nextCursor).toBeNull();

    // 真实时间倒序，不依赖 id 或插入顺序。
    const times = page.items.map((item) => Date.parse(item.createdAt));
    expect(times).toEqual([...times].sort((left, right) => right - left));
  });

  it('pages by the created_at,id cursor instead of offset', async () => {
    const baseId = await createBase();
    const documentId = await uploadDocument(baseId);
    const tag = await createTag(baseId, '规范');
    expect((await renameTag(tag.id, '规范 V2')).statusCode).toBe(200);

    // 请求间隔可能落在同一微秒内，先把三条审计的时间固定下来，游标断言才有确定顺序。
    await app.client.unsafe(
      "update audit_log set created_at = '2026-01-01T00:00:00Z'::timestamptz where action = 'knowledge.base.created' and target = $1",
      [baseId],
    );
    await app.client.unsafe(
      "update audit_log set created_at = '2026-01-02T00:00:00Z'::timestamptz where action = 'knowledge.document.uploaded' and target = $1",
      [documentId],
    );
    await app.client.unsafe(
      "update audit_log set created_at = '2026-01-03T00:00:00Z'::timestamptz where action = 'knowledge.tag.renamed' and target = $1",
      [tag.id],
    );

    const first = await activity(baseId, { limit: '2' });
    expect(first.statusCode, first.body).toBe(200);
    const page1 = first.json<ActivityPage>();
    expect(page1.items.map((item) => item.action)).toEqual([
      'knowledge.tag.renamed',
      'knowledge.document.uploaded',
    ]);
    expect(page1.nextCursor).toBe(page1.items[1]?.id ?? null);

    const second = await activity(baseId, { limit: '2', cursor: page1.nextCursor ?? '' });
    expect(second.statusCode, second.body).toBe(200);
    const page2 = second.json<ActivityPage>();
    expect(page2.items.map((item) => item.action)).toEqual(['knowledge.base.created']);
    expect(page2.nextCursor).toBeNull();
  });

  it('records a base update before the earlier creation, and skips an empty patch', async () => {
    const baseId = await createBase();
    // 创建与改名可能落在同一微秒内，先把创建事件固定到更早的时间，倒序断言才确定。
    await app.client.unsafe(
      "update audit_log set created_at = '2026-01-01T00:00:00Z'::timestamptz where action = 'knowledge.base.created' and target = $1",
      [baseId],
    );

    expect((await patchBase(baseId, {})).statusCode).toBe(200);
    // 空 patch 没有任何字段变更，不该凭空多出一条「更新知识库」。
    expect((await activity(baseId)).json<ActivityPage>().items.map((item) => item.action)).toEqual([
      'knowledge.base.created',
    ]);

    const patched = await patchBase(baseId, { name: '改名后的活动库' });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<{ name: string }>().name).toBe('改名后的活动库');

    const page = (await activity(baseId)).json<ActivityPage>();
    expect(page.items.map((item) => [item.action, item.targetKind])).toEqual([
      ['knowledge.base.updated', 'base'],
      ['knowledge.base.created', 'base'],
    ]);

    // 审计只落 input 摘要（不存原文），换个库、换个名字、只改同一个字段时摘要应当一致，
    // 说明 input 里记的是字段名列表而不是具体值。
    const digestOf = async (target: string) => {
      const rows = await app.client.unsafe<{ input_digest: string | null }[]>(
        "select input_digest from audit_log where action = 'knowledge.base.updated' and target = $1",
        [target],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.input_digest).not.toBeNull();
      return rows[0]?.input_digest;
    };
    const otherBaseId = await createBase();
    expect((await patchBase(otherBaseId, { name: '另一个名字' })).statusCode).toBe(200);
    expect(await digestOf(otherBaseId)).toBe(await digestOf(baseId));

    // 改的是另一个字段，字段名列表不同，摘要随之变化。
    expect((await patchBase(otherBaseId, { description: '新的描述' })).statusCode).toBe(200);
    const digests = await app.client.unsafe<{ input_digest: string | null }[]>(
      `select input_digest from audit_log
       where action = 'knowledge.base.updated' and target = $1
       order by created_at desc, id desc`,
      [otherBaseId],
    );
    expect(digests).toHaveLength(2);
    expect(digests[0]?.input_digest).not.toBe(digests[1]?.input_digest);
  });

  it('returns not found for a missing base', async () => {
    expectProblem(await activity(unique('kb')), 'NOT_FOUND');
  });

  it('is readable with knowledge.read alone, without update', async () => {
    const baseId = await createBase();
    await uploadDocument(baseId);

    const readerRole = await createRole(
      app,
      cookie,
      unique('activity-reader'),
      grants(['knowledge.read', 'platform']),
    );
    const account = await createAccount(app, cookie, {
      roleIds: [readerRole.id],
      password: PASSWORD,
    });
    expect(account.statusCode, account.body).toBe(201);
    const signIn = await login(app, account.account.username, PASSWORD);
    expect(signIn.statusCode, signIn.body).toBe(200);
    const readerCookie = cookieOf(signIn);

    const res = await request(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/activity`,
      headers: { cookie: readerCookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<ActivityPage>().items.map((item) => item.action)).toContain(
      'knowledge.document.uploaded',
    );

    // 只有 read：活动流能读，但同一账号改信息被拒，说明入口没有顺带要求 update。
    expectProblem(
      await request(app, {
        method: 'PATCH',
        url: `/api/knowledge/bases/${baseId}`,
        headers: { cookie: readerCookie },
        payload: { name: '只读改名' },
      }),
      'FORBIDDEN',
    );
  });
});
