import { fail } from '@agentport/core';
import type { AccessFilter } from '@agentport/shared';
import { and, desc, eq, isNull, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { Database } from '../../client.js';
import { agents, conversations, messages } from '../../schema.js';
import { conversationAccessWhere } from './shared.js';

const SEARCH_EXCERPT_CHARS = 240;

/**
 * 搜索只看真正的正文：对象 `{ type:'text', text }` 或数组中的 text 块。
 * tool 角色、附件元数据与 openui_action 的 params/context/formState 因此天然被排除。
 */
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

/** 搜索统一规则：NBSP 视作普通空格，连续空白压成一个空格；比较时再 lower。 */
function normalizeWhitespaceSql(value: SQLWrapper): SQL<string> {
  return sql<string>`regexp_replace(replace(${value}, chr(160), ' '), '\\s+', ' ', 'g')`;
}

/** 搜索与摘录共用同一份规范化文本，命中位置和截取坐标才对得上。 */
function normalizedMessageTextSql(): SQL<string | null> {
  return normalizeWhitespaceSql(messageTextSql());
}

/**
 * 游标是服务端生成的不透明串；格式不对说明调用方拼错，按输入错误返回。
 * at 保留 PostgreSQL 的微秒原串：转成 JS Date 会在编码时被截到毫秒，翻页漏项。
 */
function decodeSearchCursor(raw: string): { at: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    fail('INVALID_INPUT', 'before 游标无效，请刷新后重试');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    fail('INVALID_INPUT', 'before 游标无效，请刷新后重试');
  }
  const { at, id } = parsed as { at?: unknown; id?: unknown };
  if (typeof at !== 'string' || typeof id !== 'string' || at === '' || id === '') {
    fail('INVALID_INPUT', 'before 游标无效，请刷新后重试');
  }
  if (Number.isNaN(new Date(at).getTime())) fail('INVALID_INPUT', 'before 游标无效，请刷新后重试');
  return { at, id };
}

function encodeSearchCursor(row: { cursorAt: string; id: string }): string {
  return Buffer.from(JSON.stringify({ at: row.cursorAt, id: row.id }), 'utf8').toString(
    'base64url',
  );
}

export interface ConversationSearchOptions {
  q: string;
  agentId?: string | undefined;
  limit: number;
  /** 上一页最后一项的不透明游标（活动时间 + 会话 id）。 */
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

interface SearchRow {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  updatedAt: Date;
  /** last_message_at 的数据库原串，供游标保留微秒精度。 */
  cursorAt: string;
  /** 由 SQL 按与过滤相同的规则判定，避免 JS 与 PostgreSQL 的 lower 规则分叉。 */
  matchKind?: 'id' | 'title' | 'message';
  excerpt?: string | null;
}

/**
 * 全库匹配后再分页：先按 q 过滤会话，再按活动时间与 id 倒序取一页。
 * 每个会话最多一项，匹配优先级 id → title → message；空查询退化为最近会话。
 */
export async function searchConversations(
  db: Database,
  options: ConversationSearchOptions,
): Promise<{ items: ConversationSearchRow[]; nextBefore: string | null }> {
  const before = options.before === undefined ? null : decodeSearchCursor(options.before);
  const cursorFilter =
    before === null
      ? undefined
      : sql`(${conversations.lastMessageAt}, ${conversations.id}) < (${before.at}::timestamptz, ${before.id})`;
  const agentFilter =
    options.agentId === undefined ? undefined : eq(conversations.agentId, options.agentId);
  const accessFilter = conversationAccessWhere(options.access);
  // 频道 lane 只从频道页访问，私有搜索不返回别人的 lane。
  const privateOnly = isNull(conversations.channelId);
  const take = options.limit + 1;
  // 查询、正文、id 与 title 全部走同一份 SQL 规范化；JS 的 lower 与 PG 不一致，不参与比较。
  const needle =
    options.q === ''
      ? null
      : sql<string>`lower(${normalizeWhitespaceSql(sql`${options.q}::text`)})`;
  const cursorAt = sql<string>`${conversations.lastMessageAt}::text`;

  let rows: SearchRow[];
  if (needle === null) {
    rows = await db
      .select({
        id: conversations.id,
        agentId: conversations.agentId,
        agentName: agents.name,
        title: conversations.title,
        updatedAt: conversations.lastMessageAt,
        cursorAt,
      })
      .from(conversations)
      .innerJoin(agents, eq(agents.id, conversations.agentId))
      .where(and(agentFilter, accessFilter, privateOnly, cursorFilter))
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      .limit(take);
  } else {
    const text = normalizedMessageTextSql();
    const idMatch = sql`strpos(lower(${normalizeWhitespaceSql(conversations.id)}), ${needle}) > 0`;
    const titleMatch = sql`strpos(lower(${normalizeWhitespaceSql(conversations.title)}), ${needle}) > 0`;
    // match.kind 与过滤用同一批表达式算出来，结果不可能互相矛盾。
    const matchKind = sql<'id' | 'title' | 'message'>`case
      when ${idMatch} then 'id'
      when ${titleMatch} then 'title'
      else 'message'
    end`;
    // 先在整库范围判断命中，再排序分页；摘录只为当前页的会话补取。
    rows = await db
      .select({
        id: conversations.id,
        agentId: conversations.agentId,
        agentName: agents.name,
        title: conversations.title,
        updatedAt: conversations.lastMessageAt,
        cursorAt,
        matchKind,
      })
      .from(conversations)
      .innerJoin(agents, eq(agents.id, conversations.agentId))
      .where(
        and(
          agentFilter,
          accessFilter,
          privateOnly,
          // 字面子串：strpos 不解释 % / _；lower 让匹配大小写不敏感。
          sql`(
            ${idMatch}
            or ${titleMatch}
            or exists (
              select 1 from ${messages}
              where ${messages.conversationId} = ${conversations.id}
                and ${messages.role} in ('user', 'assistant')
                and strpos(lower(${text}), ${needle}) > 0
            )
          )`,
          cursorFilter,
        ),
      )
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      .limit(take);
  }

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  const excerptById = new Map<string, string | null>();
  if (needle !== null && page.length > 0) {
    const text = normalizedMessageTextSql();
    // 以命中位置为中心取 240 字窗口：起点最多回退 (240 - needle 长度) 的一半，
    // 且 needle 最长 200 字，命中词必然完整落在窗口内。
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
  const last = page.at(-1);
  return {
    items,
    nextBefore: hasMore && last !== undefined ? encodeSearchCursor(last) : null,
  };
}
