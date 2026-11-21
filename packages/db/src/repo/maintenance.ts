import { fail } from '@agentport/core';
import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  agentRuns,
  agents,
  agentVersions,
  channelMessages,
  evalRuns,
  messages,
} from '../schema.js';

export interface PruneRunsResult {
  runs: number;
  messages: number;
}

export interface PruneOptions {
  retainedMessageIds?: string[];
}

function positive(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    fail('INVALID_INPUT', `${name} must be a positive integer, got ${value}`);
  }
  return value;
}

export async function pruneAgentVersions(db: Database, keepPerAgent: number): Promise<number> {
  const keep = positive(keepPerAgent, 'keepPerAgent');
  const result = await db.execute(sql`
    delete from ${agentVersions}
    where ${agentVersions.id} in (
      select id from (
        select
          ${agentVersions.id} as id,
          row_number() over (
            partition by ${agentVersions.agentId}
            order by ${agentVersions.version} desc
          ) as rn
        from ${agentVersions}
      ) ranked
      where rn > ${keep}
    )
      and not exists (
        select 1 from agents a
        where a.id = ${agentVersions.agentId}
          and a.published_version = ${agentVersions.version}
      )
      and not exists (
        select 1 from ${agentRuns} r
        where r.agent_id = ${agentVersions.agentId}
          and r.agent_version = ${agentVersions.version}
          and r.status in ('queued', 'running')
      )
      and not exists (
        select 1
        from ${agentVersions} parent
        join ${agents} a on a.id = parent.agent_id and a.published_version = parent.version
        where parent.definition->'resources'->'subAgents' @> jsonb_build_array(
          jsonb_build_object(
            'id', ${agentVersions.agentId},
            'publishedVersion', ${agentVersions.version}
          )
        )
      )
      and not exists (
        select 1 from ${agentRuns} r
        where r.status in ('queued', 'running')
          and r.definition_snapshot->'resources'->'subAgents' @> jsonb_build_array(
            jsonb_build_object(
              'id', ${agentVersions.agentId},
              'publishedVersion', ${agentVersions.version}
            )
          )
      )
      and not exists (
        select 1
        from ${agentRuns} r
        join ${agentVersions} parent
          on parent.agent_id = r.agent_id and parent.version = r.agent_version
        where r.status in ('queued', 'running')
          and parent.definition->'resources'->'subAgents' @> jsonb_build_array(
            jsonb_build_object(
              'id', ${agentVersions.agentId},
              'publishedVersion', ${agentVersions.version}
            )
          )
      )
      and not exists (
        select 1 from ${evalRuns} e
        where e.status = 'running'
          and e.definition_snapshot->'resources'->'subAgents' @> jsonb_build_array(
            jsonb_build_object(
              'id', ${agentVersions.agentId},
              'publishedVersion', ${agentVersions.version}
            )
          )
      )
  `);
  return (result as typeof result & { count: number }).count;
}

/** 删除超过 N 天已结束的 run，以及按 run_id 关联的 messages；单语句保证原子。 */
export async function pruneRuns(
  db: Database,
  olderThanDays: number,
  options: PruneOptions = {},
): Promise<PruneRunsResult> {
  const days = positive(olderThanDays, 'olderThanDays');
  const retained = options.retainedMessageIds ?? [];
  const retainedMessages = sql`${messages.id} = any(${sql.param(db.$client.array(retained, 'TEXT'))}::text[])`;
  const result = await db.execute(sql`
    with doomed as (
      select ${agentRuns.id} as id
      from ${agentRuns}
      where ${agentRuns.status} in ('succeeded', 'failed', 'cancelled', 'timeout')
        and (
          ${agentRuns.startedAt} is null
          or ${agentRuns.startedAt} < date_trunc('month', now(), 'UTC')
          or (
            ${agentRuns.providerId} is null
            and ${agentRuns.servedProviderId} is null
          )
        )
        and coalesce(${agentRuns.endedAt}, ${agentRuns.startedAt})
          < now() - make_interval(days => ${days})
    ),
    detached as (
      update ${messages}
      set run_id = null
      where ${messages.runId} in (select id from doomed)
        and (
          ${retainedMessages}
          or (
            ${messages.role} = 'user'
            and jsonb_typeof(${messages.content}->'attachments') = 'array'
            and jsonb_array_length(${messages.content}->'attachments') > 0
          )
        )
      returning 1
    ),
    deleted as (
      delete from ${messages}
      where ${messages.runId} in (select id from doomed)
        and not ${retainedMessages}
        -- 数据修改 CTE 共享同一快照：detached 的更新对这里不可见，必须用同一保留条件排除。
        and not (
          ${messages.role} = 'user'
          and coalesce(
            case
              when jsonb_typeof(${messages.content}->'attachments') = 'array'
                then jsonb_array_length(${messages.content}->'attachments')
              else 0
            end,
            0
          ) > 0
        )
      returning 1
    ),
    pruned as (
      delete from ${agentRuns}
      where ${agentRuns.id} in (select id from doomed)
      returning 1
    )
    select
      (select count(*)::int from deleted) as messages,
      (select count(*)::int from pruned) as runs
  `);
  const row = result[0];
  return { runs: Number(row?.runs ?? 0), messages: Number(row?.messages ?? 0) };
}

/**
 * 没有 run_id 的旧消息；分支副本归会话保留，父会话删除后仍受保护。
 * 附件是用户显式交给会话的输入，没有运行也会在历史里继续引用，永不按孤儿清理。
 */
export async function pruneOrphanMessages(
  db: Database,
  olderThanDays: number,
  options: PruneOptions = {},
): Promise<number> {
  const days = positive(olderThanDays, 'olderThanDays');
  const retained = options.retainedMessageIds ?? [];
  const result = await db.execute(sql`
    delete from ${messages}
    where ${messages.runId} is null
      and ${messages.createdAt} < now() - make_interval(days => ${days})
      and not (${messages.id} = any(${sql.param(db.$client.array(retained, 'TEXT'))}::text[]))
      and coalesce(
        case
          when jsonb_typeof(${messages.content}->'attachments') = 'array'
            then jsonb_array_length(${messages.content}->'attachments')
          else 0
        end,
        0
      ) = 0
      and not exists (
        select 1 from conversations c
        where c.id = ${messages.conversationId} and c.branch_of_message_id is not null
      )
  `);
  return (result as typeof result & { count: number }).count;
}

export async function pruneChannelMessages(
  db: Database,
  olderThanDays: number,
): Promise<Array<{ id: string; channelId: string }>> {
  const days = positive(olderThanDays, 'olderThanDays');
  return db
    .delete(channelMessages)
    .where(sql`${channelMessages.createdAt} < now() - make_interval(days => ${days})`)
    .returning({ id: channelMessages.id, channelId: channelMessages.channelId });
}
