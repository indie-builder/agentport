import { describe, expect, it } from 'vitest';
import {
  personalOutputShareListSchema,
  personalOutputShareSchema,
  personalProfileSchema,
  personalRunListQuerySchema,
  personalRunListSchema,
  personalRunSchema,
  personalSessionListSchema,
  personalSessionSchema,
  personalShareListQuerySchema,
  personalUsageQuerySchema,
  personalUsageSummarySchema,
  updatePersonalProfileInputSchema,
} from '../src/personal.js';

const iso = '2026-10-31T00:00:00.000Z';

describe('personal profile input', () => {
  it('accepts a display name and keeps it as entered', () => {
    expect(updatePersonalProfileInputSchema.parse({ name: ' 张三 ' })).toEqual({ name: ' 张三 ' });
  });

  it('rejects empty or whitespace-only names', () => {
    for (const name of ['', '   ', '\n\t']) {
      expect(updatePersonalProfileInputSchema.safeParse({ name }).success).toBe(false);
    }
  });

  it('rejects identity and role fields', () => {
    for (const extra of [
      { username: 'x' },
      { businessId: 'biz' },
      { roles: ['admin'] },
      { image: 'https://example.com/a.png' },
    ]) {
      expect(updatePersonalProfileInputSchema.safeParse({ name: '张三', ...extra }).success).toBe(
        false,
      );
    }
  });

  it('projects only the three identity display fields', () => {
    expect(
      personalProfileSchema.parse({
        businessId: 'biz_1',
        username: 'zhangsan',
        name: '张三',
        token: 'secret',
      }),
    ).toEqual({ businessId: 'biz_1', username: 'zhangsan', name: '张三' });
  });
});

describe('personal sessions', () => {
  const session = {
    id: 'session_1',
    createdAt: iso,
    updatedAt: iso,
    expiresAt: '2026-11-01T00:00:00.000Z',
    ipAddress: '127.0.0.1',
    userAgent: 'vitest',
    current: true,
  };

  it('accepts display metadata and strips credential fields', () => {
    expect(
      personalSessionSchema.parse({ ...session, token: 'raw', userId: 'auth_user' }),
    ).toEqual(session);
  });

  it('requires nullable session metadata and ISO timestamps', () => {
    expect(personalSessionSchema.safeParse({ ...session, ipAddress: null }).success).toBe(true);
    expect(personalSessionSchema.safeParse({ ...session, createdAt: 0 }).success).toBe(false);
    expect(personalSessionSchema.safeParse({ ...session, expiresAt: undefined }).success).toBe(
      false,
    );
  });

  it('wraps sessions in an items list', () => {
    expect(personalSessionListSchema.parse({ items: [session] }).items).toHaveLength(1);
  });
});

describe('personal output shares', () => {
  it('extends the existing share shape with conversation source fields', () => {
    const share = personalOutputShareSchema.parse({
      id: 'share_1',
      runId: 'run_1',
      path: 'report.md',
      sha256: 'a'.repeat(64),
      createdAt: iso,
      revokedAt: null,
      urlPath: '/s/share_1#token',
      conversationId: 'conv_1',
      conversationTitle: '周报',
      agentId: 'agent_1',
    });
    expect(share.conversationId).toBe('conv_1');
    expect(share.agentId).toBe('agent_1');
  });

  it('keeps the cursor nullable in the list envelope', () => {
    expect(personalOutputShareListSchema.parse({ items: [], nextCursor: null }).nextCursor).toBe(
      null,
    );
  });
});

describe('personal usage summary', () => {
  const summary = {
    days: 30,
    since: iso,
    until: '2026-10-31T12:00:00.000Z',
    runCount: 4,
    succeeded: 1,
    failed: 1,
    cancelled: 1,
    timeout: 0,
    queued: 0,
    running: 1,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: null,
    costRecordedRuns: 0,
    costMissingRuns: 4,
  };

  it('accepts null cost with recorded/missing run counts', () => {
    expect(personalUsageSummarySchema.parse(summary)).toEqual(summary);
  });

  it('rejects negative counters', () => {
    expect(personalUsageSummarySchema.safeParse({ ...summary, failed: -1 }).success).toBe(false);
  });
});

describe('personal runs', () => {
  const run = {
    id: 'run_1',
    agentId: 'agent_1',
    agentName: '助手',
    status: 'succeeded',
    startedAt: iso,
    endedAt: iso,
    latencyMs: 10,
    costUsd: null,
    turns: null,
    inputTokens: null,
    outputTokens: null,
    error: null,
    trigger: 'chat',
    createdAt: iso,
    conversationId: 'conv_1',
  };

  it('requires trigger and createdAt while keeping nullable usage columns', () => {
    expect(personalRunSchema.parse(run)).toMatchObject({
      trigger: 'chat',
      conversationId: 'conv_1',
      costUsd: null,
      inputTokens: null,
    });
    expect(personalRunSchema.safeParse({ ...run, trigger: undefined }).success).toBe(false);
    expect(personalRunSchema.safeParse({ ...run, conversationId: null }).success).toBe(true);
  });

  it('wraps runs in a cursor list', () => {
    expect(personalRunListSchema.parse({ items: [run], nextCursor: 'run_1' }).nextCursor).toBe(
      'run_1',
    );
  });
});

describe('personal query defaults', () => {
  it('defaults share paging to 50 and coerces limits', () => {
    expect(personalShareListQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(personalShareListQuerySchema.parse({ limit: '10' }).limit).toBe(10);
  });

  it('defaults the usage window to 30 days and accepts 1..90', () => {
    expect(personalUsageQuerySchema.parse({}).days).toBe(30);
    expect(personalUsageQuerySchema.parse({ days: '90' }).days).toBe(90);
    expect(personalUsageQuerySchema.safeParse({ days: '91' }).success).toBe(false);
  });

  it('defaults the run list window and limit while accepting filters', () => {
    expect(personalRunListQuerySchema.parse({})).toEqual({ days: 30, limit: 50 });
    expect(
      personalRunListQuerySchema.parse({
        days: '7',
        agentId: 'agent_1',
        status: 'failed',
        trigger: 'review',
        cursor: 'run_1',
      }),
    ).toMatchObject({ days: 7, status: 'failed', trigger: 'review' });
  });

  it('rejects unknown query keys', () => {
    expect(personalRunListQuerySchema.safeParse({ userId: 'other' }).success).toBe(false);
    expect(personalUsageQuerySchema.safeParse({ userId: 'other' }).success).toBe(false);
    expect(personalShareListQuerySchema.safeParse({ userId: 'other' }).success).toBe(false);
  });
});
