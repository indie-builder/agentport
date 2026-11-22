import { afterAll, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import { createDb } from '../src/client.js';
import * as audit from '../src/repo/audit.js';
import { auditLog } from '../src/schema.js';

const isolated = await createIsolatedDatabase('db_audit_detail', process.env.DATABASE_URL ?? '');
const { db, client } = createDb(isolated?.url ?? process.env.DATABASE_URL ?? '');
const ready = await client.unsafe('select 1').then(
  () => true,
  () => false,
);
if (!(ready && isolated)) await isolated?.close();

type AuditRow = typeof auditLog.$inferSelect;

function legacyHash(row: AuditRow): string {
  return new Bun.CryptoHasher('sha256')
    .update(
      JSON.stringify([
        row.prevHash,
        row.id,
        row.actor,
        row.actorKind,
        row.subjectBusinessId,
        row.action,
        row.target,
        row.inputDigest,
        row.status,
        row.durationMs,
        row.requestId,
        row.createdAt.toISOString(),
      ]),
    )
    .digest('hex');
}

async function write(event: audit.AuditEvent): Promise<void> {
  await db.transaction((tx) => audit.writeAuditInTx(tx, event));
}

async function rowById(id: string): Promise<AuditRow> {
  const [row] = await db.select().from(auditLog).where(eq(auditLog.id, id));
  if (!row) throw new Error(`audit row ${id} not found`);
  return row;
}

describe.skipIf(!(ready && isolated))('audit detail chain', () => {
  afterAll(async () => {
    await client.close();
    await isolated?.close();
  });

  it('chains mixed detail rows and keeps the legacy hash for rows without detail', async () => {
    const target = `audit-detail-${crypto.randomUUID()}`;
    const plainId = `audit-plain-${crypto.randomUUID()}`;
    const detailId = `audit-detail-${crypto.randomUUID()}`;
    const tailId = `audit-tail-${crypto.randomUUID()}`;

    await write({ dedupeKey: plainId, action: 'audit.detail.test', target, status: 'ok' });
    await write({
      dedupeKey: detailId,
      action: 'audit.detail.test',
      target,
      status: 'ok',
      detail: {
        toolId: 'tool_1',
        from: 'allow',
        to: 'ask',
      },
    });
    await write({ dedupeKey: tailId, action: 'audit.detail.test', target, status: 'ok' });

    const plain = await rowById(plainId);
    expect(plain.detail).toBeNull();
    expect(plain.hash).toBe(legacyHash(plain));

    const result = await audit.verifyAuditChain(db);
    expect(result.ok).toBe(true);
    expect(result.brokenSeq).toBeNull();
    expect(result.checked).toBe(3);

    const entries = await audit.listAudit(db, { target });
    expect(entries).toHaveLength(3);
    const detailEntry = entries.find((entry) => entry.id === detailId);
    expect(detailEntry?.detail).toEqual({
      toolId: 'tool_1',
      from: 'allow',
      to: 'ask',
    });
  });

  it('treats JSON-null and non-string-record detail as no detail', async () => {
    const target = `audit-invalid-detail-${crypto.randomUUID()}`;
    const cases: Array<[string, unknown]> = [
      [`audit-nan-${crypto.randomUUID()}`, Number.NaN],
      [`audit-infinity-${crypto.randomUUID()}`, Number.POSITIVE_INFINITY],
      [`audit-string-${crypto.randomUUID()}`, '123'],
      [`audit-number-${crypto.randomUUID()}`, { from: 1 }],
      [`audit-nested-${crypto.randomUUID()}`, { from: 'allow', nested: { to: 'ask' } }],
      [`audit-tojson-${crypto.randomUUID()}`, { toJSON: () => null }],
    ];
    for (const [id, detail] of cases) {
      await write({ dedupeKey: id, action: 'audit.detail.invalid', target, status: 'ok', detail });
    }

    for (const [id] of cases) {
      const row = await rowById(id);
      expect(row.detail).toBeNull();
      expect(row.hash).toBe(legacyHash(row));
    }
    expect((await audit.verifyAuditChain(db)).ok).toBe(true);
  });

  it('keeps null-valued details and verifies the chain', async () => {
    const target = `audit-null-detail-${crypto.randomUUID()}`;
    const id = `audit-detail-${crypto.randomUUID()}`;
    const detail = { policyId: 'tap_1', from: '{"approvalMode":"ask"}', to: null };
    await write({ dedupeKey: id, action: 'audit.detail.null', target, status: 'ok', detail });

    const row = await rowById(id);
    expect(row.detail).toEqual(detail);
    expect((await audit.verifyAuditChain(db)).ok).toBe(true);

    const entries = await audit.listAudit(db, { target });
    expect(entries[0]?.detail).toEqual(detail);
  });

  it('detects tampering with a row that has no detail', async () => {
    const target = `audit-tamper-plain-${crypto.randomUUID()}`;
    const id = `audit-plain-${crypto.randomUUID()}`;
    await write({ dedupeKey: id, action: 'audit.detail.tamper', target, status: 'ok' });
    const row = await rowById(id);
    expect(row.hash).toBe(legacyHash(row));

    await db.update(auditLog).set({ target: 'tampered' }).where(eq(auditLog.id, id));
    const result = await audit.verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.brokenSeq).toBe(String(row.chainSeq));

    await db.update(auditLog).set({ target }).where(eq(auditLog.id, id));
    expect((await audit.verifyAuditChain(db)).ok).toBe(true);
  });

  it('detects tampering with readable detail', async () => {
    const target = `audit-tamper-detail-${crypto.randomUUID()}`;
    const id = `audit-detail-${crypto.randomUUID()}`;
    await write({
      dedupeKey: id,
      action: 'audit.detail.tamper',
      target,
      status: 'ok',
      detail: { from: 'allow', to: 'ask' },
    });
    const row = await rowById(id);

    await db
      .update(auditLog)
      .set({ detail: { from: 'ask', to: 'allow' } })
      .where(eq(auditLog.id, id));
    const result = await audit.verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.brokenSeq).toBe(String(row.chainSeq));

    await db.update(auditLog).set({ detail: row.detail }).where(eq(auditLog.id, id));
    expect((await audit.verifyAuditChain(db)).ok).toBe(true);
  });

  it('rejects a JSONB string with the same content as the original object', async () => {
    const target = `audit-tamper-type-${crypto.randomUUID()}`;
    const id = `audit-detail-${crypto.randomUUID()}`;
    await write({
      dedupeKey: id,
      action: 'audit.detail.tamper',
      target,
      status: 'ok',
      detail: { from: 'allow', to: 'ask' },
    });
    const row = await rowById(id);

    await db.execute(
      sql`update audit_log set detail = to_jsonb(${JSON.stringify(row.detail)}::text) where id = ${id}`,
    );
    const result = await audit.verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.brokenSeq).toBe(String(row.chainSeq));

    await db.update(auditLog).set({ detail: row.detail }).where(eq(auditLog.id, id));
    expect((await audit.verifyAuditChain(db)).ok).toBe(true);
  });

  it('rejects JSON null in place of SQL NULL', async () => {
    const target = `audit-tamper-jsonnull-${crypto.randomUUID()}`;
    const id = `audit-detail-${crypto.randomUUID()}`;
    await write({ dedupeKey: id, action: 'audit.detail.tamper', target, status: 'ok' });
    const row = await rowById(id);
    expect(row.detail).toBeNull();
    expect((await audit.verifyAuditChain(db)).ok).toBe(true);

    await db.execute(sql`update audit_log set detail = 'null'::jsonb where id = ${id}`);
    const result = await audit.verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.brokenSeq).toBe(String(row.chainSeq));

    await db.execute(sql`update audit_log set detail = null where id = ${id}`);
    expect((await audit.verifyAuditChain(db)).ok).toBe(true);
  });

  it('rejects a numeric value tampered into a detail field', async () => {
    const target = `audit-tamper-number-${crypto.randomUUID()}`;
    const id = `audit-detail-${crypto.randomUUID()}`;
    await write({
      dedupeKey: id,
      action: 'audit.detail.tamper',
      target,
      status: 'ok',
      detail: { from: '1', to: 'ask' },
    });
    const row = await rowById(id);

    await db.execute(
      sql`update audit_log set detail = '{"from":1,"to":"ask"}'::jsonb where id = ${id}`,
    );
    const result = await audit.verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.brokenSeq).toBe(String(row.chainSeq));

    await db.update(auditLog).set({ detail: row.detail }).where(eq(auditLog.id, id));
    expect((await audit.verifyAuditChain(db)).ok).toBe(true);
  });
});
