import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { repo } from '@agentport/db';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import { infraReady, loginCookie, request, startApp, type TestApp, unique } from './helpers.js';

const ready = await infraReady;
// 链校验扫全表，共享库会被同轮其它套件插入/删除的行误判为破链。
const isolated = ready ? await createIsolatedDatabase('audit_chain') : null;

const logger = { warn: () => undefined };

interface VerifyBody {
  ok: boolean;
  checked: number;
  brokenSeq: string | null;
}

describe.skipIf(!ready || isolated === null)('audit hash chain', () => {
  let app: TestApp;
  let cookie: string;

  beforeAll(async () => {
    if (!isolated) throw new Error('isolated database missing');
    app = await startApp({ DATABASE_URL: isolated.url });
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await app.close();
    await isolated?.close();
  });

  const verify = () =>
    request(app, { method: 'GET', url: '/api/audit/verify', headers: { cookie } });

  it('chains consecutive writes and verifies them', async () => {
    const target = unique('audit-chain');
    for (let i = 0; i < 3; i += 1) {
      await repo.audit.writeAudit(app.db, logger, {
        action: 'audit.chain.test',
        target,
        status: 'ok',
      });
    }

    const rows = await app.client.unsafe<{ id: string }[]>(
      'select id from audit_log where target = $1',
      [target],
    );
    expect(rows).toHaveLength(3);

    const result = await repo.audit.verifyAuditChain(app.db);
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(3);
    expect(result.brokenSeq).toBeNull();
  });

  it('detects a tampered chained row', async () => {
    const target = unique('audit-chain-tamper');
    await repo.audit.writeAudit(app.db, logger, {
      action: 'audit.chain.tamper',
      target,
      status: 'ok',
    });
    const [row] = await app.client.unsafe<{ id: string; chain_seq: string }[]>(
      'select id, chain_seq from audit_log where target = $1',
      [target],
    );
    if (!row) throw new Error('audit row not found');

    await app.client.unsafe("update audit_log set action = 'hacked' where id = $1", [row.id]);

    const result = await repo.audit.verifyAuditChain(app.db);
    expect(result.ok).toBe(false);
    expect(result.brokenSeq).toBe(row.chain_seq);
  });

  it('exposes the verification result over HTTP', async () => {
    const res = await verify();
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<VerifyBody>();
    expect(Object.keys(body).sort()).toEqual(['brokenSeq', 'checked', 'ok']);
    expect(typeof body.ok).toBe('boolean');
    expect(Number.isInteger(body.checked)).toBe(true);
  });
});
