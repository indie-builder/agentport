import { fail } from '@agentport/core';
import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { agentRuns, agentVersions, messages } from '../schema.js';

export interface PruneRunsResult {
  runs: number;
  messages: number;
}

// 0 或负数会让截止时间落在未来，必须挡住；维护任务只在配置合法时运行。
function positive(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    // 配置错误属于启动期输入问题：尽早失败，比运行期把负数当 0 用安全。
    fail('INVALID_INPUT', `${name} must be a positive integer, got ${value}`);
  }
  return value;
}

/** 每个 agent 只保留最近 N 个版本；latest 恒在保留范围内。 */
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
  `);
  return result.rowCount ?? 0;
}

/** 删除超过 N 天已结束的 run，以及按 run_id 关联的 messages；单语句保证原子。 */
export async function pruneRuns(db: Database, olderThanDays: number): Promise<PruneRunsResult> {
  const days = positive(olderThanDays, 'olderThanDays');
  const result = await db.execute(sql`
    with doomed as (
      select ${agentRuns.id} as id
      from ${agentRuns}
      where ${agentRuns.status} in ('succeeded', 'failed', 'cancelled', 'timeout')
        and coalesce(${agentRuns.endedAt}, ${agentRuns.startedAt})
          < now() - make_interval(days => ${days})
    ),
    detached as (
      update ${messages}
      set run_id = null
      where ${messages.runId} in (select id from doomed)
        and ${messages.role} = 'user'
        and jsonb_typeof(${messages.content}->'attachments') = 'array'
        and jsonb_array_length(${messages.content}->'attachments') > 0
      returning 1
    ),
    deleted as (
      delete from ${messages}
      where ${messages.runId} in (select id from doomed)
        -- 数据修改 CTE 共享同一快照：detached 的更新对这里不可见，必须显式排除。
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
  const row = result.rows[0];
  return { runs: Number(row?.runs ?? 0), messages: Number(row?.messages ?? 0) };
}

/**
 * 没有 run_id 的旧消息；分支副本归会话保留，父会话删除后仍受保护。
 * 附件是用户显式交给会话的输入，没有运行也会在历史里继续引用，永不按孤儿清理。
 */
export async function pruneOrphanMessages(db: Database, olderThanDays: number): Promise<number> {
  const days = positive(olderThanDays, 'olderThanDays');
  const result = await db.execute(sql`
    delete from ${messages}
    where ${messages.runId} is null
      and ${messages.createdAt} < now() - make_interval(days => ${days})
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
  return result.rowCount ?? 0;
}
