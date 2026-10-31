import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb, newId, repo } from '@agentport/db';
import type { Agent } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startRedisContainer, stopRedisContainer } from '../../worker/test/global-setup.js';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import {
  ADMIN_BUSINESS_ID,
  cleanup,
  createAgent,
  createTestAccount,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
  waitFor,
} from './helpers.js';
import { FakeSessionCloser, startSessionCleanupResponder } from './session-cleanup-responder.js';

const ready = await infraReady;

/**
 * Redis Pub/Sub 不按库隔离，默认信道会被同轮其它 API 套件注册的处理器应答。
 * 故障用例必须独占实例，才能证明「worker 不在线/迟迟不 ACK」时真的 503。
 */
const isolated = ready ? await startRedisContainer() : null;
const REDIS_URL = isolated?.url ?? 'redis://127.0.0.1:1/8';

/**
 * 删除生命周期的路由级验收：真实 Fastify → 删除事务 → Redis 关闭请求 → worker 信道 ACK
 * → DB 删除 → 目录回收。Docker 容器销毁语义由 worker 的会话测试覆盖，这里用可控
 * `closeIdle` 观察顺序、失败与锁内准入。
 */
describe.skipIf(!isolated)('delete lifecycle over HTTP', () => {
  let app: FastifyInstance;
  let cookie: string;
  let responder: Awaited<ReturnType<typeof startSessionCleanupResponder>> | undefined;
  let sessions: FakeSessionCloser;
  const agentSlugs: string[] = [];
  const personalOwners: string[] = [];

  beforeAll(async () => {
    app = await startApp({ REDIS_URL });
    cookie = await loginCookie(app);
  });

  afterEach(async () => {
    await responder?.close();
    responder = undefined;
    if (sessions !== undefined) sessions.hold = null;
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs });
    for (const slug of agentSlugs) {
      await rm(join(app.config.WORKSPACES_DIR, slug), { recursive: true, force: true });
    }
    for (const businessId of personalOwners) {
      await rm(join(app.config.WORKSPACES_DIR, '_users', hash(businessId)), {
        recursive: true,
        force: true,
      });
    }
    await app.close();
    await stopRedisContainer(isolated);
  });

  const auth = () => ({ cookie });

  async function startResponder(): Promise<FakeSessionCloser> {
    sessions = new FakeSessionCloser();
    responder = await startSessionCleanupResponder(app, sessions);
    return sessions;
  }

  async function newAgent(prefix: string, subAgentIds?: string[]): Promise<Agent> {
    return (
      await createAgent(app, cookie, {
        slug: unique(prefix),
        track: agentSlugs,
        ...(subAgentIds === undefined ? {} : { subAgentIds }),
      })
    ).json<Agent>();
  }

  async function newConversation(
    agentId: string,
    title = '待删除',
    createdBy = ADMIN_BUSINESS_ID,
  ): Promise<string> {
    const id = newId('conversation');
    await repo.chat.createConversation(app.db, {
      id,
      agentId,
      title,
      subject: { kind: 'user', businessId: createdBy },
    });
    return id;
  }

  async function completedRun(
    agentId: string,
    conversationId: string,
    sandboxId: string,
  ): Promise<void> {
    const run = await repo.chat.createRun(app.db, {
      id: newId('run'),
      conversationId,
      agentId,
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
    });
    await repo.chat.updateRun(app.db, run.id, {
      status: 'succeeded',
      endedAt: new Date(),
      sandboxId,
    });
  }

  async function queuedRun(agentId: string, conversationId: string): Promise<void> {
    await repo.chat.createRun(app.db, {
      id: newId('run'),
      conversationId,
      agentId,
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
    });
  }

  function workspace(...parts: string[]): string {
    return join(app.config.WORKSPACES_DIR, ...parts);
  }

  async function makeDir(path: string, file = 'kept'): Promise<void> {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'MEMORY.md'), file);
  }

  function hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  const exists = (path: string) => stat(path).catch(() => null);

  /**
   * 用删除会话持有的 session advisory lock 精确找到删除连接，不靠猜连接顺序。
   * pg_locks 是集群级视图：必须限定当前数据库，并只取空闲且无事务的 session 锁，
   * 否则会选中 Docker 另库或同库其它测试的 xact lock。
   */
  async function deletingBackendPid(): Promise<number | null> {
    const result = await app.pool.query<{ pid: number }>(
      `select l.pid from pg_locks l
         join pg_stat_activity a on a.pid = l.pid
       where l.locktype = 'advisory' and l.granted
         and l.database = (select oid from pg_database where datname = current_database())
         and a.datid = l.database
         and a.state = 'idle' and a.xact_start is null
         and l.objid::bigint = (hashtext($1)::bigint & 4294967295)
         and l.classid::bigint = ((hashtext($1)::bigint >> 32) & 4294967295)
       limit 1`,
      [repo.locks.AGENT_BINDINGS_LOCK_KEY],
    );
    return result.rows[0]?.pid ?? null;
  }

  async function backendActivity(pid: number) {
    const result = await app.pool.query<{ state: string | null; xact_start: Date | null }>(
      `select state, xact_start from pg_stat_activity
        where pid = $1
          and datid = (select oid from pg_database where datname = current_database())`,
      [pid],
    );
    return result.rows[0];
  }

  /** 只终止当前数据库的连接；返回后端是否真的被终止。 */
  async function terminateBackend(pid: number): Promise<boolean> {
    const result = await app.pool.query<{ terminated: boolean }>(
      `select pg_terminate_backend(pid) as terminated from pg_stat_activity
        where pid = $1
          and datid = (select oid from pg_database where datname = current_database())`,
      [pid],
    );
    return result.rows[0]?.terminated === true;
  }

  const deleteConversation = (conversationId: string) =>
    inject(app, {
      method: 'DELETE',
      url: `/api/conversations/${conversationId}`,
      headers: auth(),
    });

  const deleteAgent = (agentId: string) =>
    inject(app, { method: 'DELETE', url: `/api/agents/${agentId}`, headers: auth() });

  it('removes the session sandbox only after the worker confirms, leaving other sessions intact', async () => {
    const agent = await newAgent('lifecycle-conv');
    const conversationId = await newConversation(agent.id);
    const keptId = await newConversation(agent.id, '保留');
    await completedRun(agent.id, conversationId, 'sandbox-delete');
    const targetDir = workspace(agent.slug, 'session-sandboxes', conversationId);
    const keptDir = workspace(agent.slug, 'session-sandboxes', keptId);
    await mkdir(join(targetDir, 'workspace'), { recursive: true });
    await mkdir(join(keptDir, 'workspace'), { recursive: true });
    await makeDir(workspace(agent.slug, 'agent-memory'));

    const fake = await startResponder();
    let release!: () => void;
    fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    let settled = false;
    const deletion = deleteConversation(conversationId).then((response) => {
      settled = true;
      return response;
    });
    expect(await waitFor(() => fake.calls.length === 1)).toBe(true);
    expect(fake.calls[0]).toEqual({
      conversationId,
      sandboxIds: ['sandbox-delete'],
    });
    // ACK 未回之前既不返回 204，也不能先删目录。
    await delay(100);
    expect(settled).toBe(false);
    expect(await exists(targetDir)).not.toBeNull();

    release();
    const response = await deletion;
    expect(response.statusCode, response.body).toBe(204);
    expect(await repo.chat.getConversation(app.db, conversationId)).toBeNull();
    expect(await exists(targetDir)).toBeNull();
    expect(await exists(keptDir)).not.toBeNull();
    // 记忆不属于删除范围。
    expect(await exists(workspace(agent.slug, 'agent-memory'))).not.toBeNull();
  });

  it('returns a retryable 503 and keeps the row and directory when container destruction fails', async () => {
    const agent = await newAgent('lifecycle-fail');
    const conversationId = await newConversation(agent.id);
    await completedRun(agent.id, conversationId, 'sandbox-fail');
    const targetDir = workspace(agent.slug, 'session-sandboxes', conversationId);
    await mkdir(targetDir, { recursive: true });

    const fake = await startResponder();
    fake.failures.set(conversationId, new Error('injected destroy failure'));

    const failed = await deleteConversation(conversationId);
    const problem = expectProblem(failed, 'SERVICE_UNAVAILABLE');
    expect(problem.retryable).toBe(true);
    expect(await repo.chat.getConversation(app.db, conversationId)).not.toBeNull();
    expect(await exists(targetDir)).not.toBeNull();

    fake.failures.clear();
    fake.calls.length = 0;
    const retried = await deleteConversation(conversationId);
    expect(retried.statusCode, retried.body).toBe(204);
    expect(fake.calls).toEqual([{ conversationId, sandboxIds: ['sandbox-fail'] }]);
    expect(await repo.chat.getConversation(app.db, conversationId)).toBeNull();
    expect(await exists(targetDir)).toBeNull();
  });

  it('does not delete when no worker answers the close request', async () => {
    const agent = await newAgent('lifecycle-offline');
    const conversationId = await newConversation(agent.id);
    await completedRun(agent.id, conversationId, 'sandbox-offline');
    const targetDir = workspace(agent.slug, 'session-sandboxes', conversationId);
    await mkdir(targetDir, { recursive: true });

    // 不启动 responder：模拟 worker 不在线，消息发出不等于确认。
    const failed = await deleteConversation(conversationId);
    const problem = expectProblem(failed, 'SERVICE_UNAVAILABLE');
    expect(problem.retryable).toBe(true);
    expect(await repo.chat.getConversation(app.db, conversationId)).not.toBeNull();
    expect(await exists(targetDir)).not.toBeNull();
  });

  it('does not delete when a live worker never acknowledges before the budget', async () => {
    const agent = await newAgent('lifecycle-timeout');
    const conversationId = await newConversation(agent.id);
    await completedRun(agent.id, conversationId, 'sandbox-timeout');
    const targetDir = workspace(agent.slug, 'session-sandboxes', conversationId);
    await mkdir(targetDir, { recursive: true });

    const fake = await startResponder();
    let release!: () => void;
    fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const failed = await deleteConversation(conversationId);
      expectProblem(failed, 'SERVICE_UNAVAILABLE');
      expect(fake.calls).toHaveLength(1);
      expect(await repo.chat.getConversation(app.db, conversationId)).not.toBeNull();
      expect(await exists(targetDir)).not.toBeNull();
    } finally {
      release();
    }
  });

  it('rejects queued runs with 409 before asking the worker to close anything', async () => {
    const agent = await newAgent('lifecycle-busy');
    const conversationId = await newConversation(agent.id);
    await queuedRun(agent.id, conversationId);
    const targetDir = workspace(agent.slug, 'session-sandboxes', conversationId);
    await mkdir(targetDir, { recursive: true });

    const fake = await startResponder();
    expectProblem(await deleteConversation(conversationId), 'CONFLICT');
    expectProblem(await deleteAgent(agent.id), 'CONFLICT');
    expect(fake.calls).toEqual([]);
    expect(await repo.chat.getConversation(app.db, conversationId)).not.toBeNull();
    expect(await exists(targetDir)).not.toBeNull();
  });

  it('waits outside a transaction while holding the session lock, then admits after release', async () => {
    const agent = await newAgent('lifecycle-race');
    const conversationId = await newConversation(agent.id);
    await completedRun(agent.id, conversationId, 'sandbox-race');
    const targetDir = workspace(agent.slug, 'session-sandboxes', conversationId);
    await mkdir(targetDir, { recursive: true });

    const fake = await startResponder();
    let release!: () => void;
    fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    let settled = false;
    const deletion = deleteConversation(conversationId).then((response) => {
      settled = true;
      return response;
    });
    expect(await waitFor(() => fake.calls.length === 1)).toBe(true);

    const pid = await deletingBackendPid();
    if (pid === null) throw new Error('deleting backend did not hold the session lock');
    const activity = await backendActivity(pid);
    // ACK 等待必须发生在事务外：连接 idle，且没有打开的事务。
    expect(activity?.state).toBe('idle');
    expect(activity?.xact_start).toBeNull();
    // A 已提交，实体在事务外仍然可见；目录也要等确认后才删。
    expect(await repo.chat.getConversation(app.db, conversationId)).not.toBeNull();
    expect(await exists(targetDir)).not.toBeNull();
    expect(settled).toBe(false);

    let admissionSettled = false;
    const admission = inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, conversationId, message: 'racing admission' },
    }).then((response) => {
      admissionSettled = true;
      return response;
    });
    await delay(150);
    // 全局绑定锁仍被删除连接持有：准入不得在 ACK 与 B 之间落地。
    expect(admissionSettled).toBe(false);
    expect(await deletingBackendPid()).toBe(pid);

    release();
    const deleted = await deletion;
    expect(deleted.statusCode, deleted.body).toBe(204);
    expectProblem(await admission, 'CONVERSATION_NOT_FOUND');
    expect(await repo.chat.getConversation(app.db, conversationId)).toBeNull();
    expect(await exists(targetDir)).toBeNull();
  });

  it('ignores the same advisory key held in another isolated database', async () => {
    // pg_locks 是集群级视图；Docker 套件在另一隔离库持同一绑定键，不能选成本轮删除连接。
    const other = await createIsolatedDatabase('api_delete_lifecycle_other');
    if (other === null) throw new Error('cannot create an isolated database for the boundary test');
    const otherPool = createDb(other.url).pool;
    const own = await app.pool.connect();
    try {
      await otherPool.query('select pg_advisory_lock(hashtext($1))', [
        repo.locks.AGENT_BINDINGS_LOCK_KEY,
      ]);
      const foreign = await otherPool.query<{ pid: number }>('select pg_backend_pid() as pid');
      expect(foreign.rows[0]?.pid).toBeGreaterThan(0);

      // 本库无人持锁：集群里只有另一库的连接持同一键，必须返回 null 而不是它。
      expect(await deletingBackendPid()).toBeNull();

      await own.query('select pg_advisory_lock(hashtext($1))', [
        repo.locks.AGENT_BINDINGS_LOCK_KEY,
      ]);
      const ownPid = await own.query<{ pid: number }>('select pg_backend_pid() as pid');
      // 本库自己的空闲 session 锁仍能被精确选中。
      expect(await deletingBackendPid()).toBe(Number(ownPid.rows[0]?.pid));
    } finally {
      const unlocked = await own.query('select pg_advisory_unlock_all()').then(
        () => true,
        () => false,
      );
      own.release(unlocked ? undefined : true);
      await otherPool.end();
      await other?.close();
    }
  });

  it('recovers admission after a failed close releases the session lock', async () => {
    const agent = await newAgent('lifecycle-release');
    const conversationId = await newConversation(agent.id);
    await completedRun(agent.id, conversationId, 'sandbox-release');

    const fake = await startResponder();
    let release!: () => void;
    fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.failures.set(conversationId, new Error('injected close failure'));

    const deletion = deleteConversation(conversationId);
    expect(await waitFor(() => fake.calls.length === 1)).toBe(true);
    let admissionSettled = false;
    const admission = inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, conversationId, message: 'after release' },
    }).then((response) => {
      admissionSettled = true;
      return response;
    });
    await delay(100);
    expect(admissionSettled).toBe(false);

    release();
    expectProblem(await deletion, 'SERVICE_UNAVAILABLE');
    const admitted = await admission;
    expect(admitted.statusCode, admitted.body).toBe(202);
    expect(await repo.chat.getConversation(app.db, conversationId)).not.toBeNull();
  });

  it('fails with a retryable 503 and keeps rows/directories when the deleting backend is killed', async () => {
    const agent = await newAgent('lifecycle-killed');
    const conversationId = await newConversation(agent.id);
    await completedRun(agent.id, conversationId, 'sandbox-killed');
    const targetDir = workspace(agent.slug, 'session-sandboxes', conversationId);
    await mkdir(targetDir, { recursive: true });

    const fake = await startResponder();
    let release!: () => void;
    fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const deletion = deleteConversation(conversationId);
    expect(await waitFor(() => fake.calls.length === 1)).toBe(true);
    const pid = await deletingBackendPid();
    if (pid === null) throw new Error('deleting backend did not hold the session lock');
    expect(await terminateBackend(pid)).toBe(true);
    await delay(50);
    release();

    const problem = expectProblem(await deletion, 'SERVICE_UNAVAILABLE');
    expect(problem.retryable).toBe(true);
    expect(await repo.chat.getConversation(app.db, conversationId)).not.toBeNull();
    expect(await exists(targetDir)).not.toBeNull();

    // 重试是完整的新操作，使用新连接重新取锁并成功删除。
    fake.hold = null;
    fake.calls.length = 0;
    expect((await deleteConversation(conversationId)).statusCode).toBe(204);
    expect(await repo.chat.getConversation(app.db, conversationId)).toBeNull();
    expect(await exists(targetDir)).toBeNull();
  });

  it('rejects with 409 when sandbox targets change between A and ACK release', async () => {
    const agent = await newAgent('lifecycle-target');
    const conversationId = await newConversation(agent.id);
    await completedRun(agent.id, conversationId, 'sandbox-before');
    const targetDir = workspace(agent.slug, 'session-sandboxes', conversationId);
    await mkdir(targetDir, { recursive: true });

    const fake = await startResponder();
    let release!: () => void;
    fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deletion = deleteConversation(conversationId);
    expect(await waitFor(() => fake.calls.length === 1)).toBe(true);
    try {
      await app.pool.query(
        `insert into agent_runs
           (id, conversation_id, agent_id, status, subject_kind, initiated_by, sandbox_id)
         values ($1, $2, $3, 'succeeded', 'user', $4, 'sandbox-after')`,
        [newId('run'), conversationId, agent.id, ADMIN_BUSINESS_ID],
      );
    } finally {
      release();
    }

    expectProblem(await deletion, 'CONFLICT');
    expect(await repo.chat.getConversation(app.db, conversationId)).not.toBeNull();
    expect(await exists(targetDir)).not.toBeNull();
  });

  it('returns 404 when conversation ownership changes while waiting for ACK', async () => {
    const owner = await createTestAccount(app, cookie, { systemKeys: ['owner'] });
    const agent = await newAgent('lifecycle-owner');
    const conversationId = await newConversation(agent.id, '待删除', owner.businessId);
    await completedRun(agent.id, conversationId, 'sandbox-owner');
    const targetDir = workspace(agent.slug, 'session-sandboxes', conversationId);
    await mkdir(targetDir, { recursive: true });

    const fake = await startResponder();
    let release!: () => void;
    fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deletion = inject(app, {
      method: 'DELETE',
      url: `/api/conversations/${conversationId}`,
      headers: { cookie: owner.cookie },
    });
    expect(await waitFor(() => fake.calls.length === 1)).toBe(true);
    await app.pool.query('update conversations set created_by = $1 where id = $2', [
      'someone-else',
      conversationId,
    ]);
    release();

    expectProblem(await deletion, 'CONVERSATION_NOT_FOUND');
    expect(await repo.chat.getConversation(app.db, conversationId)).not.toBeNull();
    expect(await exists(targetDir)).not.toBeNull();
  });

  it('still returns 204 after commit when runtime directory removal fails', async () => {
    const agent = await newAgent('lifecycle-rm');
    const conversationId = await newConversation(agent.id);
    // 用普通文件占住 session-sandboxes 路径：递归 rm 会 ENOTDIR，但提交结果不能被倒置。
    await mkdir(workspace(agent.slug), { recursive: true });
    const blocked = workspace(agent.slug, 'session-sandboxes');
    await writeFile(blocked, 'not a directory');

    const fake = await startResponder();
    const response = await deleteConversation(conversationId);
    expect(response.statusCode, response.body).toBe(204);
    expect(fake.calls).toEqual([{ conversationId, sandboxIds: [] }]);
    expect(await repo.chat.getConversation(app.db, conversationId)).toBeNull();
    expect(await exists(blocked)).not.toBeNull();
  });

  it('removes an agent session-sandboxes while keeping parent/child/personal memory and other agents', async () => {
    const child = await newAgent('lifecycle-child');
    const parent = await newAgent('lifecycle-parent', [child.id]);
    const other = await newAgent('lifecycle-other');
    const parentConversation = await newConversation(parent.id, '父会话');
    const childConversation = await newConversation(child.id, '子会话');
    const otherConversation = await newConversation(other.id, '其他');
    await completedRun(parent.id, parentConversation, 'sandbox-parent');
    await completedRun(child.id, childConversation, 'sandbox-child');
    await completedRun(other.id, otherConversation, 'sandbox-other');

    const parentSessions = workspace(parent.slug, 'session-sandboxes');
    const parentSession = join(parentSessions, parentConversation);
    const childSession = workspace(child.slug, 'session-sandboxes', childConversation);
    const otherSession = workspace(other.slug, 'session-sandboxes', otherConversation);
    for (const dir of [parentSession, childSession, otherSession]) {
      await mkdir(dir, { recursive: true });
    }
    await makeDir(workspace(parent.slug, 'agent-memory'), 'parent memory');
    await makeDir(workspace(child.slug, 'agent-memory'), 'child memory');
    await makeDir(workspace(other.slug, 'agent-memory'), 'other memory');
    const personalOwner = unique('personal-owner');
    personalOwners.push(personalOwner);
    const personalDir = workspace('_users', hash(personalOwner));
    await makeDir(personalDir, 'personal memory');

    const fake = await startResponder();
    const response = await deleteAgent(parent.id);
    expect(response.statusCode, response.body).toBe(204);

    expect(fake.calls).toEqual([
      { conversationId: parentConversation, sandboxIds: ['sandbox-parent'] },
    ]);
    expect(await repo.agents.getAgent(app.db, parent.id)).toBeNull();
    expect(await repo.chat.getConversation(app.db, parentConversation)).toBeNull();
    expect(await exists(parentSessions)).toBeNull();

    // 子专家解除绑定后继续存在；其会话、容器目录与记忆都保留。
    const childAfter = await repo.agents.getAgent(app.db, child.id);
    expect(childAfter?.id).toBe(child.id);
    expect(childAfter?.parentId).toBeNull();
    expect(await repo.chat.getConversation(app.db, childConversation)).not.toBeNull();
    expect(await exists(childSession)).not.toBeNull();
    expect(await exists(workspace(child.slug, 'agent-memory'))).not.toBeNull();

    expect(await repo.agents.getAgent(app.db, other.id)).not.toBeNull();
    expect(await repo.chat.getConversation(app.db, otherConversation)).not.toBeNull();
    expect(await exists(otherSession)).not.toBeNull();
    expect(await exists(workspace(other.slug, 'agent-memory'))).not.toBeNull();

    expect(await exists(workspace(parent.slug, 'agent-memory'))).not.toBeNull();
    expect(await exists(personalDir)).not.toBeNull();
  });

  it('rolls an agent delete back on close failure and retries without touching memories', async () => {
    const agent = await newAgent('lifecycle-agent-retry');
    const conversationId = await newConversation(agent.id);
    await completedRun(agent.id, conversationId, 'sandbox-agent-retry');
    const sessionsDir = workspace(agent.slug, 'session-sandboxes');
    await mkdir(join(sessionsDir, conversationId), { recursive: true });
    await makeDir(workspace(agent.slug, 'agent-memory'), 'keep');

    const fake = await startResponder();
    fake.failures.set(conversationId, new Error('close failed'));
    expectProblem(await deleteAgent(agent.id), 'SERVICE_UNAVAILABLE');
    expect(await repo.agents.getAgent(app.db, agent.id)).not.toBeNull();
    expect(await exists(sessionsDir)).not.toBeNull();
    expect(await exists(workspace(agent.slug, 'agent-memory'))).not.toBeNull();

    fake.failures.clear();
    expect((await deleteAgent(agent.id)).statusCode).toBe(204);
    expect(await repo.agents.getAgent(app.db, agent.id)).toBeNull();
    expect(await exists(sessionsDir)).toBeNull();
    expect(await exists(workspace(agent.slug, 'agent-memory'))).not.toBeNull();
  });
});
