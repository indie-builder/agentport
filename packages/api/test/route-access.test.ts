import { type PermissionId, permissionIdSchema } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerKnowledgeContentRoutes } from '../src/features/knowledge/content-routes.js';
import { registerFaqRoutes } from '../src/features/knowledge/faq-routes.js';
import { registerRetrievalEvaluationRoutes } from '../src/features/knowledge/retrieval-evaluation.js';
import { registerKnowledgeRoutes } from '../src/features/knowledge/routes.js';
import { registerSourceRoutes } from '../src/features/knowledge/source-routes.js';
import { registerWikiRoutes } from '../src/features/knowledge/wiki-routes.js';
import { registerAccess } from '../src/plugins/access.js';
import { AppError, registerErrorHandler } from '../src/plugins/errors.js';
import {
  adminCookie,
  cookieOf,
  createAccount,
  createRole,
  expectProblem,
  grants,
  infraReady,
  inject,
  login,
  startAccessApp,
  unique,
} from './access-helpers.js';

const ready = await infraReady;

const PASSWORD = 'test-password-123';

describe('knowledge route access registration', () => {
  it('registers every knowledge route and rejects readers before executing mutations', async () => {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerErrorHandler(app);
    app.decorate('requireAuth', async (request) => {
      if (request.headers.authorization !== 'reader')
        throw new AppError('UNAUTHORIZED', 'not logged in');
      request.principal = {
        kind: 'user',
        authUserId: 'test-auth',
        businessId: 'test-reader',
        username: 'reader',
        name: 'reader',
        roles: [],
        grants: [{ permissionId: 'knowledge.read', scope: 'platform' }],
      };
    });
    registerAccess(app);
    try {
      for (const register of [
        registerKnowledgeRoutes,
        registerKnowledgeContentRoutes,
        registerFaqRoutes,
        registerSourceRoutes,
        registerWikiRoutes,
        registerRetrievalEvaluationRoutes,
      ])
        register(app);
      await app.ready();
      const requests = [
        {
          method: 'POST',
          url: '/api/knowledge/bases/base/retrieval-evaluations',
          payload: {
            cases: [{ q: '查询', expectedTargets: [{ kind: 'document', id: 'document' }] }],
          },
        },
        { method: 'POST', url: '/api/knowledge/bases/base/faqs/test', payload: { q: '查询' } },
        {
          method: 'POST',
          url: '/api/knowledge/documents/document/publish',
          payload: { versionId: 'version', expectedVersionId: null },
        },
        {
          method: 'POST',
          url: '/api/knowledge/faqs/document/publish',
          payload: { versionId: 'version', expectedVersionId: null },
        },
        { method: 'POST', url: '/api/knowledge/sources/source/test' },
        {
          method: 'POST',
          url: '/api/knowledge/bases/base/faqs/batch',
          payload: {
            action: 'publish',
            items: [{ documentId: 'document', versionId: 'version', expectedVersionId: null }],
          },
        },
        {
          method: 'POST',
          url: '/api/knowledge/bases/base/documents/batch',
          payload: { action: 'reprocess', documentIds: ['document'] },
        },
      ] as const;
      for (const request of requests) {
        const denied = await app.inject({ ...request, headers: { authorization: 'reader' } });
        expect(denied.statusCode, denied.body).toBe(403);
        expect(denied.json().code).toBe('FORBIDDEN');
        const anonymous = await app.inject(request);
        expect(anonymous.statusCode, anonymous.body).toBe(401);
      }
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!ready)('route access', () => {
  let app: FastifyInstance;
  let admin: string;
  let userA: { cookie: string; businessId: string; username: string };
  let userM: { cookie: string; businessId: string; username: string };
  let userW: { cookie: string; businessId: string; username: string };
  let userMixed: { cookie: string; businessId: string; username: string };
  let userNone: { cookie: string; businessId: string; username: string };
  let agentA: string;
  let agentB: string;
  let ownerA: string;

  beforeAll(async () => {
    app = await startAccessApp({}, (instance) => {
      instance.post(
        '/api/test/authorize',
        {
          config: { access: { kind: 'authenticated' } },
          schema: {
            body: z.object({
              permissionId: permissionIdSchema,
              objectId: z.string().optional(),
              agentId: z.string().optional(),
              createdBy: z.string().nullable().optional(),
              privateContent: z.boolean().optional(),
            }),
          },
        },
        async (request) => {
          const body = request.body as {
            permissionId: PermissionId;
            objectId?: string;
            agentId?: string;
            createdBy?: string | null;
            privateContent?: boolean;
          };
          const resource =
            body.objectId === undefined &&
            body.agentId === undefined &&
            body.createdBy === undefined &&
            body.privateContent === undefined
              ? undefined
              : {
                  ...(body.objectId === undefined ? {} : { objectId: body.objectId }),
                  ...(body.agentId === undefined ? {} : { agentId: body.agentId }),
                  ...(body.createdBy === undefined ? {} : { createdBy: body.createdBy }),
                  ...(body.privateContent === undefined
                    ? {}
                    : { privateContent: body.privateContent }),
                };
          await instance.authorize(request, body.permissionId, resource);
          return { ok: true };
        },
      );

      instance.get(
        '/api/test/permission',
        { config: { access: { kind: 'permission', permissionId: 'accounts.read' } } },
        async () => ({ ok: true }),
      );

      instance.get(
        '/api/test/public',
        { config: { access: { kind: 'public', reason: 'test' } } },
        async () => ({ ok: true }),
      );

      instance.get(
        '/api/test/authenticated',
        { config: { access: { kind: 'authenticated' } } },
        async (request) => {
          const principal = request.principal;
          return {
            businessId: principal?.kind === 'user' ? principal.businessId : null,
          };
        },
      );

      instance.get(
        '/api/test/agent-access/:id',
        {
          config: { access: { kind: 'authenticated' } },
          schema: { params: z.object({ id: z.string() }) },
        },
        async (request) => instance.agentAccess(request, (request.params as { id: string }).id),
      );

      instance.get(
        '/api/test/service',
        { config: { access: { kind: 'public', reason: 'service test' } } },
        async (request, reply) => {
          request.principal = { kind: 'service', serviceId: 'mcp' };
          await instance.requirePermission('accounts.read')(request, reply);
          return { ok: true };
        },
      );
    });

    admin = await adminCookie(app);

    const roleA = await createRole(
      app,
      admin,
      unique('role-a'),
      grants(
        ['agents.read', 'authorized_agents'],
        ['agents.use', 'authorized_agents'],
        ['agents.create', 'own_data'],
        ['runs.read', 'own_data'],
      ),
    );
    const roleM = await createRole(
      app,
      admin,
      unique('role-m'),
      grants(['agents.read', 'maintained_agents'], ['agents.config.read', 'maintained_agents']),
    );
    const roleW = await createRole(
      app,
      admin,
      unique('role-w'),
      grants(['agents.read', 'owned_agents'], ['agents.use', 'owned_agents']),
    );
    const roleNone = await createRole(
      app,
      admin,
      unique('role-none'),
      grants(['overview.read', 'own_data']),
    );

    const makeUser = async (roleIds: string[]) => {
      const created = await createAccount(app, admin, { roleIds, password: PASSWORD });
      expect(created.statusCode, created.body).toBe(201);
      const signIn = await login(app, created.account.username, PASSWORD);
      expect(signIn.statusCode, signIn.body).toBe(200);
      return {
        cookie: cookieOf(signIn),
        businessId: created.account.businessId,
        username: created.account.username,
      };
    };

    userA = await makeUser([roleA.id]);
    userM = await makeUser([roleM.id]);
    userW = await makeUser([roleW.id]);
    userMixed = await makeUser([roleA.id, roleM.id]);
    userNone = await makeUser([roleNone.id]);

    ownerA = unique('owner-a');
    const ownerB = unique('owner-b');
    agentA = unique('agent-a');
    agentB = unique('agent-b');
    await app.pool.query(
      `insert into agents (id, slug, name, model, created_by, owner_business_id)
       values ($1, $1, $1, 'test-model', $2, $2), ($3, $3, $3, 'test-model', $4, $4)`,
      [agentA, ownerA, agentB, ownerB],
    );
    await app.pool.query(
      `insert into agent_members (agent_id, business_id, can_use, can_maintain)
       values
         ($1, $2, true, false),
         ($1, $3, false, true),
         ($1, $5, true, false),
         ($4, $2, false, true),
         ($4, $3, true, false),
         ($4, $5, false, true)`,
      [agentA, userA.businessId, userM.businessId, agentB, userMixed.businessId],
    );
  });

  afterAll(async () => {
    await app.close();
  });

  const authorize = (cookie: string, payload: Record<string, unknown>) =>
    inject(app, {
      method: 'POST',
      url: '/api/test/authorize',
      headers: { cookie },
      payload,
    });

  it('fails registration when an /api route omits config.access', () => {
    const bare = Fastify();
    bare.setValidatorCompiler(validatorCompiler);
    bare.setSerializerCompiler(serializerCompiler);
    registerErrorHandler(bare);
    registerAccess(bare);
    expect(() => bare.get('/api/undeclared', async () => ({ ok: true }))).toThrow(
      /missing config.access/,
    );
    expect(() => bare.get('/public/undeclared', async () => ({ ok: true }))).not.toThrow();
  });

  it('auto-wires public, authenticated and permission routes', async () => {
    expect((await inject(app, { method: 'GET', url: '/api/test/public' })).statusCode).toBe(200);

    expectProblem(
      await inject(app, { method: 'GET', url: '/api/test/authenticated' }),
      'UNAUTHORIZED',
    );
    const authed = await inject(app, {
      method: 'GET',
      url: '/api/test/authenticated',
      headers: { cookie: admin },
    });
    expect(authed.json()).toEqual({ businessId: 'bootstrap-admin' });

    expectProblem(
      await inject(app, { method: 'GET', url: '/api/test/permission' }),
      'UNAUTHORIZED',
    );
    expect(
      (
        await inject(app, {
          method: 'GET',
          url: '/api/test/permission',
          headers: { cookie: admin },
        })
      ).statusCode,
    ).toBe(200);
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: '/api/test/permission',
        headers: { cookie: userNone.cookie },
      }),
      'FORBIDDEN',
    );
  });

  it('rejects service principals on user permission checks', async () => {
    const res = await inject(app, { method: 'GET', url: '/api/test/service' });
    expectProblem(res, 'FORBIDDEN');
  });

  it('requires platform scope for global leaves and allows own-scope creation', async () => {
    expect((await authorize(userA.cookie, { permissionId: 'agents.create' })).statusCode).toBe(200);
    expectProblem(await authorize(userM.cookie, { permissionId: 'agents.create' }), 'FORBIDDEN');
    expectProblem(await authorize(userNone.cookie, { permissionId: 'servers.read' }), 'FORBIDDEN');
    expect((await authorize(admin, { permissionId: 'servers.read' })).statusCode).toBe(200);
  });

  it('enforces one grant scope against the real agent relation', async () => {
    expect(
      (await authorize(userA.cookie, { permissionId: 'agents.read', agentId: agentA })).statusCode,
    ).toBe(200);
    expectProblem(
      await authorize(userA.cookie, { permissionId: 'agents.read', agentId: agentB }),
      'NOT_FOUND',
    );
    expect(
      (await authorize(userM.cookie, { permissionId: 'agents.read', agentId: agentA })).statusCode,
    ).toBe(200);
    expectProblem(
      await authorize(userM.cookie, { permissionId: 'agents.read', agentId: agentB }),
      'NOT_FOUND',
    );
    expectProblem(
      await authorize(userW.cookie, { permissionId: 'agents.read', agentId: agentA }),
      'NOT_FOUND',
    );
    expectProblem(
      await authorize(userNone.cookie, { permissionId: 'agents.read', agentId: agentA }),
      'FORBIDDEN',
    );
    expectProblem(
      await authorize(admin, { permissionId: 'agents.read', agentId: unique('missing') }),
      'NOT_FOUND',
    );
  });

  it('does not merge another role capability with a different scope', async () => {
    // roleA 只给 agents.use/A；roleM 只给 agents.read 与 config.read 的 M。
    expect(
      (await authorize(userMixed.cookie, { permissionId: 'agents.use', agentId: agentA }))
        .statusCode,
    ).toBe(200);
    // agentB 可维护但不可使用：M 属于 agents.read，不能拼给 agents.use。
    expectProblem(
      await authorize(userMixed.cookie, { permissionId: 'agents.use', agentId: agentB }),
      'NOT_FOUND',
    );
    expect(
      (await authorize(userMixed.cookie, { permissionId: 'agents.read', agentId: agentB }))
        .statusCode,
    ).toBe(200);
    expectProblem(
      await authorize(userMixed.cookie, {
        permissionId: 'agents.config.read',
        agentId: agentA,
      }),
      'NOT_FOUND',
    );
    expect(
      (await authorize(userMixed.cookie, { permissionId: 'agents.config.read', agentId: agentB }))
        .statusCode,
    ).toBe(200);
  });

  it('keeps private content to owner or platform only', async () => {
    expect(
      (
        await authorize(userA.cookie, {
          permissionId: 'runs.read',
          createdBy: userA.businessId,
          privateContent: true,
        })
      ).statusCode,
    ).toBe(200);
    expectProblem(
      await authorize(userA.cookie, {
        permissionId: 'runs.read',
        createdBy: userM.businessId,
        privateContent: true,
      }),
      'NOT_FOUND',
    );
    // A 范围不能旁路私人正文。
    expectProblem(
      await authorize(userA.cookie, {
        permissionId: 'agents.read',
        agentId: agentA,
        createdBy: userM.businessId,
        privateContent: true,
      }),
      'NOT_FOUND',
    );
    const privateRunId = unique('run-private');
    expect(
      (
        await authorize(admin, {
          permissionId: 'runs.read',
          objectId: privateRunId,
          createdBy: userA.businessId,
          privateContent: true,
        })
      ).statusCode,
    ).toBe(200);

    const audit = await app.pool.query(
      `select actor, target from audit_log
        where action = 'access.cross_user.runs.read' and target = $1`,
      [privateRunId],
    );
    expect(audit.rows.some((row) => row.actor === 'bootstrap-admin')).toBe(true);
  });

  it('audits each private object by real id, owner and user actor', async () => {
    const runIds = [unique('run-1'), unique('run-2')];
    for (const runId of runIds) {
      const res = await authorize(admin, {
        permissionId: 'runs.read',
        objectId: runId,
        createdBy: userA.businessId,
        privateContent: true,
      });
      expect(res.statusCode, res.body).toBe(200);
    }

    const audit = await app.pool.query<{
      actor: string;
      actor_kind: string;
      subject_business_id: string | null;
      target: string | null;
    }>(
      `select actor, actor_kind, subject_business_id, target from audit_log
        where action = 'access.cross_user.runs.read' and target = any($1::text[])`,
      [runIds],
    );
    expect(audit.rows.map((row) => row.target).sort()).toEqual([...runIds].sort());
    for (const row of audit.rows) {
      expect(row.actor).toBe('bootstrap-admin');
      expect(row.actor_kind).toBe('user');
      expect(row.subject_business_id).toBe(userA.businessId);
    }
  });

  it('audits platform access to another user agent', async () => {
    expect(
      (await authorize(admin, { permissionId: 'agents.read', agentId: agentA })).statusCode,
    ).toBe(200);
    const audit = await app.pool.query<{
      actor: string;
      actor_kind: string;
      subject_business_id: string | null;
    }>(
      `select actor, actor_kind, subject_business_id from audit_log
        where action = 'access.cross_user.agents.read' and target = $1`,
      [agentA],
    );
    expect(
      audit.rows.some(
        (row) =>
          row.actor === 'bootstrap-admin' &&
          row.actor_kind === 'user' &&
          row.subject_business_id === ownerA,
      ),
    ).toBe(true);
  });

  it('evaluates the permission id set for one agent object', async () => {
    const adminAccess = await inject(app, {
      method: 'GET',
      url: `/api/test/agent-access/${encodeURIComponent(agentA)}`,
      headers: { cookie: admin },
    });
    expect(adminAccess.statusCode, adminAccess.body).toBe(200);
    const adminIds = adminAccess.json<{ permissionIds: string[] }>().permissionIds;
    expect(adminIds).toContain('agents.read');
    expect(adminIds).toContain('agents.transfer');
    expect(adminIds).not.toContain('accounts.read');

    const aAccess = await inject(app, {
      method: 'GET',
      url: `/api/test/agent-access/${encodeURIComponent(agentA)}`,
      headers: { cookie: userA.cookie },
    });
    const aIds = aAccess.json<{ permissionIds: string[] }>().permissionIds;
    expect(aIds).toEqual(expect.arrayContaining(['agents.read', 'agents.use']));
    expect(aIds).not.toContain('agents.config.read');

    const unavailable = await inject(app, {
      method: 'GET',
      url: `/api/test/agent-access/${encodeURIComponent(agentB)}`,
      headers: { cookie: userA.cookie },
    });
    expect(unavailable.json<{ permissionIds: string[] }>().permissionIds).toEqual([]);

    expectProblem(
      await inject(app, {
        method: 'GET',
        url: `/api/test/agent-access/${encodeURIComponent(unique('missing'))}`,
        headers: { cookie: admin },
      }),
      'NOT_FOUND',
    );
  });
});
