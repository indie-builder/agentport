import { sql } from 'drizzle-orm';
import {
  agentMembers,
  agentRuns,
  agentSchedules,
  agents,
  authUsers,
  conversations,
  evalCases,
  evalRuns,
  memoryChanges,
  memoryReviews,
  messages,
  userPreferences,
  userRoles,
} from '../schema.js';
import type { DbHandle } from './access.js';

/**
 * 历史业务身份的并集：没有身份登记表，登记事实来自认证账户与全部业务关联。
 * 角色/成员残留必须算作登记，否则删除认证资料后无法恢复原授权。
 */
const identityIds = sql`
  select ${authUsers.businessId} as business_id from ${authUsers}
  union select ${userRoles.businessId} from ${userRoles}
  union select ${agents.createdBy} from ${agents}
  union select ${agents.ownerBusinessId} from ${agents}
  union select ${agentMembers.businessId} from ${agentMembers}
  union select ${conversations.createdBy} from ${conversations}
    where ${conversations.createdBy} is not null
  union select ${messages.senderBusinessId} from ${messages}
    where ${messages.senderBusinessId} is not null
  union select ${agentRuns.initiatedBy} from ${agentRuns}
    where ${agentRuns.initiatedBy} is not null
  union select ${agentSchedules.createdBy} from ${agentSchedules}
  union select ${agentSchedules.executeAsBusinessId} from ${agentSchedules}
  union select ${evalCases.createdBy} from ${evalCases}
  union select ${evalRuns.createdBy} from ${evalRuns}
  union select ${userPreferences.businessId} from ${userPreferences}
  union select ${memoryReviews.businessId} from ${memoryReviews}
  union select ${memoryChanges.businessId} from ${memoryChanges}
`;

function searchFilter(q: string | undefined) {
  if (q === undefined || q === '') return sql``;
  const pattern = `%${q}%`;
  return sql`where ids.business_id ilike ${pattern} or coalesce(u.name, '') ilike ${pattern}`;
}

/** 该 businessId 是否已有任何认证或业务历史（可离线）。 */
export async function hasBusinessHistory(db: DbHandle, businessId: string): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(sql`
    select exists(select 1 from (${identityIds}) ids where ids.business_id = ${businessId}) as "exists"
  `);
  return result.rows[0]?.exists === true;
}

export interface IdentitySummary {
  businessId: string;
  name: string;
  accountActive: boolean;
}

export interface IdentityList {
  items: IdentitySummary[];
  total: number;
}

/** 负责人授权成员时的候选身份；只返回业务摘要，不暴露账户凭据或角色。 */
export async function listIdentities(
  db: DbHandle,
  input: { q?: string; limit: number; offset: number },
): Promise<IdentityList> {
  const filter = searchFilter(input.q);
  const [page, total] = await Promise.all([
    db.execute<IdentitySummary & Record<string, unknown>>(sql`
      select ids.business_id as "businessId",
        coalesce(u.name, ids.business_id) as name,
        (u.id is not null and u.disabled = false) as "accountActive"
      from (${identityIds}) ids
      left join ${authUsers} u on u.business_id = ids.business_id
      ${filter}
      order by ids.business_id asc
      limit ${input.limit} offset ${input.offset}
    `),
    db.execute<{ total: number }>(sql`
      select count(*)::int as total
      from (${identityIds}) ids
      left join ${authUsers} u on u.business_id = ids.business_id
      ${filter}
    `),
  ]);
  return { items: page.rows as IdentitySummary[], total: total.rows[0]?.total ?? 0 };
}
