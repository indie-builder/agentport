import { randomUUID } from 'node:crypto';
import { newId } from '../../../packages/db/src/index.js';
import { client as sql } from './database.js';

interface Fixture {
  id: string;
  slug: string;
  name: string;
  description: string;
}

interface SeedOptions {
  name?: string;
  role?: string;
  description?: string;
  createdAt?: Date;
  enabled?: boolean;
}

export async function seed(effort: string | null, options: SeedOptions = {}): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    id: newId('agent'),
    slug: `e2e-defaults-${suffix}`,
    name: options.name ?? `E2E 默认值 ${suffix}`,
    description: options.description ?? '',
  };

  await sql`insert into agents (id, slug, name, role, description, enabled, model, effort, created_by, owner_business_id, created_at)
     values (${fixture.id}, ${fixture.slug}, ${fixture.name}, ${options.role ?? '通用助手'}, ${fixture.description}, ${options.enabled ?? true}, 'test-model', ${effort}, 'bootstrap-admin', 'bootstrap-admin', ${(options.createdAt ? new Date(options.createdAt) : new Date()).toISOString()})`;
  return fixture;
}

export async function stored(id: string) {
  const rows = await sql<{ effort: string | null }[]>`select effort from agents where id = ${id}`;
  return rows[0];
}

export async function cleanup(created: Fixture[]): Promise<void> {
  const ids = created.map((item) => item.id);
  if (!ids.length) return;
  await sql`delete from audit_log where target = any(${sql.array(ids, 'TEXT')})`;
  await sql`delete from agents where id = any(${sql.array(ids, 'TEXT')})`;
}

export async function legacyThinking() {
  return sql<{ id: string }[]>`select id from agents where name = 'Legacy thinking'`;
}
