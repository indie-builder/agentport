import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cookieOf,
  createAccount,
  createRole,
  expectProblem,
  grants,
  login,
  unique,
} from './access-helpers.js';
import { infraReady, inject, loginCookie, startApp } from './helpers.js';

const ready = await infraReady;
const PASSWORD = 'test-password-123';
const SELECTION_KEYS = ['enabled', 'id', 'kind', 'name', 'supportsImageVectors'];

interface Selection {
  id: string;
  name: string;
  kind: 'embedding' | 'rerank';
  enabled: boolean;
  supportsImageVectors: boolean;
}

interface Profile {
  id: string;
  endpointUrl: string;
  model: string;
  hasSecret: boolean;
}

describe.skipIf(!ready)('knowledge model profile selection', () => {
  let app: FastifyInstance;
  let admin: string;
  let reader: string;
  let creator: string;
  let updater: string;
  let manager: string;
  const profileIds: string[] = [];
  const baseIds: string[] = [];
  const profiles = {} as Record<
    'capable' | 'disabledCapable' | 'nonCohere' | 'imageOff' | 'rerank',
    Profile
  >;
  let baseId = '';

  const createProfile = async (input: Record<string, unknown>): Promise<Profile> => {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie: admin },
      payload: {
        endpointUrl: 'http://127.0.0.1:9',
        enabled: true,
        ...input,
        name: unique(String(input.name ?? 'profile')),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const profile = res.json<Profile>();
    profileIds.push(profile.id);
    return profile;
  };

  const makeUser = async (roleId: string): Promise<string> => {
    const created = await createAccount(app, admin, {
      roleIds: [roleId],
      password: PASSWORD,
    });
    expect(created.statusCode, created.body).toBe(201);
    const signIn = await login(app, created.account.username, PASSWORD);
    expect(signIn.statusCode, signIn.body).toBe(200);
    return cookieOf(signIn);
  };

  beforeAll(async () => {
    app = await startApp();
    admin = await loginCookie(app);

    reader = await makeUser(
      (await createRole(app, admin, unique('kb-read'), grants(['knowledge.read', 'platform']))).id,
    );
    creator = await makeUser(
      (
        await createRole(
          app,
          admin,
          unique('kb-create'),
          grants(['knowledge.read', 'platform'], ['knowledge.create', 'platform']),
        )
      ).id,
    );
    updater = await makeUser(
      (
        await createRole(
          app,
          admin,
          unique('kb-update'),
          grants(['knowledge.read', 'platform'], ['knowledge.update', 'platform']),
        )
      ).id,
    );
    manager = await makeUser(
      (
        await createRole(
          app,
          admin,
          unique('kb-manage'),
          grants(['knowledge.read', 'platform'], ['knowledge.models.manage', 'platform']),
        )
      ).id,
    );

    profiles.capable = await createProfile({
      kind: 'embedding',
      name: 'capable',
      model: 'embed-v4.0',
      embeddingProtocol: 'cohere_v2',
      imageInputEnabled: true,
    });
    profiles.disabledCapable = await createProfile({
      kind: 'embedding',
      name: 'disabled-capable',
      model: 'embed-v4.0',
      embeddingProtocol: 'cohere_v2',
      imageInputEnabled: true,
      enabled: false,
    });
    profiles.nonCohere = await createProfile({
      kind: 'embedding',
      name: 'non-cohere',
      model: 'bge-m3',
      embeddingProtocol: 'openai',
    });
    profiles.imageOff = await createProfile({
      kind: 'embedding',
      name: 'image-off',
      model: 'embed-v4.0',
      embeddingProtocol: 'cohere_v2',
      imageInputEnabled: false,
    });
    profiles.rerank = await createProfile({
      kind: 'rerank',
      name: 'reranker',
      model: 'bge-reranker-v2',
    });

    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie: admin },
      payload: {
        slug: unique('kb'),
        name: '选择投影测试库',
        embeddingProfileId: profiles.capable.id,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    baseId = res.json<{ id: string }>().id;
    baseIds.push(baseId);
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
  });

  it('requires login and rejects an unknown view', async () => {
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: '/api/knowledge/model-profiles?view=selection',
      }),
      'UNAUTHORIZED',
    );
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: '/api/knowledge/model-profiles?view=all',
        headers: { cookie: manager },
      }),
      'INVALID_INPUT',
    );
  });

  it('serves the selection projection with read, and the management list only with manage', async () => {
    for (const cookie of [reader, creator, updater, manager]) {
      const res = await inject(app, {
        method: 'GET',
        url: '/api/knowledge/model-profiles?view=selection',
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
    }

    for (const cookie of [reader, creator, updater]) {
      expectProblem(
        await inject(app, {
          method: 'GET',
          url: '/api/knowledge/model-profiles',
          headers: { cookie },
        }),
        'FORBIDDEN',
      );
    }

    const managed = await inject(app, {
      method: 'GET',
      url: '/api/knowledge/model-profiles',
      headers: { cookie: manager },
    });
    expect(managed.statusCode, managed.body).toBe(200);
    const rows = managed.json<Profile[]>();
    const capable = rows.find((row) => row.id === profiles.capable.id);
    expect(capable).toMatchObject({ endpointUrl: 'http://127.0.0.1:9', model: 'embed-v4.0' });
    expect(capable).toHaveProperty('hasSecret');
  });

  it('keeps create and update writes on their original permissions', async () => {
    const created = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie: creator },
      payload: {
        slug: unique('kb-created'),
        name: '由创建者新建',
        embeddingProfileId: profiles.capable.id,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    baseIds.push(created.json<{ id: string }>().id);

    expectProblem(
      await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/bases/${baseId}`,
        headers: { cookie: creator },
        payload: { name: '创建者不能改' },
      }),
      'FORBIDDEN',
    );

    expectProblem(
      await inject(app, {
        method: 'POST',
        url: '/api/knowledge/bases',
        headers: { cookie: updater },
        payload: {
          slug: unique('kb-denied'),
          name: '更新者不能建',
          embeddingProfileId: profiles.capable.id,
        },
      }),
      'FORBIDDEN',
    );

    const updated = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/bases/${baseId}`,
      headers: { cookie: updater },
      payload: { name: '更新者可以改' },
    });
    expect(updated.statusCode, updated.body).toBe(200);
  });

  it('returns exactly five fields including disabled profiles and computed image capability', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: '/api/knowledge/model-profiles?view=selection',
      headers: { cookie: reader },
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json<Selection[]>();
    const byId = new Map(items.map((item) => [item.id, item]));

    expect(byId.get(profiles.capable.id)).toMatchObject({
      name: expect.any(String),
      kind: 'embedding',
      enabled: true,
      supportsImageVectors: true,
    });
    // 停用项仍要回显，但能力按 enabled 计算为 false。
    expect(byId.get(profiles.disabledCapable.id)).toMatchObject({
      enabled: false,
      supportsImageVectors: false,
    });
    expect(byId.get(profiles.nonCohere.id)?.supportsImageVectors).toBe(false);
    expect(byId.get(profiles.imageOff.id)?.supportsImageVectors).toBe(false);
    expect(byId.get(profiles.rerank.id)).toMatchObject({
      kind: 'rerank',
      supportsImageVectors: false,
    });

    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(SELECTION_KEYS);
      expect(item).not.toHaveProperty('endpointUrl');
      expect(item).not.toHaveProperty('model');
      expect(item).not.toHaveProperty('embeddingProtocol');
      expect(item).not.toHaveProperty('hasSecret');
      expect(item).not.toHaveProperty('dimensions');
      expect(item).not.toHaveProperty('apiKey');
      expect(item).not.toHaveProperty('secrets');
      expect(item).not.toHaveProperty('createdAt');
      expect(item).not.toHaveProperty('updatedAt');
    }
  });
});
