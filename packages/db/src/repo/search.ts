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

type SearchableTable = typeof knowledgeBases | typeof servers | typeof skills | typeof plugins;

type SearchResult = {
  id: string;
  name: string;
  description: string;
  updatedAt: Date;
};

async function searchTable(
  db: Database,
  access: ResourceAccessFilter,
  q: string,
  limit: number,
  table: SearchableTable,
  columns: SQLWrapper[],
  extra?: SQL,
): Promise<SearchResult[]> {
  return db
    .select({
      id: table.id,
      name: table.name,
      description: table.description,
      updatedAt: table.updatedAt,
    })
    .from(table)
    .where(
      and(
        resourceScopeWhere(access, table.id, table.ownerBusinessId),
        extra,
        containsAny(columns, q),
      ),
    )
    .orderBy(desc(table.updatedAt), asc(table.id))
    .limit(limit);
}

export function searchKnowledgeBases(
  db: Database,
  access: ResourceAccessFilter,
  q: string,
  limit: number,
) {
  return searchTable(db, access, q, limit, knowledgeBases, [
    knowledgeBases.name,
    knowledgeBases.description,
  ]);
}

export function searchServers(
  db: Database,
  access: ResourceAccessFilter,
  q: string,
  limit: number,
) {
  return searchTable(db, access, q, limit, servers, [servers.name, servers.description]);
}

export function searchSkills(db: Database, access: ResourceAccessFilter, q: string, limit: number) {
  return searchTable(
    db,
    access,
    q,
    limit,
    skills,
    [skills.name, skills.slug, skills.description],
    eq(skills.status, 'published'),
  );
}

export function searchPlugins(
  db: Database,
  access: ResourceAccessFilter,
  q: string,
  limit: number,
) {
  return searchTable(db, access, q, limit, plugins, [
    plugins.name,
    plugins.slug,
    plugins.description,
  ]);
}
