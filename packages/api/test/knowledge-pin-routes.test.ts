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

describe.skipIf(!ready)('knowledge base pins', () => {
  let app: TestApp;
  let cookie = '';
  let knowledgeDir = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-pin-routes-'));
    app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
    cookie = await loginCookie(app);
  });

  afterEach(async () => {
    if (baseIds.length > 0) {
      // 置顶随 base 级联删除；先清 pin 再删库，避免噪声依赖 FK 顺序。
      await app.client.unsafe('delete from knowledge_base_pins where base_id = any($1::text[])', [
        app.client.array(baseIds, 'TEXT'),
      ]);
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
        name: unique('pin-emb'),
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
      payload: { slug: unique('pin-kb'), name: '置顶库', embeddingProfileId: profileId },
    });
    expect(res.statusCode, res.body).toBe(201);
    const baseId = res.json<{ id: string }>().id;
    baseIds.push(baseId);
    return baseId;
  }

  function listPins(viewer: string) {
    return request(app, {
      method: 'GET',
      url: '/api/knowledge/bases/pins',
      headers: { cookie: viewer },
    });
  }

  function setPin(baseId: string, pinned: boolean, viewer = cookie) {
    return request(app, {
      method: 'PUT',
      url: `/api/knowledge/bases/${baseId}/pin`,
      headers: { cookie: viewer },
      payload: { pinned },
    });
  }

  async function readerCookie(): Promise<string> {
    const role = await createRole(
      app,
      cookie,
      unique('pin-reader'),
      grants(['knowledge.read', 'platform']),
    );
    const account = await createAccount(app, cookie, { roleIds: [role.id], password: PASSWORD });
    expect(account.statusCode, account.body).toBe(201);
    const signIn = await login(app, account.account.username, PASSWORD);
    expect(signIn.statusCode, signIn.body).toBe(200);
    return cookieOf(signIn);
  }

  it('starts unpinned and toggles a base through the pin route', async () => {
    const baseId = await createBase();

    const empty = await listPins(cookie);
    expect(empty.statusCode, empty.body).toBe(200);
    // 路径不能被 `/knowledge/bases/{id}` 抢走：返回的必须是置顶列表本身。
    expect(empty.json()).toEqual({ baseIds: [] });

    const pinned = await setPin(baseId, true);
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(pinned.json()).toEqual({ pinned: true });

    const afterPin = await listPins(cookie);
    expect(afterPin.json()).toEqual({ baseIds: [baseId] });

    // 重复置顶幂等：不新增第二行，也不会让请求失败。
    const again = await setPin(baseId, true);
    expect(again.statusCode, again.body).toBe(200);
    expect((await listPins(cookie)).json()).toEqual({ baseIds: [baseId] });

    const unpinned = await setPin(baseId, false);
    expect(unpinned.statusCode, unpinned.body).toBe(200);
    expect(unpinned.json()).toEqual({ pinned: false });
    expect((await listPins(cookie)).json()).toEqual({ baseIds: [] });

    // 取消一个本来就没置顶的库同样成功。
    expect((await setPin(baseId, false)).statusCode).toBe(200);
  });

  it('rejects pinning a base that does not exist', async () => {
    expectProblem(await setPin(unique('kb-missing'), true), 'NOT_FOUND');
  });

  it('keeps pins per account and lets a knowledge.read subject pin', async () => {
    const adminBase = await createBase();
    const readerBase = await createBase();
    const reader = await readerCookie();

    expect((await setPin(adminBase, true)).statusCode).toBe(200);
    expect((await setPin(readerBase, true, reader)).statusCode).toBe(200);

    expect((await listPins(cookie)).json()).toEqual({ baseIds: [adminBase] });
    expect((await listPins(reader)).json()).toEqual({ baseIds: [readerBase] });

    // 取消自己的置顶不影响另一个账号。
    expect((await setPin(readerBase, false, reader)).statusCode).toBe(200);
    expect((await listPins(reader)).json()).toEqual({ baseIds: [] });
    expect((await listPins(cookie)).json()).toEqual({ baseIds: [adminBase] });
  });

  it('requires knowledge.read for both reading and writing pins', async () => {
    const baseId = await createBase();
    const account = await createAccount(app, cookie, { password: PASSWORD });
    expect(account.statusCode, account.body).toBe(201);
    const signIn = await login(app, account.account.username, PASSWORD);
    expect(signIn.statusCode, signIn.body).toBe(200);
    const viewer = cookieOf(signIn);

    expectProblem(await listPins(viewer), 'FORBIDDEN');
    expectProblem(await setPin(baseId, true, viewer), 'FORBIDDEN');
  });
});
