import { afterAll, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
  return createHash('sha256')
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
    const target = `audit-detail-${randomUUID()}`;
    const plainId = `audit-plain-${randomUUID()}`;
    const detailId = `audit-detail-${randomUUID()}`;
    const tailId = `audit-tail-${randomUUID()}`;

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
        when: new Date('2026-01-02T03:04:05.678Z'),
        nested: { b: 2, a: [3, 2, 1] },
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
      when: '2026-01-02T03:04:05.678Z',
      nested: { b: 2, a: [3, 2, 1] },
    });
  });

  it('detects tampering with a row that has no detail', async () => {
    const target = `audit-tamper-plain-${randomUUID()}`;
    const id = `audit-plain-${randomUUID()}`;
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
    const target = `audit-tamper-detail-${randomUUID()}`;
    const id = `audit-detail-${randomUUID()}`;
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
});
