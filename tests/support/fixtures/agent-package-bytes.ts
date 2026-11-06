import { randomUUID } from 'node:crypto';
import { newId } from '../../../packages/db/src/index.js';
import { client as sql } from './database.js';

interface Fixture {
  id: string;
  slug: string;
  name: string;
  prompt: string;
}

export async function seed(prompt: string): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    id: newId('agent'),
    slug: `e2e-pkg-${suffix}`,
    name: `E2E 包 ${suffix}`,
    prompt,
  };

  await sql`insert into agents (id, slug, name, model, system_prompt_md, created_by, owner_business_id)
     values (${fixture.id}, ${fixture.slug}, ${fixture.name}, 'test-model', ${prompt}, 'bootstrap-admin', 'bootstrap-admin')`;
  return fixture;
}

export async function cleanup(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await sql`delete from audit_log where target = any(${sql.array(ids, 'TEXT')})`;
  await sql`delete from agents where id = any(${sql.array(ids, 'TEXT')})`;
}
