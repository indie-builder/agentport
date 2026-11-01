import { newId } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAgent,
  createTestAccount,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  seedRun,
  setAgentMember,
  startApp,
  type TestAccount,
} from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('账户与对象范围权限（API 入口）', () => {
  let app: FastifyInstance;
  let admin: string;
  let adminBusinessId: string;
  let agentId: string;
  let secondAgentId: string;
  const userA = {} as TestAccount;
  const userB = {} as TestAccount;
  const maintainer = {} as TestAccount;
  const otherMaintainer = {} as TestAccount;
  let runA: string;
  let conversationA: string;
  let runB: string;
  let conversationB: string;
  let serviceRun: string;

  beforeAll(async () => {
    app = await startApp();
    admin = await loginCookie(app);

    // 建号通过公共账户 API，测试不直接写 auth 表。
    for (const [slot, systemKeys] of [
      [userA, ['user']],
      [userB, ['user']],
      [maintainer, ['maintainer']],
      [otherMaintainer, ['maintainer']],
    ] as const) {
      Object.assign(slot, await createTestAccount(app, admin, { systemKeys }));
    }

    const me = await inject(app, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: admin },
    });
    adminBusinessId = me.json<{ user: { businessId: string } }>().user.businessId;

    const created = await createAgent(app, admin);
    agentId = created.json<{ id: string }>().id;
    const second = await createAgent(app, admin);
    secondAgentId = second.json<{ id: string }>().id;

    // A/B 被授权使用同一个专家；维护人员被授权维护它，另一维护人员只维护另一个专家。
    await setAgentMember(app, admin, agentId, userA.businessId, {
      canUse: true,
      canMaintain: false,
    });
    await setAgentMember(app, admin, agentId, userB.businessId, {
      canUse: true,
      canMaintain: false,
    });
    await setAgentMember(app, admin, agentId, maintainer.businessId, {
      canUse: true,
      canMaintain: true,
    });
    await setAgentMember(app, admin, secondAgentId, otherMaintainer.businessId, {
      canUse: true,
      canMaintain: true,
    });

    ({ runId: runA, conversationId: conversationA } = await seedRun(app, agentId, {
      subject: { kind: 'user', businessId: userA.businessId },
    }));
    ({ runId: runB, conversationId: conversationB } = await seedRun(app, agentId, {
      subject: { kind: 'user', businessId: userB.businessId },
    }));
    ({ runId: serviceRun } = await seedRun(app, agentId, {
      subject: { kind: 'service', serviceId: 'mcp' },
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('每条 /api 路由都有 access 声明，未登录返回 401，公开分享不要求登录', async () => {
    // beforeAll 的 startApp 会在 onRoute 校验缺声明时直接失败。
    expect(app).toBeDefined();
    expectProblem(await inject(app, { method: 'GET', url: '/api/runs' }), 'UNAUTHORIZED');
    const share = await inject(app, { method: 'GET', url: '/api/public/output-shares/missing' });
    expect(share.statusCode).toBe(404);
    expect((await inject(app, { method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });

  it('两个人各自的会话与运行互相不可见，列表按账户过滤', async () => {
    const listA = await inject(app, {
      method: 'GET',
      url: '/api/conversations',
      headers: { cookie: userA.cookie },
    });
    expect(listA.statusCode, listA.body).toBe(200);
    const ids = listA.json<{ id: string }[]>().map((row) => row.id);
    expect(ids).toContain(conversationA);
    expect(ids).not.toContain(conversationB);

    const own = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${conversationA}`,
      headers: { cookie: userA.cookie },
    });
    expect(own.statusCode, own.body).toBe(200);

    expectProblem(
      await inject(app, {
        method: 'GET',
        url: `/api/conversations/${conversationA}`,
        headers: { cookie: userB.cookie },
      }),
      'NOT_FOUND',
    );
    expectProblem(
      await inject(app, {
        method: 'PATCH',
        url: `/api/conversations/${conversationA}`,
        headers: { cookie: userB.cookie },
        payload: { title: 'steal' },
      }),
      'NOT_FOUND',
    );
    expectProblem(
      await inject(app, {
        method: 'DELETE',
        url: `/api/conversations/${conversationA}`,
        headers: { cookie: userB.cookie },
      }),
      'NOT_FOUND',
    );
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: `/api/conversations/${conversationA}/outputs`,
        headers: { cookie: userB.cookie },
      }),
      'NOT_FOUND',
    );
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: `/api/conversations/${conversationA}/attachments/${newId('attachment')}/download`,
        headers: { cookie: userB.cookie },
      }),
      'NOT_FOUND',
    );

    const ownRun = await inject(app, {
      method: 'GET',
      url: `/api/runs/${runA}`,
      headers: { cookie: userA.cookie },
    });
    expect(ownRun.statusCode, ownRun.body).toBe(200);
    for (const path of [
      `/api/runs/${runA}`,
      `/api/runs/${runA}/approvals`,
      `/api/runs/${runA}/questions`,
      `/api/chat/${runA}/events`,
    ]) {
      expectProblem(
        await inject(app, { method: 'GET', url: path, headers: { cookie: userB.cookie } }),
        'NOT_FOUND',
      );
    }
    expectProblem(
      await inject(app, {
        method: 'POST',
        url: `/api/chat/${runA}/cancel`,
        headers: { cookie: userB.cookie },
      }),
      'NOT_FOUND',
    );
    expectProblem(
      await inject(app, {
        method: 'POST',
        url: `/api/runs/${runA}/approve`,
        headers: { cookie: userB.cookie },
        payload: { serverId: 'x', toolName: 'y' },
      }),
      'NOT_FOUND',
    );

    // 维护人员能维护该专家，但不能借此读别人的私有正文。
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: `/api/conversations/${conversationA}`,
        headers: { cookie: maintainer.cookie },
      }),
      'NOT_FOUND',
    );
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: `/api/runs/${runA}`,
        headers: { cookie: maintainer.cookie },
      }),
      'NOT_FOUND',
    );
  });

  it('服务发起的运行只有平台范围可读', async () => {
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: `/api/runs/${serviceRun}`,
        headers: { cookie: userA.cookie },
      }),
      'NOT_FOUND',
    );
    const adminRead = await inject(app, {
      method: 'GET',
      url: `/api/runs/${serviceRun}`,
      headers: { cookie: admin },
    });
    expect(adminRead.statusCode, adminRead.body).toBe(200);

    // 管理员跨用户读取（run 属 A）必须落审计，且不写正文。
    await inject(app, {
      method: 'GET',
      url: `/api/runs/${runA}`,
      headers: { cookie: admin },
    });
    const audit = await app.pool.query<{
      actor: string;
      actor_kind: string;
      subject_business_id: string | null;
    }>(
      `select actor, actor_kind, subject_business_id from audit_log
        where action = 'access.cross_user.runs.read' and target = $1 and actor = $2`,
      [runA, adminBusinessId],
    );
    expect(
      audit.rows.some(
        (row) => row.actor_kind === 'user' && row.subject_business_id === userA.businessId,
      ),
    ).toBe(true);
  });

  it('被授权使用专家才能发起运行，撤权后新运行被拒', async () => {
    const asA = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: userA.cookie },
      payload: { agentId, message: 'hello' },
    });
    expect(asA.statusCode, asA.body).toBe(202);
    const createdConversation = asA.json<{ conversationId: string }>().conversationId;

    // 未获成员授权的维护人员可以维护别的专家，但不能使用这个专家。
    expectProblem(
      await inject(app, {
        method: 'POST',
        url: '/api/chat',
        headers: { cookie: otherMaintainer.cookie },
        payload: { agentId, message: 'hello' },
      }),
      'NOT_FOUND',
    );

    // 撤销 canUse 后，既有会话仍在本人列表里，但不能再发起新运行。
    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/agents/${agentId}/members/${encodeURIComponent(userA.businessId)}`,
      headers: { cookie: admin },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expectProblem(
      await inject(app, {
        method: 'POST',
        url: '/api/chat',
        headers: { cookie: userA.cookie },
        payload: { agentId, conversationId: createdConversation, message: 'again' },
      }),
      'NOT_FOUND',
    );
    // 已准入的私有会话仍按本人 O 可读，不因专家撤权而变成他人可读。
    const stillOwn = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${createdConversation}`,
      headers: { cookie: userA.cookie },
    });
    expect(stillOwn.statusCode, stillOwn.body).toBe(200);
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: `/api/conversations/${createdConversation}`,
        headers: { cookie: userB.cookie },
      }),
      'NOT_FOUND',
    );
  });

  it('评估资料按专家范围隔离：维护人可管理自己维护的专家，看不到别人的', async () => {
    const created = await inject(app, {
      method: 'POST',
      url: '/api/eval/cases',
      headers: { cookie: maintainer.cookie },
      payload: { agentId, name: 'case-maintained', prompt: 'p', expectation: 'ok' },
    });
    expect(created.statusCode, created.body).toBe(201);

    const ownCases = await inject(app, {
      method: 'GET',
      url: `/api/eval/cases?agentId=${encodeURIComponent(agentId)}`,
      headers: { cookie: maintainer.cookie },
    });
    expect(ownCases.statusCode, ownCases.body).toBe(200);
    expect(ownCases.json<Array<{ agentId: string }>>()).toHaveLength(1);

    const otherCases = await inject(app, {
      method: 'GET',
      url: `/api/eval/cases?agentId=${encodeURIComponent(agentId)}`,
      headers: { cookie: otherMaintainer.cookie },
    });
    expect(otherCases.statusCode, otherCases.body).toBe(200);
    expect(otherCases.json<Array<{ agentId: string }>>()).toHaveLength(0);

    // 普通用户没有评估权限：功能级拒绝是 403，而不是空列表。
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: '/api/eval/cases',
        headers: { cookie: userB.cookie },
      }),
      'FORBIDDEN',
    );

    // 负责人之外的人不能删除该用例。
    const cases = ownCases.json<Array<{ id: string }>>();
    const target = cases[0];
    expect(target).toBeDefined();
    expectProblem(
      await inject(app, {
        method: 'DELETE',
        url: `/api/eval/cases/${target?.id}`,
        headers: { cookie: otherMaintainer.cookie },
      }),
      'NOT_FOUND',
    );
  });
});
