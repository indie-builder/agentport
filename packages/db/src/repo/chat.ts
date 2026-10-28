import { randomUUID } from 'node:crypto';
import { fail } from '@agentport/core';
import { type MessageAttachment, messageAttachments } from '@agentport/shared';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  type SQL,
  type SQLWrapper,
  sql,
} from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentRuns, agents, conversations, messages } from '../schema.js';
import { inheritApprovals } from './runs.js';

/** 事务句柄：准入逻辑在事务内复用同一批写函数。 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type RunStatus = NonNullable<typeof agentRuns.$inferInsert.status>;

/** 只更新我关心的字段；worker 也可复用。 */
export interface RunPatch {
  status?: RunStatus;
  sessionId?: string | null;
  sandboxId?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  error?: string | null;
  costUsd?: string | null;
  turns?: number | null;
}

/**
 * 准入时从 DB 读出的续聊状态。worker 只拿 job 里的 id，用它决定
 * 本次是空会话、resume 还是先 fork 再 resume。
 */
export interface ConversationSdkState {
  sdkSessionId: string | null;
  /** 分支建立时记录的待分叉历史点；非空表示本轮必须先 fork。 */
  forkFromSdkMessageUuid: string | null;
}

// id 由调用方生成（TypeID），db 层只负责持久化。
export async function agentExists(db: Database, agentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return rows.length > 0;
}

export async function agentEnabled(db: Database, agentId: string): Promise<boolean> {
  const rows = await db
    .select({ enabled: agents.enabled })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return rows[0]?.enabled ?? false;
}

export async function createConversation(
  db: Database | Tx,
  input: { id: string; agentId: string; title: string },
): Promise<Conversation> {
  const [row] = await db
    .insert(conversations)
    .values({ id: input.id, agentId: input.agentId, title: input.title })
    .returning();
  if (!row) throw new Error('conversation insert returned no row');
  return row;
}

/** 只改标题：lastMessageAt 由 messages 触发器维护，这里不动。 */
export async function renameConversation(
  db: Database,
  conversationId: string,
  title: string,
): Promise<Conversation | null> {
  const [row] = await db
    .update(conversations)
    .set({ title })
    .where(eq(conversations.id, conversationId))
    .returning();
  return row ?? null;
}

export async function getConversation(
  db: Database | Tx,
  conversationId: string,
): Promise<Conversation | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row ?? null;
}

/**
 * 删除会话及其消息/运行（FK 级联）；Fork 出来的子会话靠 parent_id set null 保留。
 * 锁序与 admitChatRun 一致（agents key share → conversations update），否则外键检查会和准入死锁。
 */
export async function deleteConversation(db: Database, conversationId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ agentId: conversations.agentId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!row) return false;

    await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, row.agentId))
      .limit(1)
      .for('key share');

    const [locked] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .for('update');
    if (!locked) return false;

    const [active] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.conversationId, conversationId),
          inArray(agentRuns.status, ['queued', 'running']),
        ),
      )
      .limit(1);
    if (active) fail('CONFLICT', '该会话仍有运行未结束，请等待完成或取消后再删除');

    await tx.delete(conversations).where(eq(conversations.id, conversationId));
    return true;
  });
}

export interface ListMessagesOptions {
  /** 只取最新 N 条（按 created_at, id 倒序取，仍按正序返回）。 */
  limit?: number;
  /** 游标：只取这条消息之前的历史，配合 limit 做向前分页。 */
  before?: string;
}

/**
 * 不传 limit 时返回整段历史（branch 需要全部消息复制）；
 * 传 limit 时只取最新 N 条，避免把 tool 消息的大 jsonb 全量带给页面。
 */
export async function listMessages(
  db: Database | Tx,
  conversationId: string,
  options: ListMessagesOptions = {},
): Promise<Message[]> {
  const filters: SQL[] = [eq(messages.conversationId, conversationId)];
  if (options.before !== undefined) {
    // 行值比较正好命中 (conversation_id, created_at, id) 索引；游标也限定在本会话。
    filters.push(sql`(${messages.createdAt}, ${messages.id}) < (
      select b.created_at, b.id from ${messages} b
      where b.id = ${options.before} and b.conversation_id = ${conversationId}
    )`);
  }
  const query = db
    .select()
    .from(messages)
    .where(and(...filters));
  if (options.limit === undefined) {
    return query.orderBy(asc(messages.createdAt), asc(messages.id));
  }
  const rows = await query
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(options.limit);
  return rows.reverse();
}

/** 一组 run 的读数：会话历史里每条回复都按 run_id 回填同一行读数。 */
export interface RunMetricsRow {
  id: string;
  status: RunStatus;
  turns: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  error: string | null;
  endedAt: Date | null;
}

/** 历史消息只带 run_id，读数要按 id 批量取，不能逐条查。 */
export async function listRunMetrics(db: Database, runIds: string[]): Promise<RunMetricsRow[]> {
  if (runIds.length === 0) return [];
  return db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      turns: agentRuns.turns,
      latencyMs: agentRuns.latencyMs,
      inputTokens: agentRuns.inputTokens,
      outputTokens: agentRuns.outputTokens,
      costUsd: agentRuns.costUsd,
      error: agentRuns.error,
      endedAt: agentRuns.endedAt,
    })
    .from(agentRuns)
    .where(inArray(agentRuns.id, runIds));
}

/** 分页游标必须属于本会话；否则行值比较会静默取整段历史。 */
export async function messageInConversation(
  db: Database,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * 下载入口的唯一成员校验：附件 id 必须被本会话的某条消息引用。
 * JSONB containment 先缩小到候选行，再用共享 schema 校验出精确元数据。
 */
export async function findConversationAttachment(
  db: Database,
  conversationId: string,
  attachmentId: string,
): Promise<MessageAttachment | null> {
  const rows = await db
    .select({ content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        sql`${messages.content}->'attachments' @> ${JSON.stringify([{ id: attachmentId }])}::jsonb`,
      ),
    )
    .limit(1);
  return (
    messageAttachments(rows[0]?.content).find((attachment) => attachment.id === attachmentId) ??
    null
  );
}

/** 分支复制用：一批来源消息实际引用的附件 id，去重后保持首次出现顺序。 */
export async function attachmentIdsForMessages(
  db: Database,
  messageIds: string[],
): Promise<string[]> {
  if (messageIds.length === 0) return [];
  const rows = await db
    .select({ content: messages.content })
    .from(messages)
    .where(inArray(messages.id, messageIds));
  return [...new Set(rows.flatMap((row) => messageAttachments(row.content).map(({ id }) => id)))];
}

const INSERT_CHUNK = 500;

export type MessageInsert = typeof messages.$inferInsert;

/** 一个 run 的消息逐行 insert 会有上千次往返；按 500 行一条语句批量写。 */
export async function insertMessages(db: Database | Tx, rows: MessageInsert[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db.insert(messages).values(rows.slice(i, i + INSERT_CHUNK));
  }
}

/** 消息正文只在 content.text 里；tool 消息没有该字段。 */
export function messageText(content: unknown): string | null {
  if (typeof content !== 'object' || content === null || !('text' in content)) return null;
  return typeof content.text === 'string' ? content.text : null;
}

/**
 * 续聊状态：worker 只拿到 job 里的 id，靠这里决定空会话 / resume / 先 fork。
 * 分支会话在首轮运行前 sdkSessionId 仍指向来源会话，fork 完成后由运行收尾改写。
 */
export async function getConversationSdkState(
  db: Database | Tx,
  conversationId: string,
): Promise<ConversationSdkState | null> {
  const [row] = await db
    .select({
      sdkSessionId: conversations.sdkSessionId,
      forkFromSdkMessageUuid: conversations.forkFromSdkMessageUuid,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row) return null;
  return row;
}

/** 分支首轮需要重映射的页面消息 uuid（该会话已保存、且有 SDK uuid 的那些）。 */
export async function listConversationMessageUuids(
  db: Database | Tx,
  conversationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ uuid: messages.sdkMessageUuid })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), isNotNull(messages.sdkMessageUuid)));
  return rows.flatMap((row) => (row.uuid === null ? [] : [row.uuid]));
}

/**
 * 从原会话复制消息到新会话，并把新会话指向来源 SDK 会话与分叉点：
 * 首次运行时先 fork 到该点，再继续对话。fromMessageId 为空时复制全部；
 * 原会话、分支点或 SDK 会话缺失时抛业务错误（没有文本历史回退）。
 */
export async function branchConversation(
  db: Database,
  input: { id: string; conversationId: string; fromMessageId?: string; title?: string },
): Promise<{
  conversation: Conversation;
  copied: number;
  /** 来源消息 id → 分支新消息 id；调用方据此复制历史边界内的文件快照。 */
  messageIds: Record<string, string>;
} | null> {
  return db.transaction(async (tx) => {
    const source = await getConversation(tx, input.conversationId);
    if (!source) return null;

    // 按 (createdAt, id) 排序后截断，与 listMessages 一致。
    const rows = await listMessages(tx, source.id);
    let cutoffIndex = rows.length - 1;
    if (input.fromMessageId !== undefined) {
      cutoffIndex = rows.findIndex((row) => row.id === input.fromMessageId);
      if (cutoffIndex < 0) return null;
    }
    const copy = rows.slice(0, cutoffIndex + 1);
    const forkPoint = copy.at(-1)?.sdkMessageUuid ?? null;
    // 非空历史必须能对应到 SDK transcript：否则只能拼文本，而平台已不保留该路径。
    if (copy.length > 0 && source.sdkSessionId === null) {
      fail('CONFLICT', '该会话还没有可用的 SDK 会话记录，无法按历史点分支；请重新对话后再试');
    }
    if (copy.length > 0 && !copy.every((row) => row.sdkMessageUuid !== null)) {
      // 旧版本会话的消息永远拿不到 uuid；不要把「等运行完成」当成可解决的问题。
      fail(
        'CONFLICT',
        '该会话的历史消息没有 SDK 会话记录（来自旧版本或 SDK 会话已丢失），无法按历史点分支',
      );
    }

    const [conversation] = await tx
      .insert(conversations)
      .values({
        id: input.id,
        agentId: source.agentId,
        title: input.title ?? source.title,
        parentId: source.id,
        branchOfMessageId: copy.at(-1)?.id ?? null,
        // 分叉前仍指向来源会话；首轮运行 fork 成功后改写为新 session。
        sdkSessionId: source.sdkSessionId,
        forkFromSdkMessageUuid: forkPoint,
      })
      .returning();
    if (!conversation) throw new Error('conversation insert returned no row');

    const messageIds: Record<string, string> = {};
    if (copy.length > 0) {
      const copies = copy.map((row) => {
        const id = newId('message');
        messageIds[row.id] = id;
        return {
          id,
          conversationId: conversation.id,
          role: row.role,
          content: row.content,
          runId: null,
          // 复制的是来源会话的 uuid；fork 后由运行收尾统一重映射到新 session。
          sdkMessageUuid: row.sdkMessageUuid,
          // 生成式 UI 的渲染快照必须跟着走：否则分支里的界面会退回围栏源码、表单状态全丢。
          uiFormat: row.uiFormat,
          uiProgram: row.uiProgram,
          uiState: row.uiState,
          createdAt: row.createdAt,
        };
      });
      await insertMessages(tx, copies);
    }

    return { conversation, copied: copy.length, messageIds };
  });
}

export interface ConversationSummary {
  id: string;
  agentId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessage: { role: string; text: string; createdAt: Date } | null;
}

/** 会话列表：updatedAt 取最后一条消息时间，无消息时退回创建时间。 */
export async function listConversations(
  db: Database,
  options: { agentId?: string; limit?: number } = {},
): Promise<ConversationSummary[]> {
  // 先按 last_message_at 取一页会话（由 messages 触发器维护），lateral 只对这几行求最后一条消息。
  // 直接 lateral + orderBy 会把子查询跑遍全表（N 个会话 × messages 扫描）。
  const page = db
    .select({
      id: conversations.id,
      agentId: conversations.agentId,
      title: conversations.title,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(options.agentId === undefined ? undefined : eq(conversations.agentId, options.agentId))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(options.limit ?? 50)
    .as('page');

  const last = db
    .select({
      role: messages.role,
      // 列表不需要完整消息体；只取文本并截断，避免把大 jsonb 带进列表响应。
      text: sql<string | null>`left(${messages.content}->>'text', 280)`.as('text'),
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, page.id))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1)
    .as('last_message');

  // 行的顺序已由 page 的子查询确定，外层不再排序。
  const rows = await db
    .select({
      id: page.id,
      agentId: page.agentId,
      title: page.title,
      createdAt: page.createdAt,
      lastRole: last.role,
      lastText: last.text,
      lastCreatedAt: last.createdAt,
    })
    .from(page)
    .leftJoinLateral(last, sql`true`);

  return rows.map(({ lastRole, lastText, lastCreatedAt, ...row }) => ({
    ...row,
    updatedAt: lastCreatedAt ?? row.createdAt,
    lastMessage:
      lastCreatedAt === null || lastRole === null
        ? null
        : { role: lastRole, text: lastText ?? '', createdAt: lastCreatedAt },
  }));
}

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
      .where(and(agentFilter, cursorFilter))
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
    for (const row of result.rows) {
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

export async function appendMessage(
  db: Database | Tx,
  input: {
    id: string;
    conversationId: string;
    role: string;
    content: unknown;
    runId?: string;
    sdkMessageUuid?: string;
  },
): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values({
      id: input.id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      runId: input.runId ?? null,
      ...(input.sdkMessageUuid === undefined ? {} : { sdkMessageUuid: input.sdkMessageUuid }),
    })
    .returning();
  if (!row) throw new Error('message insert returned no row');
  return row;
}

export async function createRun(
  db: Database | Tx,
  input: {
    id: string;
    conversationId: string;
    agentId: string;
    trigger?: 'chat' | 'mcp' | 'schedule' | 'event';
    agentVersion?: number | null;
  },
): Promise<AgentRun> {
  const [row] = await db
    .insert(agentRuns)
    .values({
      id: input.id,
      conversationId: input.conversationId,
      agentId: input.agentId,
      status: 'queued',
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
      ...(input.agentVersion === undefined ? {} : { agentVersion: input.agentVersion }),
    })
    .returning();
  if (!row) throw new Error('agent run insert returned no row');
  return row;
}

/** 先锁会话再检查活动运行，让后续入场看到前一个事务的提交。 */
export async function admitChatRun(
  db: Database,
  input: {
    agentId: string;
    message: string;
    conversationId?: string;
    trigger?: 'chat' | 'mcp' | 'schedule' | 'event';
    agentVersion?: number;
    /** 新会话标题；缺省取消息前 80 字。非浏览器入口用它标明来源。 */
    title?: string;
    /** 用户消息的完整 content；缺省等价于 `{ type: 'text', text: input.message }`。 */
    userContent?: unknown;
  },
): Promise<{
  run: AgentRun;
  conversationId: string;
  inherited: string[];
  /** 本轮用户消息的 SDK uuid；runner 用它发送首条用户消息。 */
  userMessageUuid: string;
}> {
  return db.transaction(async (tx) => {
    // 锁序：先 agents 再 conversations；反向会和 agent_runs 的外键检查形成删除死锁。
    const [owner] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1)
      .for('key share');
    if (!owner) fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请刷新后重新选择');

    let conversationId: string;
    if (input.conversationId === undefined) {
      conversationId = newId('conversation');
      await createConversation(tx, {
        id: conversationId,
        agentId: input.agentId,
        title: input.title ?? input.message.slice(0, 80),
      });
    } else {
      conversationId = input.conversationId;
      const [conversation] = await tx
        .select({ agentId: conversations.agentId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1)
        .for('update');
      if (!conversation || conversation.agentId !== input.agentId) {
        fail('CONVERSATION_NOT_FOUND', '会话不存在或不属于该智能体；请从会话列表重新打开');
      }
    }

    const [active] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.conversationId, conversationId),
          inArray(agentRuns.status, ['queued', 'running']),
        ),
      )
      .limit(1);
    if (active) fail('CONFLICT', '该会话仍有运行未结束，请等待完成或取消后再发送');

    const run = await createRun(tx, {
      id: newId('run'),
      conversationId,
      agentId: input.agentId,
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
      ...(input.agentVersion === undefined ? {} : { agentVersion: input.agentVersion }),
    });
    // 批准原先绑定单次 run；重发消息会新建 run，这里把上一 run 的已批准工具带过来。
    const inherited = await inheritApprovals(tx, { conversationId, runId: run.id });
    // 页面消息的 SDK 身份由平台生成：runner 用它发首条用户消息，后续按点 fork 依赖它。
    const userMessageUuid = randomUUID();
    await appendMessage(tx, {
      id: newId('message'),
      conversationId,
      role: 'user',
      content: input.userContent ?? { type: 'text', text: input.message },
      runId: run.id,
      sdkMessageUuid: userMessageUuid,
    });

    return { run, conversationId, inherited, userMessageUuid };
  });
}

/** 运行收尾：同一事务里更新会话的 SDK 状态并重映射消息 uuid（fork 会换 uuid）。 */
export async function saveSdkState(
  db: Database | Tx,
  input: {
    conversationId: string;
    sdkSessionId: string;
    /** fork 前的旧 uuid → 新 uuid；非 fork 轮为空。 */
    uuidMap?: Array<{ from: string; to: string }>;
  },
): Promise<void> {
  await db
    .update(conversations)
    .set({ sdkSessionId: input.sdkSessionId, forkFromSdkMessageUuid: null })
    .where(eq(conversations.id, input.conversationId));
  if (input.uuidMap === undefined || input.uuidMap.length === 0) return;
  const map = sql.join(
    input.uuidMap.map(({ from, to }) => sql`(${from}::text, ${to}::text)`),
    sql`, `,
  );
  await db.execute(sql`
    update ${messages} m
    set sdk_message_uuid = v.to_uuid
    from (values ${map}) as v(from_uuid, to_uuid)
    where m.conversation_id = ${input.conversationId}
      and m.sdk_message_uuid = v.from_uuid
  `);
}

export async function getRun(db: Database, runId: string): Promise<AgentRun | null> {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  return row ?? null;
}

export async function updateRun(
  db: Database,
  runId: string,
  patch: RunPatch,
): Promise<AgentRun | null> {
  if (Object.keys(patch).length === 0) return getRun(db, runId);
  const [row] = await db.update(agentRuns).set(patch).where(eq(agentRuns.id, runId)).returning();
  return row ?? null;
}

/** 已结束的 run 不能被取消覆盖。 */
export async function cancelRun(db: Database, runId: string): Promise<AgentRun | null> {
  const [row] = await db
    .update(agentRuns)
    .set({ status: 'cancelled', endedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ['queued', 'running'])))
    .returning();
  return row ?? null;
}
