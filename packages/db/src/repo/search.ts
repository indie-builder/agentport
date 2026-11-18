import type { ResourceAccessFilter } from '@agentport/shared';
import { and, asc, desc, eq, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { knowledgeBases, plugins, servers, skills } from '../schema.js';
import { resourceScopeWhere } from './access.js';

function containsAny(columns: SQLWrapper[], needle: string): SQL {
  return sql`(${sql.join(
    columns.map((column) => sql`strpos(lower(${column}), lower(${needle})) > 0`),
    sql` or `,
  )})`;
}

export async function searchKnowledgeBases(
  db: Database,
  access: ResourceAccessFilter,
  q: string,
  limit: number,
) {
  return db
    .select({
      id: knowledgeBases.id,
      name: knowledgeBases.name,
      description: knowledgeBases.description,
      updatedAt: knowledgeBases.updatedAt,
    })
    .from(knowledgeBases)
    .where(
      and(
        resourceScopeWhere(access, knowledgeBases.id, knowledgeBases.ownerBusinessId),
        containsAny([knowledgeBases.name, knowledgeBases.description], q),
      ),
    )
    .orderBy(desc(knowledgeBases.updatedAt), asc(knowledgeBases.id))
    .limit(limit);
}

export async function searchServers(
  db: Database,
  access: ResourceAccessFilter,
  q: string,
  limit: number,
) {
  return db
    .select({
      id: servers.id,
      name: servers.name,
      description: servers.description,
      updatedAt: servers.updatedAt,
    })
    .from(servers)
    .where(
      and(
        resourceScopeWhere(access, servers.id, servers.ownerBusinessId),
        containsAny([servers.name, servers.description], q),
      ),
    )
    .orderBy(desc(servers.updatedAt), asc(servers.id))
    .limit(limit);
}

export async function searchSkills(
  db: Database,
  access: ResourceAccessFilter,
  q: string,
  limit: number,
) {
  return db
    .select({
      id: skills.id,
      name: skills.name,
      description: skills.description,
      updatedAt: skills.updatedAt,
    })
    .from(skills)
    .where(
      and(
        resourceScopeWhere(access, skills.id, skills.ownerBusinessId),
        eq(skills.status, 'published'),
        containsAny([skills.name, skills.slug, skills.description], q),
      ),
    )
    .orderBy(desc(skills.updatedAt), asc(skills.id))
    .limit(limit);
}

export async function searchPlugins(
  db: Database,
  access: ResourceAccessFilter,
  q: string,
  limit: number,
) {
  return db
    .select({
      id: plugins.id,
      name: plugins.name,
      description: plugins.description,
      updatedAt: plugins.updatedAt,
    })
    .from(plugins)
    .where(
      and(
        resourceScopeWhere(access, plugins.id, plugins.ownerBusinessId),
        containsAny([plugins.name, plugins.slug, plugins.description], q),
      ),
    )
    .orderBy(desc(plugins.updatedAt), asc(plugins.id))
    .limit(limit);
}
