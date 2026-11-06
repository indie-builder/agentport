import { auditLog, newId } from '../../../packages/db/src/index.js';
import { db, client as sql } from './database.js';

export async function seedAudit(
  target: string,
  action: string,
  extra: { inputDigest?: string; requestId?: string } = {},
): Promise<string> {
  const [row] = await db
    .insert(auditLog)
    .values({
      id: newId('audit'),
      actor: 'bootstrap-admin',
      actorKind: 'user',
      action,
      target,
      inputDigest: extra.inputDigest ?? null,
      requestId: extra.requestId ?? null,
      status: 'ok',
    })
    .returning({ id: auditLog.id });
  if (!row) throw new Error('Audit fixture did not return its ID');
  return row.id;
}

export async function removeFixtures(ids: string[], targets: string[]): Promise<void> {
  if (ids.length) await sql`delete from audit_log where id = any(${sql.array(ids, 'TEXT')})`;
  if (targets.length)
    await sql`delete from audit_log where target = any(${sql.array(targets, 'TEXT')})`;
}

async function seedRows(
  target: string,
  count: number,
  action: (index: number) => string,
): Promise<void> {
  const ids = Array.from({ length: count }, () => newId('audit')).sort();
  const createdAt = new Date();
  await db.insert(auditLog).values(
    ids.map((id, index) => ({
      id,
      actor: 'bootstrap-admin',
      actorKind: 'user' as const,
      action: action(index),
      target,
      status: 'ok',
      createdAt,
    })),
  );
}

export async function seedSameTime(target: string): Promise<void> {
  await seedRows(target, 125, (index) => `audit.page.${String(index + 1).padStart(3, '0')}`);
}

export async function seedOversize(target: string): Promise<void> {
  await seedRows(target, 1001, () => 'audit.e2e.bulk');
}

export async function seedLimit(target: string): Promise<void> {
  await seedRows(target, 1000, () => 'audit.e2e.bulk');
}
