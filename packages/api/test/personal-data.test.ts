import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encryptSecrets, prepareOutputDraft, publishOutputSnapshot } from '@agentport/core';
import { newId } from '@agentport/db';
import {
  type AccessScope,
  type PermissionId,
  personalOutputShareListSchema,
  personalRunListSchema,
  personalUsageSummarySchema,
  utcWindowStart,
} from '@agentport/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  ADMIN_BUSINESS_ID,
  cleanup,
  createAgent,
  createTestAccount,
  expectProblem,
  infraReady,
  inject,
  loginAs,
  loginCookie,
  testConfig,
  unique,
} from './helpers.js';

const ready = await infraReady;
const PASSWORD = 'test-password-123';

interface SeededAccount {
  businessId: string;
  cookie: string;
}

interface SeedRunInput {
  agentId: string;
  businessId?: string;
  serviceId?: 'system' | 'mcp';
  status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  trigger?: 'chat' | 'mcp' | 'schedule' | 'event' | 'review' | 'channel';
  createdAt?: Date;
  costUsd?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  conversationId?: string;
  conversationOwner?: string | null;
  channelId?: string;
  error?: string;
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

describe.skipIf(!ready)('personal data', () => {
  let app: FastifyInstance;
  let admin: string;
  const accountIds: string[] = [];
  const roleIds: string[] = [];
  const directAgentIds: string[] = [];
  const agentSlugs: string[] = [];
  const channelIds: string[] = [];

  const auth = (cookie: string) => ({ cookie });

  async function createRole(grants: Array<[PermissionId, AccessScope]>): Promise<string> {
    const id = newId('role');
    await app.pool.query(
      'insert into roles (id, name, created_at, updated_at) values ($1, $2, now(), now())',
      [id, unique('personal-role')],
    );
    for (const [permissionId, scope] of grants) {
      await app.pool.query(
        'insert into role_permissions (role_id, permission_id, scope) values ($1, $2, $3)',
        [id, permissionId, scope],
      );
    }
    roleIds.push(id);
    return id;
  }

  async function createAccountWithRoles(roleIdsForAccount: string[]): Promise<SeededAccount> {
    const businessId = unique('biz');
    const username = unique('user');
    const res = await inject(app, {
      method: 'POST',
      url: '/api/accounts',
      headers: auth(admin),
      payload: {
        businessId,
        username,
        name: '个人数据测试',
        password: PASSWORD,
        restore: false,
        roleIds: roleIdsForAccount,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    accountIds.push(businessId);
    return { businessId, cookie: await loginAs(app, username, PASSWORD) };
  }

  async function seedAgent(createdBy: string): Promise<string> {
    const id = newId('agent');
    await app.pool.query(
      "insert into agents (id, slug, name, model, created_by, owner_business_id) values ($1, $1, $1, 'm', $2, $2)",
      [id, createdBy],
    );
    directAgentIds.push(id);
    return id;
  }

  async function seedRun(input: SeedRunInput): Promise<{ runId: string; conversationId: string }> {
    const runId = newId('run');
    const conversationId = input.conversationId ?? newId('conversation');
    if (input.conversationId === undefined) {
      if (input.serviceId === undefined) {
        await app.pool.query(
          'insert into conversations (id, agent_id, created_by, channel_id) values ($1, $2, $3, $4)',
          [
            conversationId,
            input.agentId,
            input.conversationOwner ?? input.businessId,
            input.channelId ?? null,
          ],
        );
      } else {
        await app.pool.query(
          'insert into conversations (id, agent_id, service_id) values ($1, $2, $3)',
          [conversationId, input.agentId, input.serviceId],
        );
      }
    }
    await app.pool.query(
      `insert into agent_runs
         (id, conversation_id, agent_id, status, trigger, subject_kind, initiated_by, service_id,
          channel_id, error, created_at, cost_usd, input_tokens, output_tokens)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        runId,
        conversationId,
        input.agentId,
        input.status ?? 'succeeded',
        input.trigger ?? 'chat',
        input.serviceId === undefined ? 'user' : 'service',
        input.serviceId === undefined ? input.businessId : null,
        input.serviceId ?? null,
        input.channelId ?? null,
        input.error ?? null,
        input.createdAt ?? new Date(),
        input.costUsd ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
      ],
    );
    return { runId, conversationId };
  }

  async function seedShare(input: {
    businessId: string;
    agentId: string;
    conversationId?: string;
    runId?: string;
    path?: string;
  }): Promise<{ id: string; token: string; conversationId: string; runId: string; path: string }> {
    const id = newId('outputShare');
    const token = unique('share-token');
    const conversationId = input.conversationId ?? newId('conversation');
    const runId = input.runId ?? newId('run');
    const path = input.path ?? 'report.md';
    if (input.conversationId === undefined) {
      await app.pool.query(
        'insert into conversations (id, agent_id, created_by, title) values ($1, $2, $3, $4)',
        [conversationId, input.agentId, input.businessId, '我的分享会话'],
      );
    }
    await app.pool.query(
      `insert into output_shares
         (id, conversation_id, run_id, path, sha256, token_hash, token_encrypted)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        conversationId,
        runId,
        path,
        sha256(`content-${id}`),
        sha256(token),
        encryptSecrets({ token }, app.config.APP_SECRET_KEY),
      ],
    );
    return { id, token, conversationId, runId, path };
  }

  async function publish(
    slug: string,
    conversationId: string,
    runId: string,
    path: string,
    content: string,
  ): Promise<void> {
    const draft = await prepareOutputDraft({
      root: app.config.WORKSPACES_DIR,
      slug,
      conversationId,
      runId,
    });
    const target = join(draft, ...path.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
    await publishOutputSnapshot({
      root: app.config.WORKSPACES_DIR,
      slug,
      conversationId,
      runId,
      status: 'succeeded',
      userMessageId: newId('message'),
      afterMessageId: newId('message'),
    });
  }

  function getRuns(cookie: string, query = ''): Promise<LightMyRequestResponse> {
    return inject(app, {
      method: 'GET',
      url: `/api/me/runs${query === '' ? '' : `?${query}`}`,
      headers: auth(cookie),
    });
  }

  function getUsage(cookie: string, query = ''): Promise<LightMyRequestResponse> {
    return inject(app, {
      method: 'GET',
      url: `/api/me/usage${query === '' ? '' : `?${query}`}`,
      headers: auth(cookie),
    });
  }

  function getShares(cookie: string, query = ''): Promise<LightMyRequestResponse> {
    return inject(app, {
      method: 'GET',
      url: `/api/me/output-shares${query === '' ? '' : `?${query}`}`,
      headers: auth(cookie),
    });
  }

  function getConversations(cookie: string, query = ''): Promise<LightMyRequestResponse> {
    return inject(app, {
      method: 'GET',
      url: `/api/me/conversations${query === '' ? '' : `?${query}`}`,
      headers: auth(cookie),
    });
  }

  function deleteShare(cookie: string, id: string): Promise<LightMyRequestResponse> {
    return inject(app, {
      method: 'DELETE',
      url: `/api/me/output-shares/${id}`,
      headers: auth(cookie),
    });
  }

  beforeAll(async () => {
    app = await buildApp(testConfig());
    await app.ready();
    admin = await loginCookie(app);
  }, 60_000);

  afterAll(async () => {
    await cleanup(app, { agentSlugs });
    if (channelIds.length > 0) {
      await app.pool.query('delete from channels where id = any($1::text[])', [channelIds]);
    }
    if (directAgentIds.length > 0) {
      await app.pool.query('delete from agents where id = any($1::text[])', [directAgentIds]);
    }
    if (accountIds.length > 0) {
      await app.pool.query('delete from user_roles where business_id = any($1::text[])', [
        accountIds,
      ]);
      await app.pool.query('delete from "user" where business_id = any($1::text[])', [accountIds]);
    }
    if (roleIds.length > 0) {
      await app.pool.query('delete from roles where id = any($1::text[])', [roleIds]);
    }
    await app.close();
  });

  it('requires a user principal and each endpoint permission', async () => {
    for (const url of [
      '/api/me/runs',
      '/api/me/usage',
      '/api/me/output-shares',
      '/api/me/conversations',
    ]) {
      expectProblem(await inject(app, { method: 'GET', url }), 'UNAUTHORIZED');
    }
    expectProblem(
      await inject(app, { method: 'DELETE', url: '/api/me/output-shares/osh_missing' }),
      'UNAUTHORIZED',
    );

    const role = await createRole([['personal_memory.read', 'own_data']]);
    const restricted = await createAccountWithRoles([role]);
    for (const url of [
      '/api/me/runs',
      '/api/me/usage',
      '/api/me/output-shares',
      '/api/me/conversations',
    ]) {
      expectProblem(
        await inject(app, { method: 'GET', url, headers: auth(restricted.cookie) }),
        'FORBIDDEN',
      );
    }
  });

  it('returns only the caller data for admin, user, owner and maintainer', async () => {
    const adminAgent = await createAgent(app, admin, { track: agentSlugs });
    const agentId = adminAgent.json<{ id: string }>().id;
    const user = await createTestAccount(app, admin, { systemKeys: ['user'] });
    const owner = await createTestAccount(app, admin, { systemKeys: ['owner'] });
    const maintainer = await createTestAccount(app, admin, { systemKeys: ['maintainer'] });
    accountIds.push(user.businessId, owner.businessId, maintainer.businessId);

    const byRole: Array<[string, string, string]> = [
      ['admin', admin, ADMIN_BUSINESS_ID],
      ['user', user.cookie, user.businessId],
      ['owner', owner.cookie, owner.businessId],
      ['maintainer', maintainer.cookie, maintainer.businessId],
    ];
    const expected = new Map<string, string>();
    for (const [label, , businessId] of byRole) {
      const { runId } = await seedRun({ agentId, businessId, createdAt: new Date() });
      expected.set(label, runId);
    }

    for (const [label, cookie] of byRole) {
      const res = await getRuns(cookie, 'days=90');
      expect(res.statusCode, res.body).toBe(200);
      const page = personalRunListSchema.parse(res.json());
      const ids = page.items.map((item) => item.id);
      // 其他套件并行写入管理员运行，管理员这里只证明「含本人、不含他人」。
      expect(ids).toContain(expected.get(label));
      for (const [otherLabel, otherRunId] of expected) {
        if (otherLabel !== label) expect(ids).not.toContain(otherRunId);
      }
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('counts own runs regardless of the expert creator and excludes other owners and services', async () => {
    const user = await createTestAccount(app, admin, { systemKeys: ['user'] });
    const other = await createTestAccount(app, admin, { systemKeys: ['user'] });
    accountIds.push(user.businessId, other.businessId);

    const adminAgent = await createAgent(app, admin, { track: agentSlugs });
    const adminAgentId = adminAgent.json<{ id: string }>().id;
    const userAgentId = await seedAgent(user.businessId);

    // 本人使用别人创建的专家：计入。
    const foreignExpert = await seedRun({
      agentId: adminAgentId,
      businessId: user.businessId,
      createdAt: new Date(),
    });
    // 别人使用本人的专家：不计入。
    await seedRun({
      agentId: userAgentId,
      businessId: other.businessId,
      createdAt: new Date(),
    });
    // 服务运行：不计入。
    await seedRun({
      agentId: userAgentId,
      serviceId: 'system',
      createdAt: new Date(),
    });
    // 本人发起，但来源会话属于别人：返回 conversationId=null。
    const foreignConversation = await seedRun({
      agentId: adminAgentId,
      businessId: user.businessId,
      conversationOwner: other.businessId,
      createdAt: new Date(),
    });
    // 本人发起且会话属于本人：返回真实 conversationId。
    const ownConversation = await seedRun({
      agentId: adminAgentId,
      businessId: user.businessId,
      createdAt: new Date(),
    });

    const res = await getRuns(user.cookie, 'days=90');
    expect(res.statusCode, res.body).toBe(200);
    const page = personalRunListSchema.parse(res.json());
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get(foreignExpert.runId)).toMatchObject({
      conversationId: foreignExpert.conversationId,
      trigger: 'chat',
    });
    expect(byId.get(foreignConversation.runId)?.conversationId).toBeNull();
    expect(byId.get(ownConversation.runId)?.conversationId).toBe(ownConversation.conversationId);
    expect(page.items.map((item) => item.id).sort()).toEqual(
      [foreignExpert.runId, foreignConversation.runId, ownConversation.runId].sort(),
    );

    const usage = personalUsageSummarySchema.parse((await getUsage(user.cookie, 'days=90')).json());
    expect(usage.runCount).toBe(3);
  });

  it('hides channel runs and errors from personal runs after channel membership is removed', async () => {
    const agent = await createAgent(app, admin, { track: agentSlugs });
    const agentId = agent.json<{ id: string }>().id;
    const sensitiveError = unique('channel-sensitive-error');
    const privateError = unique('private-run-error');
    const roles = [
      await createRole([['runs.read', 'own_data']]),
      await createRole([['runs.read', 'platform']]),
    ];

    for (const role of roles) {
      const author = await createAccountWithRoles([role]);

      const channelId = newId('channel');
      channelIds.push(channelId);
      await app.pool.query('insert into channels (id, name, created_by) values ($1, $2, $3)', [
        channelId,
        unique('personal-data-channel'),
        ADMIN_BUSINESS_ID,
      ]);
      await app.pool.query(
        `insert into channel_members (channel_id, business_id, role)
         values ($1, $2, 'owner'), ($1, $3, 'member')`,
        [channelId, ADMIN_BUSINESS_ID, author.businessId],
      );

      // 同作者：私聊 run 与频道 run 都由本人发起，频道 run 带不能外泄的错误正文。
      const privateRun = await seedRun({
        agentId,
        businessId: author.businessId,
        status: 'failed',
        error: privateError,
      });
      const channelRun = await seedRun({
        agentId,
        businessId: author.businessId,
        trigger: 'channel',
        channelId,
        status: 'failed',
        error: sensitiveError,
      });

      // 先确认成员关系真实存在，再移除；不是只给 run 挂一个假 channelId。
      const membership = await app.pool.query<{ role: string }>(
        'select role from channel_members where channel_id = $1 and business_id = $2',
        [channelId, author.businessId],
      );
      expect(membership.rows).toEqual([{ role: 'member' }]);
      await app.pool.query(
        'delete from channel_members where channel_id = $1 and business_id = $2',
        [channelId, author.businessId],
      );

      const res = await getRuns(author.cookie, 'days=90');
      expect(res.statusCode, res.body).toBe(200);
      const page = personalRunListSchema.parse(res.json());
      const byId = new Map(page.items.map((item) => [item.id, item]));
      expect(byId.get(privateRun.runId)).toMatchObject({ status: 'failed', error: privateError });
      expect.soft(byId.has(channelRun.runId)).toBe(false);
      expect.soft(res.body).not.toContain(sensitiveError);
    }
  });

  it('aggregates usage cost with recorded-coverage and status totals', async () => {
    const user = await createTestAccount(app, admin, { systemKeys: ['user'] });
    accountIds.push(user.businessId);
    const agent = await createAgent(app, admin, { track: agentSlugs });
    const agentId = agent.json<{ id: string }>().id;
    const now = new Date();
    const seeds: SeedRunInput[] = [
      {
        agentId,
        businessId: user.businessId,
        status: 'succeeded',
        costUsd: '0.0000',
        inputTokens: 10,
        outputTokens: 5,
        createdAt: now,
      },
      {
        agentId,
        businessId: user.businessId,
        status: 'succeeded',
        costUsd: '0.0123',
        inputTokens: 7,
        outputTokens: 3,
        createdAt: now,
      },
      {
        agentId,
        businessId: user.businessId,
        status: 'failed',
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        createdAt: now,
      },
      { agentId, businessId: user.businessId, status: 'queued', costUsd: null, createdAt: now },
      { agentId, businessId: user.businessId, status: 'cancelled', costUsd: null, createdAt: now },
      {
        agentId,
        businessId: user.businessId,
        status: 'timeout',
        costUsd: '1.5000',
        inputTokens: 2,
        outputTokens: 0,
        createdAt: now,
      },
      { agentId, businessId: user.businessId, status: 'running', costUsd: null, createdAt: now },
    ];
    for (const seed of seeds) await seedRun(seed);

    const res = await getUsage(user.cookie, 'days=90');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const summary = personalUsageSummarySchema.parse(res.json());
    expect(summary).toMatchObject({
      days: 90,
      runCount: 7,
      succeeded: 2,
      failed: 1,
      cancelled: 1,
      timeout: 1,
      queued: 1,
      running: 1,
      inputTokens: 19,
      outputTokens: 8,
      costRecordedRuns: 3,
      costMissingRuns: 4,
    });
    expect(Number(summary.costUsd)).toBeCloseTo(1.5123, 4);

    const empty = await createTestAccount(app, admin, { systemKeys: ['user'] });
    accountIds.push(empty.businessId);
    expect(personalUsageSummarySchema.parse((await getUsage(empty.cookie)).json())).toMatchObject({
      runCount: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      timeout: 0,
      queued: 0,
      running: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      costRecordedRuns: 0,
      costMissingRuns: 0,
    });

    const allNull = await createTestAccount(app, admin, { systemKeys: ['user'] });
    accountIds.push(allNull.businessId);
    await seedRun({ agentId, businessId: allNull.businessId, costUsd: null, createdAt: now });
    expect(personalUsageSummarySchema.parse((await getUsage(allNull.cookie)).json())).toMatchObject(
      {
        runCount: 1,
        costUsd: null,
        costRecordedRuns: 0,
        costMissingRuns: 1,
      },
    );

    const zeroCost = await createTestAccount(app, admin, { systemKeys: ['user'] });
    accountIds.push(zeroCost.businessId);
    await seedRun({ agentId, businessId: zeroCost.businessId, costUsd: '0.0000', createdAt: now });
    const zero = personalUsageSummarySchema.parse((await getUsage(zeroCost.cookie)).json());
    expect(zero).toMatchObject({ runCount: 1, costRecordedRuns: 1, costMissingRuns: 0 });
    expect(zero.costUsd).not.toBeNull();
    expect(Number(zero.costUsd)).toBe(0);

    const fullyRecorded = await createTestAccount(app, admin, { systemKeys: ['user'] });
    accountIds.push(fullyRecorded.businessId);
    await seedRun({
      agentId,
      businessId: fullyRecorded.businessId,
      costUsd: '0.0200',
      createdAt: now,
    });
    await seedRun({
      agentId,
      businessId: fullyRecorded.businessId,
      costUsd: '0.0300',
      createdAt: now,
    });
    const full = personalUsageSummarySchema.parse((await getUsage(fullyRecorded.cookie)).json());
    expect(full).toMatchObject({ runCount: 2, costRecordedRuns: 2, costMissingRuns: 0 });
    expect(Number(full.costUsd)).toBeCloseTo(0.05, 4);
  });

  it('uses the UTC window boundary on run creation time', async () => {
    const user = await createTestAccount(app, admin, { systemKeys: ['user'] });
    accountIds.push(user.businessId);
    const agent = await createAgent(app, admin, { track: agentSlugs });
    const agentId = agent.json<{ id: string }>().id;
    const now = new Date();
    const since = utcWindowStart(2, now);
    await seedRun({
      agentId,
      businessId: user.businessId,
      createdAt: new Date(since.getTime() - 1),
    });
    await seedRun({ agentId, businessId: user.businessId, createdAt: since });
    const inside = await seedRun({ agentId, businessId: user.businessId, createdAt: now });

    const page = personalRunListSchema.parse((await getRuns(user.cookie, 'days=2')).json());
    expect(page.items.map((item) => item.id)).toContain(inside.runId);
    expect(page.items).toHaveLength(2);
    expect(
      personalUsageSummarySchema.parse((await getUsage(user.cookie, 'days=2')).json()),
    ).toMatchObject({
      runCount: 2,
    });
  });

  it('filters and paginates runs, rejecting foreign or unknown cursors', async () => {
    const user = await createTestAccount(app, admin, { systemKeys: ['user'] });
    const other = await createTestAccount(app, admin, { systemKeys: ['user'] });
    accountIds.push(user.businessId, other.businessId);
    const agent = await createAgent(app, admin, { track: agentSlugs });
    const agentId = agent.json<{ id: string }>().id;
    const otherAgentId = await seedAgent(other.businessId);

    const stamp = new Date();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const { runId } = await seedRun({ agentId, businessId: user.businessId, createdAt: stamp });
      ids.push(runId);
    }
    await seedRun({
      agentId,
      businessId: user.businessId,
      status: 'failed',
      trigger: 'review',
      createdAt: stamp,
    });
    const foreign = await seedRun({
      agentId: otherAgentId,
      businessId: other.businessId,
      createdAt: stamp,
    });
    await app.pool.query('update agent_runs set created_at = $2 where id = any($1::text[])', [
      ids,
      stamp,
    ]);

    const expected = [...ids].sort((a, b) => b.localeCompare(a));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const query = `days=90&limit=1&trigger=chat&agentId=${encodeURIComponent(agentId)}${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res = await getRuns(user.cookie, query);
      expect(res.statusCode, res.body).toBe(200);
      const page = personalRunListSchema.parse(res.json());
      expect(page.items).toHaveLength(1);
      seen.push(page.items[0]?.id ?? '');
      cursor = page.nextCursor ?? undefined;
    }
    expect(seen).toEqual(expected.slice(0, 3));
    expect(cursor).toBeUndefined();

    expectProblem(
      await getRuns(user.cookie, `days=90&cursor=${encodeURIComponent(foreign.runId)}`),
      'NOT_FOUND',
    );
    expectProblem(
      await getRuns(user.cookie, `days=90&cursor=${encodeURIComponent(unique('missing-run'))}`),
      'NOT_FOUND',
    );

    const filtered = personalRunListSchema.parse(
      (await getRuns(user.cookie, 'days=90&status=failed&trigger=review')).json(),
    );
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]).toMatchObject({ status: 'failed', trigger: 'review' });
  });

  it('lists only own conversation shares and revokes idempotently', async () => {
    const userA = await createTestAccount(app, admin, { systemKeys: ['user'] });
    const userB = await createTestAccount(app, admin, { systemKeys: ['maintainer'] });
    accountIds.push(userA.businessId, userB.businessId);
    const agent = await createAgent(app, admin, { track: agentSlugs });
    const agentId = agent.json<{ id: string }>().id;
    const shareA = await seedShare({ businessId: userA.businessId, agentId });
    const shareB = await seedShare({ businessId: userB.businessId, agentId });

    for (const [cookie, own, foreign] of [
      [userA.cookie, shareA, shareB],
      [userB.cookie, shareB, shareA],
      [admin, null, shareA],
    ] as const) {
      const res = await getShares(cookie);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const page = personalOutputShareListSchema.parse(res.json());
      const ids = page.items.map((item) => item.id);
      if (own === null) {
        expect(ids).not.toContain(foreign.id);
      } else {
        expect(ids).toEqual([own.id]);
        expect(page.items[0]).toMatchObject({
          conversationId: own.conversationId,
          agentId,
          conversationTitle: '我的分享会话',
          revokedAt: null,
          urlPath: `/s/${own.id}#${own.token}`,
        });
      }
    }

    expectProblem(
      await inject(app, {
        method: 'DELETE',
        url: `/api/me/output-shares/${shareB.id}`,
        headers: auth(userA.cookie),
      }),
      'NOT_FOUND',
    );
    expectProblem(await deleteShare(userA.cookie, unique('osh_missing')), 'NOT_FOUND');

    expect((await deleteShare(userA.cookie, shareA.id)).statusCode).toBe(204);
    expect((await deleteShare(userA.cookie, shareA.id)).statusCode).toBe(204);
    const audits = await app.pool.query<{ input_digest: string | null }>(
      'select input_digest from audit_log where target = $1',
      [shareA.id],
    );
    expect(audits.rows).toHaveLength(1);
    expect(JSON.stringify(audits.rows)).not.toContain(shareA.token);
    expect(
      personalOutputShareListSchema.parse((await getShares(userA.cookie)).json()).items,
    ).toHaveLength(0);
    expect(
      personalOutputShareListSchema
        .parse((await getShares(userB.cookie)).json())
        .items.map((item) => item.id),
    ).toEqual([shareB.id]);
  });

  it('invalidates the public share link after the owner revokes it', async () => {
    const user = await createTestAccount(app, admin, { systemKeys: ['user'] });
    accountIds.push(user.businessId);
    const agent = await createAgent(app, admin, { track: agentSlugs });
    const agentRef = agent.json<{ id: string; slug: string }>();
    const content = '# 我的产出\n';
    const conversationId = newId('conversation');
    await app.pool.query(
      'insert into conversations (id, agent_id, created_by, title) values ($1, $2, $3, $4)',
      [conversationId, agentRef.id, user.businessId, '公开撤销会话'],
    );
    const runId = newId('run');
    await app.pool.query(
      `insert into agent_runs (id, conversation_id, agent_id, status, subject_kind, initiated_by)
       values ($1, $2, $3, 'succeeded', 'user', $4)`,
      [runId, conversationId, agentRef.id, user.businessId],
    );
    await publish(agentRef.slug, conversationId, runId, 'report.md', content);

    const token = unique('public-token');
    const shareId = newId('outputShare');
    await app.pool.query(
      `insert into output_shares
         (id, conversation_id, run_id, path, sha256, token_hash, token_encrypted)
       values ($1, $2, $3, 'report.md', $4, $5, $6)`,
      [
        shareId,
        conversationId,
        runId,
        sha256(content),
        sha256(token),
        encryptSecrets({ token }, app.config.APP_SECRET_KEY),
      ],
    );

    const publicUrl = `/api/public/output-shares/${shareId}`;
    const before = await inject(app, {
      method: 'GET',
      url: publicUrl,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode, before.body).toBe(200);

    expect((await deleteShare(user.cookie, shareId)).statusCode).toBe(204);
    const after = await inject(app, {
      method: 'GET',
      url: publicUrl,
      headers: { authorization: `Bearer ${token}` },
    });
    expectProblem(after, 'NOT_FOUND');
    expect(after.body).not.toContain(token);
  });

  it('paginates shares with equal timestamps and rejects foreign cursors', async () => {
    const user = await createTestAccount(app, admin, { systemKeys: ['user'] });
    const other = await createTestAccount(app, admin, { systemKeys: ['user'] });
    accountIds.push(user.businessId, other.businessId);
    const agent = await createAgent(app, admin, { track: agentSlugs });
    const agentId = agent.json<{ id: string }>().id;
    const first = await seedShare({ businessId: user.businessId, agentId, path: 'a.md' });
    const second = await seedShare({ businessId: user.businessId, agentId, path: 'b.md' });
    const foreign = await seedShare({ businessId: other.businessId, agentId, path: 'c.md' });
    const stamp = new Date();
    await app.pool.query('update output_shares set created_at = $2 where id = any($1::text[])', [
      [first.id, second.id],
      stamp,
    ]);

    const pageOne = personalOutputShareListSchema.parse(
      (await getShares(user.cookie, 'limit=1')).json(),
    );
    expect(pageOne.items).toHaveLength(1);
    expect(pageOne.nextCursor).not.toBeNull();
    const pageTwo = personalOutputShareListSchema.parse(
      (
        await getShares(
          user.cookie,
          `limit=1&cursor=${encodeURIComponent(pageOne.nextCursor ?? '')}`,
        )
      ).json(),
    );
    expect(pageTwo.items).toHaveLength(1);
    expect(new Set([pageOne.items[0]?.id, pageTwo.items[0]?.id])).toEqual(
      new Set([first.id, second.id]),
    );

    expectProblem(
      await getShares(user.cookie, `cursor=${encodeURIComponent(foreign.id)}`),
      'NOT_FOUND',
    );
    expectProblem(
      await getShares(user.cookie, `cursor=${encodeURIComponent(unique('missing-share'))}`),
      'NOT_FOUND',
    );
  });

  it('lists only own conversations for the review source picker', async () => {
    const user = await createTestAccount(app, admin, { systemKeys: ['user'] });
    const other = await createTestAccount(app, admin, { systemKeys: ['user'] });
    accountIds.push(user.businessId, other.businessId);
    const agent = await createAgent(app, admin, { track: agentSlugs });
    const agentId = agent.json<{ id: string }>().id;
    const mine = newId('conversation');
    const foreign = newId('conversation');
    await app.pool.query(
      'insert into conversations (id, agent_id, created_by, title) values ($1, $2, $3, $4), ($5, $2, $6, $7)',
      [mine, agentId, user.businessId, '我的会话', foreign, other.businessId, '别人的会话'],
    );

    const res = await getConversations(user.cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const items = res.json<Array<{ id: string; title: string; agentId: string }>>();
    expect(items.map((item) => item.id)).toEqual([mine]);
    expect(items[0]).toMatchObject({ title: '我的会话', agentId });

    const byAgent = await getConversations(
      user.cookie,
      `agentId=${encodeURIComponent(agentId)}&limit=10`,
    );
    expect(byAgent.statusCode, byAgent.body).toBe(200);
    expect(byAgent.json<Array<{ id: string }>>().map((item) => item.id)).toEqual([mine]);
    expect(
      (
        await getConversations(
          user.cookie,
          `agentId=${encodeURIComponent(unique('missing-agent'))}`,
        )
      ).json<unknown[]>(),
    ).toEqual([]);
  });

  it('rejects invalid list inputs before querying', async () => {
    const user = await createTestAccount(app, admin, { systemKeys: ['user'] });
    accountIds.push(user.businessId);
    for (const url of [
      '/api/me/usage?days=0',
      '/api/me/usage?days=91',
      '/api/me/runs?limit=0',
      '/api/me/runs?status=unknown',
      '/api/me/runs?trigger=unknown',
      '/api/me/output-shares?limit=101',
      '/api/me/conversations?limit=201',
    ]) {
      expectProblem(
        await inject(app, { method: 'GET', url, headers: auth(user.cookie) }),
        'INVALID_INPUT',
      );
    }
  });
});
