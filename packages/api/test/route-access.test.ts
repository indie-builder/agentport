import { contractProcedure } from '@agentport/contract/base';
import { type PermissionId, permissionIdSchema } from '@agentport/shared';
import { oc } from '@orpc/contract';
import { implement } from '@orpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { agentAccess, authorize, requirePermission } from '../src/http/access.js';
import type { RequestContext } from '../src/http/context.js';
import { createOpenAPIHandler } from '../src/http/orpc.js';
import {
  adminCookie,
  cookieOf,
  createAccount,
  createRole,
  expectProblem,
  grants,
  infraReady,
  login,
  request,
  startAccessApp,
  type TestApp,
  unique,
} from './access-helpers.js';
import { contextApp } from './hono-app.js';

const ready = await infraReady;

const PASSWORD = 'test-password-123';

const authorizeBody = z.object({
  permissionId: permissionIdSchema,
  objectId: z.string().optional(),
  agentId: z.string().optional(),
  createdBy: z.string().nullable().optional(),
  privateContent: z.boolean().optional(),
});

const testContract = {
  authorize: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'POST', path: '/test/authorize' })
    .input(z.object({ body: authorizeBody })),
  permission: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'accounts.read' } })
    .route({ method: 'GET', path: '/test/permission' })
    .input(z.object({})),
  public: contractProcedure
    .meta({ access: { kind: 'public', reason: 'test' } })
    .route({ method: 'GET', path: '/test/public' })
    .input(z.object({})),
  authenticated: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/test/authenticated' })
    .input(z.object({})),
  agentAccess: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/test/agent-access/{id}' })
    .input(z.object({ params: z.object({ id: z.string() }) })),
  service: contractProcedure
    .meta({ access: { kind: 'public', reason: 'service test' } })
    .route({ method: 'GET', path: '/test/service' })
    .input(z.object({})),
};

const os = implement(testContract).$context<RequestContext>();

const testRouter = os.router({
  authorize: os.authorize.handler(async ({ context, input }) => {
    const body = input.body;
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
            ...(body.privateContent === undefined ? {} : { privateContent: body.privateContent }),
          };
    await authorize(context, body.permissionId, resource);
    return { ok: true };
  }),
  permission: os.permission.handler(() => ({ ok: true })),
  public: os.public.handler(() => ({ ok: true })),
  authenticated: os.authenticated.handler(({ context }) => ({
    businessId: context.principal?.kind === 'user' ? context.principal.businessId : null,
  })),
  agentAccess: os.agentAccess.handler(({ context, input }) =>
    agentAccess(context, input.params.id),
  ),
  service: os.service.handler(async ({ context }) => {
    context.principal = { kind: 'service', serviceId: 'mcp' };
    await requirePermission(context, 'accounts.read');
    return { ok: true };
  }),
});

function buildTestApp(runtime: TestApp, router: unknown): TestApp {
  const app = contextApp(runtime);
  const handler = createOpenAPIHandler(router as Parameters<typeof createOpenAPIHandler>[0]);
  app.all('/api/*', async (c) => {
    const result = await handler.handle(c.req.raw, {
      prefix: '/api',
      context: c.get('context'),
    });
    return result.matched ? result.response : c.notFound();
  });
  return { ...runtime, app };
}

describe.skipIf(!ready)('route access', () => {
  let runtime: TestApp;
  let app: TestApp;
  let admin: string;
  let userA: { cookie: string; businessId: string; username: string };
  let userM: { cookie: string; businessId: string; username: string };
  let userW: { cookie: string; businessId: string; username: string };
  let userMixed: { cookie: string; businessId: string; username: string };
  let userNone: { cookie: string; businessId: string; username: string };
  let userReader: { cookie: string; businessId: string; username: string };
  let agentA: string;
  let agentB: string;
  let ownerA: string;

  beforeAll(async () => {
    runtime = await startAccessApp();
    app = buildTestApp(runtime, testRouter);

    admin = await adminCookie(runtime);

    const roleA = await createRole(
      runtime,
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
      runtime,
      admin,
      unique('role-m'),
      grants(['agents.read', 'maintained_agents'], ['agents.config.read', 'maintained_agents']),
    );
    const roleW = await createRole(
      runtime,
      admin,
      unique('role-w'),
      grants(['agents.read', 'owned_agents'], ['agents.use', 'owned_agents']),
    );
    const roleNone = await createRole(
      runtime,
      admin,
      unique('role-none'),
      grants(['overview.read', 'own_data']),
    );
    const roleReader = await createRole(
      runtime,
      admin,
      unique('role-reader'),
      grants(['knowledge.read', 'platform']),
    );

    const makeUser = async (roleIds: string[]) => {
      const created = await createAccount(runtime, admin, { roleIds, password: PASSWORD });
      expect(created.statusCode, created.body).toBe(201);
      const signIn = await login(runtime, created.account.username, PASSWORD);
      expect(signIn.statusCode, signIn.body).toBe(200);
      return {
        businessId: created.account.businessId,
        username: created.account.username,
        cookie: cookieOf(signIn),
      };
    };

    userA = await makeUser([roleA.id]);
    userM = await makeUser([roleM.id]);
    userW = await makeUser([roleW.id]);
    userMixed = await makeUser([roleA.id, roleM.id]);
    userNone = await makeUser([roleNone.id]);
    userReader = await makeUser([roleReader.id]);

    ownerA = unique('owner-a');
    const ownerB = unique('owner-b');
    agentA = unique('agent-a');
    agentB = unique('agent-b');
    await runtime.client.unsafe(
      `insert into agents (id, slug, name, model, created_by, owner_business_id)
       values ($1, $1, $1, 'test-model', $2, $2), ($3, $3, $3, 'test-model', $4, $4)`,
      [agentA, ownerA, agentB, ownerB],
    );
    await runtime.client.unsafe(
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
    if (runtime) await runtime.close();
  });

  const authorize = (cookie: string, payload: Record<string, unknown>) =>
    request(app, {
      method: 'POST',
      url: '/api/test/authorize',
      headers: { cookie },
      payload,
    });

  it('rejects a procedure without explicit access metadata instead of running it', async () => {
    let reached = false;
    const bare = oc.route({ method: 'GET', path: '/undeclared' }).input(z.object({}));
    const bareRouter = implement({ undeclared: bare } as never)
      .$context<RequestContext>()
      .router({
        undeclared: () => {
          reached = true;
          return { ok: true };
        },
      } as never);
    let rejected = false;
    try {
      const bareApp = buildTestApp(runtime, bareRouter);
      const res = await request(bareApp, { method: 'GET', url: '/api/undeclared' });
      rejected = res.statusCode === 500;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(reached).toBe(false);
  });

  it('auto-wires public, authenticated and permission routes', async () => {
    expect((await request(app, { method: 'GET', url: '/api/test/public' })).statusCode).toBe(200);

    expectProblem(
      await request(app, { method: 'GET', url: '/api/test/authenticated' }),
      'UNAUTHORIZED',
    );
    const authed = await request(app, {
      method: 'GET',
      url: '/api/test/authenticated',
      headers: { cookie: admin },
    });
    expect(authed.json()).toEqual({ businessId: 'bootstrap-admin' });

    expectProblem(
      await request(app, { method: 'GET', url: '/api/test/permission' }),
      'UNAUTHORIZED',
    );
    expect(
      (
        await request(app, {
          method: 'GET',
          url: '/api/test/permission',
          headers: { cookie: admin },
        })
      ).statusCode,
    ).toBe(200);
    expectProblem(
      await request(app, {
        method: 'GET',
        url: '/api/test/permission',
        headers: { cookie: userNone.cookie },
      }),
      'FORBIDDEN',
    );
  });

  it('rejects service principals on user permission checks', async () => {
    const res = await request(app, { method: 'GET', url: '/api/test/service' });
    expectProblem(res, 'FORBIDDEN');
  });

  it('rejects knowledge mutations before executing them', async () => {
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
    for (const entry of requests) {
      const denied = await request(runtime, {
        ...entry,
        headers: { cookie: userReader.cookie },
      });
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json<{ code: string }>().code).toBe('FORBIDDEN');
      const anonymous = await request(runtime, entry);
      expect(anonymous.statusCode, anonymous.body).toBe(401);
    }
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
    expect(
      (await authorize(userMixed.cookie, { permissionId: 'agents.use', agentId: agentA }))
        .statusCode,
    ).toBe(200);
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

    const audit = await runtime.client.unsafe(
      `select actor, target from audit_log
        where action = 'access.cross_user.runs.read' and target = $1`,
      [privateRunId],
    );
    expect(audit.some((row) => row.actor === 'bootstrap-admin')).toBe(true);
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

    const audit = await runtime.client.unsafe<{
      actor: string;
      actor_kind: string;
      subject_business_id: string | null;
      target: string | null;
    }[]>(
      `select actor, actor_kind, subject_business_id, target from audit_log
        where action = 'access.cross_user.runs.read' and target = any($1::text[])`, [runtime.client.array(runIds, 'TEXT')],
    );
    expect(audit.map((row) => row.target).sort()).toEqual([...runIds].sort());
    for (const row of audit) {
      expect(row.actor).toBe('bootstrap-admin');
      expect(row.actor_kind).toBe('user');
      expect(row.subject_business_id).toBe(userA.businessId);
    }
  });

  it('audits platform access to another user agent', async () => {
    expect(
      (await authorize(admin, { permissionId: 'agents.read', agentId: agentA })).statusCode,
    ).toBe(200);
    const audit = await runtime.client.unsafe<{
      actor: string;
      actor_kind: string;
      subject_business_id: string | null;
    }[]>(
      `select actor, actor_kind, subject_business_id from audit_log
        where action = 'access.cross_user.agents.read' and target = $1`,
      [agentA],
    );
    expect(
      audit.some(
        (row) =>
          row.actor === 'bootstrap-admin' &&
          row.actor_kind === 'user' &&
          row.subject_business_id === ownerA,
      ),
    ).toBe(true);
  });

  it('evaluates the permission id set for one agent object', async () => {
    const adminAccess = await request(app, {
      method: 'GET',
      url: `/api/test/agent-access/${encodeURIComponent(agentA)}`,
      headers: { cookie: admin },
    });
    expect(adminAccess.statusCode, adminAccess.body).toBe(200);
    const adminIds = adminAccess.json<{ permissionIds: PermissionId[] }>().permissionIds;
    expect(adminIds).toContain('agents.read');
    expect(adminIds).toContain('agents.transfer');
    expect(adminIds).not.toContain('accounts.read');

    const aAccess = await request(app, {
      method: 'GET',
      url: `/api/test/agent-access/${encodeURIComponent(agentA)}`,
      headers: { cookie: userA.cookie },
    });
    const aIds = aAccess.json<{ permissionIds: string[] }>().permissionIds;
    expect(aIds).toEqual(expect.arrayContaining(['agents.read', 'agents.use']));
    expect(aIds).not.toContain('agents.config.read');

    const unavailable = await request(app, {
      method: 'GET',
      url: `/api/test/agent-access/${encodeURIComponent(agentB)}`,
      headers: { cookie: userA.cookie },
    });
    expect(unavailable.json<{ permissionIds: string[] }>().permissionIds).toEqual([]);

    expectProblem(
      await request(app, {
        method: 'GET',
        url: `/api/test/agent-access/${encodeURIComponent(unique('missing'))}`,
        headers: { cookie: admin },
      }),
      'NOT_FOUND',
    );
  });
});
