import { sql } from 'drizzle-orm';
import { bigserial, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    /** actor 为已认证 businessId；anonymous 时可在 metadata 记录脱敏用户名。 */
    actor: text('actor').notNull().default('system'),
    actorKind: text('actor_kind', { enum: ['user', 'service', 'anonymous', 'agent'] })
      .notNull()
      .default('service'),
    /** 跨用户读取的目标业务身份。 */
    subjectBusinessId: text('subject_business_id'),
    action: text('action').notNull(),
    target: text('target'),
    inputDigest: text('input_digest'),
    status: text('status').notNull(),
    durationMs: integer('duration_ms'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    chainSeq: bigserial('chain_seq', { mode: 'number' }).notNull(),
    prevHash: text('prev_hash'),
    hash: text('hash'),
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt),
    index('audit_log_chain_seq_idx').on(t.chainSeq),
    // action LIKE 'x%' 走 text_pattern_ops（C collation 下才能用前缀索引）；
    // 尾随列让「前缀 + 时间倒序 + id 游标」整个查询都在索引里完成。
    index('audit_log_action_created_idx').on(
      sql`${t.action} text_pattern_ops`,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
);

/** 平台首次初始化标记与角色矩阵 revision；只有一行。 */
export const platformBootstrap = pgTable(
  'platform_bootstrap',
  {
    id: text('id').primaryKey(),
    /** 首次初始化使用的业务身份；值不连 authUsers，账户可删除后重建。 */
    adminBusinessId: text('admin_business_id'),
    rolesRevision: integer('roles_revision').notNull().default(0),
    initializedAt: timestamp('initialized_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('platform_bootstrap_revision_check', sql`${t.rolesRevision} >= 0`)],
);
