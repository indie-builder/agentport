import type { Database } from '@agentport/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 跑批开始时的用例快照契约：有快照就绝不再读活用例表。
 * 只 mock repo/bullmq 这一层边界，断言 worker 的输入与写回内容。
 */
const mocks = vi.hoisted(() => {
  const noop = () => undefined;
  return {
    queueAdd: vi.fn(),
    waitUntilReady: vi.fn(async () => undefined),
    waitUntilFinished: vi.fn(async () => undefined),
    evalRepo: {
      getEvalRun: vi.fn(),
      claimEvalRun: vi.fn(),
      listCases: vi.fn(),
      addResult: vi.fn(),
      updateProgress: vi.fn(),
      finishEvalRun: vi.fn(),
    },
    chat: {
      admitChatRun: vi.fn(),
      getRun: vi.fn(),
      listMessages: vi.fn(),
      messageText: (content: { text?: string } | null | undefined) => content?.text ?? null,
    },
    checkAccess: vi.fn(),
    auditWrite: vi.fn(async () => undefined),
    logger: { info: noop, warn: noop, error: noop, debug: noop, child: noop },
  };
});

vi.mock('../src/run-access.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/run-access.js')>();
  return { ...actual, loadUserAgentAccess: mocks.checkAccess };
});

vi.mock('@agentport/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentport/db')>();
  return {
    ...actual,
    repo: {
      ...actual.repo,
      agentVersions: {
        ...actual.repo.agentVersions,
        latestAgentVersion: vi.fn().mockResolvedValue(null),
      },
      evalRepo: mocks.evalRepo,
      chat: mocks.chat,
      audit: { ...actual.repo.audit, writeAudit: mocks.auditWrite },
    },
  };
});

vi.mock('bullmq', () => ({
  Queue: class {
    add = mocks.queueAdd;
    close = vi.fn(async () => undefined);
  },
  QueueEvents: class {
    on = vi.fn();
    close = vi.fn(async () => undefined);
    waitUntilReady = mocks.waitUntilReady;
  },
}));

import { executeEvalRun } from '../src/eval-runner.js';

type SnapshotCase = { id: string; name: string; prompt: string; expectation: string };

const db = {
  select: () => ({
    from: () => ({
      where: () => ({ limit: async () => [{ timeoutMs: 5_000 }] }),
    }),
  }),
} as unknown as Database;
const logger = mocks.logger as unknown as Parameters<typeof executeEvalRun>[0]['logger'];
const agentId = 'agent-1';
const evalRunId = 'evalRun-1';
const evalBusinessId = 'eval-owner';
const outputsByConversation = new Map<string, string>();

function runWith(caseSnapshot: SnapshotCase[] | null, outputs: Record<string, string>): void {
  mocks.evalRepo.getEvalRun.mockResolvedValue({
    status: 'running',
    agentId,
    createdBy: evalBusinessId,
    caseSnapshot,
  });
  mocks.checkAccess.mockResolvedValue({
    denial: null,
    grants: [{ permissionId: 'eval.read', scope: 'owned_agents' }],
  });
  mocks.evalRepo.claimEvalRun.mockResolvedValue(true);
  mocks.evalRepo.listCases.mockImplementation(() => {
    throw new Error('listCases must not run when a snapshot exists');
  });
  for (const [name, text] of Object.entries(outputs)) outputsByConversation.set(name, text);
  mocks.chat.admitChatRun.mockImplementation(
    async (_db: Database, input: { title: string; agentId: string }) => {
      const conversationId = input.title.replace('eval: ', '');
      return { run: { id: `run-${conversationId}` }, conversationId };
    },
  );
  mocks.chat.getRun.mockImplementation(async (_db: Database, id: string) => ({
    id,
    status: 'succeeded',
  }));
  mocks.chat.listMessages.mockImplementation(async (_db: Database, conversationId: string) => [
    {
      role: 'assistant',
      content: { type: 'text', text: outputsByConversation.get(conversationId) ?? '' },
    },
  ]);
  mocks.queueAdd.mockResolvedValue({ waitUntilFinished: mocks.waitUntilFinished });
  mocks.evalRepo.addResult.mockResolvedValue(undefined);
  mocks.evalRepo.finishEvalRun.mockResolvedValue(undefined);
  mocks.auditWrite.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  outputsByConversation.clear();
});

describe('executeEvalRun case snapshot', () => {
  it('runs and judges snapshot cases without reading the live case table', async () => {
    const snapshot: SnapshotCase[] = [
      { id: 'evalCase-a', name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
      { id: 'evalCase-b', name: 'beta', prompt: 'prompt-beta', expectation: 'beta-ok' },
    ];
    runWith(snapshot, { alpha: 'answer alpha-ok', beta: 'answer beta-ok' });

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.evalRepo.listCases).not.toHaveBeenCalled();
    // 喂给 run job 的 prompt 与 judge 用的 expectation 都来自快照。
    expect(mocks.queueAdd.mock.calls.map((call) => call[1].prompt)).toEqual([
      'prompt-alpha',
      'prompt-beta',
    ]);
    expect(mocks.evalRepo.addResult).toHaveBeenCalledTimes(2);
    expect(mocks.evalRepo.addResult.mock.calls[0]?.[1]).toMatchObject({
      evalRunId,
      caseId: 'evalCase-a',
      passed: true,
      caseSnapshot: snapshot[0],
    });
    expect(mocks.evalRepo.addResult.mock.calls[1]?.[1]).toMatchObject({
      evalRunId,
      caseId: 'evalCase-b',
      passed: true,
      caseSnapshot: snapshot[1],
    });
    // 总数按快照长度收敛，而不是重读后的活用例。
    expect(mocks.evalRepo.finishEvalRun).toHaveBeenCalledWith(db, evalRunId, {
      status: 'succeeded',
      passed: 2,
      error: null,
    });
    // 超时仍取当前 agent 配置，不随快照冻结。
    expect(mocks.waitUntilFinished).toHaveBeenCalledWith(expect.anything(), 5_000);
    // 执行主体只取 evalRuns.createdBy，不来自 job。
    expect(mocks.chat.admitChatRun).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        subject: { kind: 'user', businessId: evalBusinessId },
      }),
    );
  });

  it('records a snapshot case whose live row was deleted, without a live fetch', async () => {
    const snapshot: SnapshotCase[] = [
      { id: 'evalCase-deleted', name: 'gone', prompt: 'prompt-gone', expectation: 'gone-ok' },
    ];
    runWith(snapshot, { gone: 'answer gone-ok' });

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.evalRepo.listCases).not.toHaveBeenCalled();
    expect(mocks.evalRepo.addResult).toHaveBeenCalledTimes(1);
    // 原用例字段随结果写回，报告不依赖仍然存在的 eval_cases 行。
    expect(mocks.evalRepo.addResult.mock.calls[0]?.[1]).toMatchObject({
      caseId: 'evalCase-deleted',
      caseSnapshot: snapshot[0],
      passed: true,
    });
    expect(mocks.evalRepo.finishEvalRun).toHaveBeenCalledWith(db, evalRunId, {
      status: 'succeeded',
      passed: 1,
      error: null,
    });
  });

  it('treats an empty snapshot as zero cases instead of re-reading them', async () => {
    runWith([], {});

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.evalRepo.listCases).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(mocks.evalRepo.addResult).not.toHaveBeenCalled();
    expect(mocks.evalRepo.finishEvalRun).toHaveBeenCalledWith(db, evalRunId, {
      status: 'succeeded',
      passed: 0,
      error: null,
    });
  });

  it('stops after the already-running case when cancelled between cases', async () => {
    const snapshot: SnapshotCase[] = [
      { id: 'evalCase-a', name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
      { id: 'evalCase-b', name: 'beta', prompt: 'prompt-beta', expectation: 'beta-ok' },
    ];
    runWith(snapshot, { alpha: 'answer alpha-ok', beta: 'answer beta-ok' });
    // 调用顺序：初次读取、认领后、alpha 前后各一次、beta 前、收口前。
    const running = {
      status: 'running',
      agentId,
      createdBy: evalBusinessId,
      caseSnapshot: snapshot,
    };
    const cancelled = {
      status: 'cancelled',
      agentId,
      createdBy: evalBusinessId,
      caseSnapshot: snapshot,
    };
    mocks.evalRepo.getEvalRun
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(cancelled)
      .mockResolvedValueOnce(cancelled);

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    // 取消前已跑完的 case 保留结果，之后不再入队、写结果或收口。
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
    expect(mocks.evalRepo.addResult).toHaveBeenCalledTimes(1);
    expect(mocks.evalRepo.finishEvalRun).not.toHaveBeenCalled();
  });

  it('discards the output of a case cancelled in flight', async () => {
    const snapshot: SnapshotCase[] = [
      { id: 'evalCase-a', name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
    ];
    runWith(snapshot, { alpha: 'answer alpha-ok' });
    const running = {
      status: 'running',
      agentId,
      createdBy: evalBusinessId,
      caseSnapshot: snapshot,
    };
    const cancelled = {
      status: 'cancelled',
      agentId,
      createdBy: evalBusinessId,
      caseSnapshot: snapshot,
    };
    // 调用顺序：初次读取、认领后、alpha 前、alpha 跑完后、收口前。
    mocks.evalRepo.getEvalRun
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(cancelled)
      .mockResolvedValueOnce(cancelled);

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.evalRepo.addResult).not.toHaveBeenCalled();
    expect(mocks.evalRepo.updateProgress).not.toHaveBeenCalled();
    expect(mocks.evalRepo.finishEvalRun).not.toHaveBeenCalled();
  });

  it('falls back to listCases only when the run has no snapshot', async () => {
    const live: SnapshotCase[] = [
      { id: 'evalCase-live', name: 'live', prompt: 'prompt-live', expectation: 'live-ok' },
    ];
    runWith(null, { live: 'answer live-ok' });
    mocks.evalRepo.listCases.mockResolvedValue(live);

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.evalRepo.listCases).toHaveBeenCalledWith(
      db,
      { businessId: evalBusinessId, scopes: ['owned_agents'] },
      agentId,
    );
    expect(mocks.queueAdd.mock.calls.map((call) => call[1].prompt)).toEqual(['prompt-live']);
    expect(mocks.evalRepo.addResult.mock.calls[0]?.[1]).toMatchObject({
      caseId: 'evalCase-live',
      passed: true,
      caseSnapshot: live[0],
    });
    expect(mocks.evalRepo.finishEvalRun).toHaveBeenCalledWith(db, evalRunId, {
      status: 'succeeded',
      passed: 1,
      error: null,
    });
  });

  it('records a judged-failure case and continues with the next case', async () => {
    const snapshot: SnapshotCase[] = [
      { id: 'evalCase-a', name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
      { id: 'evalCase-b', name: 'beta', prompt: 'prompt-beta', expectation: 'beta-ok' },
    ];
    runWith(snapshot, { alpha: 'wrong answer', beta: 'answer beta-ok' });

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.evalRepo.addResult).toHaveBeenCalledTimes(2);
    expect(mocks.evalRepo.addResult.mock.calls[0]?.[1]).toMatchObject({
      caseId: 'evalCase-a',
      runId: 'run-alpha',
      passed: false,
      output: 'wrong answer',
    });
    expect(mocks.evalRepo.addResult.mock.calls[1]?.[1]).toMatchObject({
      caseId: 'evalCase-b',
      runId: 'run-beta',
      passed: true,
    });
    expect(mocks.evalRepo.finishEvalRun).toHaveBeenCalledWith(db, evalRunId, {
      status: 'failed',
      passed: 1,
      error: null,
    });
  });

  it.each(['failed', 'cancelled', 'timeout'] as const)(
    'records the child run id when the run ends in %s',
    async (status) => {
      const snapshot: SnapshotCase[] = [
        { id: 'evalCase-a', name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
        { id: 'evalCase-b', name: 'beta', prompt: 'prompt-beta', expectation: 'beta-ok' },
      ];
      runWith(snapshot, { alpha: 'ignored', beta: 'answer beta-ok' });
      mocks.chat.getRun.mockImplementation(async (_db: Database, id: string) =>
        id === 'run-alpha' ? { id, status, error: 'boom' } : { id, status: 'succeeded' },
      );

      await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

      expect(mocks.evalRepo.addResult).toHaveBeenCalledTimes(2);
      expect(mocks.evalRepo.addResult.mock.calls[0]?.[1]).toMatchObject({
        caseId: 'evalCase-a',
        runId: 'run-alpha',
        passed: false,
        output: `run ended with ${status}: boom`,
      });
      expect(mocks.evalRepo.addResult.mock.calls[1]?.[1]).toMatchObject({
        caseId: 'evalCase-b',
        runId: 'run-beta',
        passed: true,
      });
      expect(mocks.evalRepo.finishEvalRun).toHaveBeenCalledWith(db, evalRunId, {
        status: 'failed',
        passed: 1,
        error: null,
      });
    },
  );

  it('records the child run id when waiting for the queue fails', async () => {
    const snapshot: SnapshotCase[] = [
      { id: 'evalCase-a', name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
    ];
    runWith(snapshot, {});
    mocks.chat.getRun.mockResolvedValue({ id: 'run-alpha', status: 'running' });
    mocks.waitUntilFinished.mockRejectedValueOnce(new Error('queue wait failed'));

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.evalRepo.addResult).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        caseId: 'evalCase-a',
        runId: 'run-alpha',
        passed: false,
        output: 'queue wait failed',
      }),
      { recordProgress: true },
    );
    expect(mocks.evalRepo.finishEvalRun).toHaveBeenCalledWith(db, evalRunId, {
      status: 'failed',
      passed: 0,
      error: null,
    });
  });

  it('keeps the run id null when the child run was never created', async () => {
    const snapshot: SnapshotCase[] = [
      { id: 'evalCase-a', name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
    ];
    runWith(snapshot, {});
    mocks.chat.admitChatRun.mockRejectedValueOnce(new Error('db down'));

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(mocks.evalRepo.addResult).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        caseId: 'evalCase-a',
        runId: null,
        passed: false,
        output: 'db down',
      }),
      { recordProgress: true },
    );
    expect(mocks.evalRepo.finishEvalRun).toHaveBeenCalledWith(db, evalRunId, {
      status: 'failed',
      passed: 0,
      error: null,
    });
  });

  it('fails the batch without counting a pass when the result write fails', async () => {
    const snapshot: SnapshotCase[] = [
      { id: 'evalCase-a', name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
      { id: 'evalCase-b', name: 'beta', prompt: 'prompt-beta', expectation: 'beta-ok' },
      { id: 'evalCase-c', name: 'gamma', prompt: 'prompt-gamma', expectation: 'gamma-ok' },
    ];
    runWith(snapshot, {
      alpha: 'answer alpha-ok',
      beta: 'answer beta-ok',
      gamma: 'answer gamma-ok',
    });
    mocks.evalRepo.addResult
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('result write failed'));

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    // 第二条结果落库失败后不再跑第三条，也不把失败条算进 passed。
    expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
    expect(mocks.evalRepo.addResult).toHaveBeenCalledTimes(2);
    expect(mocks.evalRepo.finishEvalRun).toHaveBeenCalledWith(db, evalRunId, {
      status: 'failed',
      passed: 1,
      error: 'result write failed',
    });
  });

  it('skips a duplicate delivery without running cases', async () => {
    const snapshot: SnapshotCase[] = [
      { id: 'evalCase-a', name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
    ];
    runWith(snapshot, { alpha: 'answer alpha-ok' });
    mocks.evalRepo.claimEvalRun.mockResolvedValueOnce(false);

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(mocks.evalRepo.addResult).not.toHaveBeenCalled();
    expect(mocks.evalRepo.finishEvalRun).not.toHaveBeenCalled();
  });

  it('fails the batch without running cases when the executor lost access', async () => {
    const snapshot: SnapshotCase[] = [
      { id: 'evalCase-a', name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
    ];
    runWith(snapshot, { alpha: 'answer alpha-ok' });
    mocks.checkAccess.mockResolvedValue({
      denial: {
        reason: 'permission_denied',
        message: '当前账户没有该操作的专家权限，运行未启动',
      },
      grants: [],
    });

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.checkAccess).toHaveBeenCalledWith(expect.anything(), {
      businessId: evalBusinessId,
      agentId,
      permissions: ['agents.use', 'eval.execute'],
    });
    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(mocks.chat.admitChatRun).not.toHaveBeenCalled();
    expect(mocks.evalRepo.finishEvalRun).toHaveBeenCalledWith(db, evalRunId, {
      status: 'failed',
      passed: 0,
      error: '当前账户没有该操作的专家权限，运行未启动',
    });
    expect(mocks.auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      logger,
      expect.objectContaining({ action: 'eval.denied', target: evalRunId, status: 'denied' }),
    );
  });
});
