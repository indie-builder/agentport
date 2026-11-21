import type { AccessFilter } from '@agentport/shared';
import { desc, eq, isNull, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { Database } from '../../client.js';
import { agents, conversations, messages } from '../../schema.js';
import { cursorValueSql, keysetPage } from '../pagination.js';
import { conversationAccessWhere } from './shared.js';

const SEARCH_EXCERPT_CHARS = 240;

function messageTextSql(): SQL<string | null> {
  return sql<string | null>`case
    when jsonb_typeof(${messages.content}) = 'object'
      and ${messages.content}->>'type' = 'text'
      then ${messages.content}->>'text'
    when jsonb_typeof(${messages.content}) = 'array'
      then (
        select string_agg(elem->>'text', E'\\n')
        from jsonb_array_elements(${messages.content}) as elem
        where elem->>'type' = 'text'
      )
  end`;
}

function normalizeWhitespaceSql(value: SQLWrapper): SQL<string> {
  return sql<string>`regexp_replace(replace(${value}, chr(160), ' '), '\\s+', ' ', 'g')`;
}

function normalizedMessageTextSql(): SQL<string | null> {
  return normalizeWhitespaceSql(messageTextSql());
}

export interface ConversationSearchOptions {
  q: string;
  agentId?: string | undefined;
  limit: number;
  before?: string | undefined;
  access: AccessFilter;
}

export interface ConversationSearchMatch {
  kind: 'id' | 'title' | 'message';
  excerpt: string | null;
}

export interface ConversationSearchRow {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  updatedAt: Date;
  match: ConversationSearchMatch | null;
}

/**
 * 全库匹配后再分页：先按 q 过滤会话，再按活动时间与 id 倒序取一页。
 * 每个会话最多一项，匹配优先级 id → title → message；空查询退化为最近会话。
 */
export function searchConversations(
  db: Database,
  options: ConversationSearchOptions & { before?: never },
): Promise<{ items: ConversationSearchRow[]; nextBefore: string | null }>;
export function searchConversations(
  db: Database,
  options: ConversationSearchOptions,
): Promise<{ items: ConversationSearchRow[]; nextBefore: string | null } | null>;
export async function searchConversations(
  db: Database,
  options: ConversationSearchOptions,
): Promise<{ items: ConversationSearchRow[]; nextBefore: string | null } | null> {
  const agentFilter =
    options.agentId === undefined ? undefined : eq(conversations.agentId, options.agentId);
  const needle =
    options.q === ''
      ? null
      : sql<string>`lower(${normalizeWhitespaceSql(sql`${options.q}::text`)})`;
  const idMatch = sql`strpos(lower(${normalizeWhitespaceSql(conversations.id)}), ${needle}) > 0`;
  const titleMatch = sql`strpos(lower(${normalizeWhitespaceSql(conversations.title)}), ${needle}) > 0`;
  const matchFilter =
    needle === null
      ? undefined
      : sql`(
    ${idMatch}
    or ${titleMatch}
    or exists (
      select 1 from ${messages}
      where ${messages.conversationId} = ${conversations.id}
        and ${messages.role} in ('user', 'assistant')
        and strpos(lower(${normalizedMessageTextSql()}), ${needle}) > 0
    )
  )`;
  const result = await keysetPage(db, {
    table: conversations,
    cursor: options.before,
    limit: options.limit,
    column: conversations.lastMessageAt,
    valueCursor: (row: { cursorValue: string }) => row.cursorValue,
    cursorKind: 'timestamp',
    where: [
      agentFilter,
      conversationAccessWhere(options.access),
      isNull(conversations.channelId),
      matchFilter,
    ],
    load: ({ where, limit }: { where: SQL | undefined; limit: number }) =>
      db
        .select({
          id: conversations.id,
          agentId: conversations.agentId,
          agentName: agents.name,
          title: conversations.title,
          updatedAt: conversations.lastMessageAt,
          cursorValue: cursorValueSql(conversations.lastMessageAt),
          matchKind: sql<'id' | 'title' | 'message' | null>`case
            when ${idMatch} then 'id'
            when ${titleMatch} then 'title'
            when ${needle}::text is not null then 'message'
          end`,
        })
        .from(conversations)
        .innerJoin(agents, eq(agents.id, conversations.agentId))
        .where(where)
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(limit),
  });
  if (result === null) return null;
  const page = result.items;

  const excerptById = new Map<string, string | null>();
  if (needle !== null && page.length > 0) {
    const text = normalizedMessageTextSql();
    const result = await db.execute<{ conversationId: string; excerpt: string | null }>(sql`
      select distinct on (${messages.conversationId})
        ${messages.conversationId} as "conversationId",
        substr(
          normalized.body,
          greatest(
            1,
            strpos(lower(normalized.body), ${needle})
              - ((${SEARCH_EXCERPT_CHARS} - char_length(${needle})) / 2)::int
          ),
          ${SEARCH_EXCERPT_CHARS}
        ) as excerpt
      from ${messages}
      cross join lateral (select ${text} as body) normalized
      where ${messages.conversationId} in (${sql.join(
        page.map((row) => sql`${row.id}`),
        sql`, `,
      )})
        and ${messages.role} in ('user', 'assistant')
        and strpos(lower(normalized.body), ${needle}) > 0
      order by ${messages.conversationId}, ${messages.createdAt} desc, ${messages.id} desc
    `);
    for (const row of result) {
      excerptById.set(row.conversationId, row.excerpt);
    }
  }

  const items = page.map((row): ConversationSearchRow => {
    let match: ConversationSearchMatch | null = null;
    if (needle !== null) {
      match =
        row.matchKind === 'id'
          ? { kind: 'id', excerpt: null }
          : row.matchKind === 'title'
            ? { kind: 'title', excerpt: null }
            : { kind: 'message', excerpt: excerptById.get(row.id) ?? null };
    }
    return {
      id: row.id,
      agentId: row.agentId,
      agentName: row.agentName,
      title: row.title,
      updatedAt: row.updatedAt,
      match,
    };
  });
  return {
    items,
    nextBefore: result.nextCursor,
  };
}
