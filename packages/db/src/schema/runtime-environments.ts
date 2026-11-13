import { DEFAULT_RUNTIME_DOCKERFILE } from '@agentport/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * 运行环境构建版本：一次构建一行，不可覆盖。先于 runtime_environments 声明，
 * 是为了让 environments.online_version_id 能建到本表 (id, environment_id) 的复合外键；
 * environment_id 的引用由 Drizzle 延迟解析，初始化顺序不受影响。
 */
export const runtimeEnvironmentVersions = pgTable(
  'runtime_environment_versions',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references((): AnyPgColumn => runtimeEnvironments.id, { onDelete: 'restrict' }),
    /** 入队时冻结的完整 Dockerfile。 */
    dockerfile: text('dockerfile').notNull(),
    /** 固定基座身份（本地 tag/ID），构建时传入。 */
    baseImageId: text('base_image_id').notNull(),
    status: text('status', { enum: ['queued', 'building', 'ready', 'failed'] })
      .notNull()
      .default('queued'),
    /** 仅用于定位本地镜像；创建容器使用 imageId。 */
    imageTag: text('image_tag'),
    /** 构建成功后的镜像内容 ID。 */
    imageId: text('image_id'),
    buildLog: text('build_log').notNull().default(''),
    logTruncated: boolean('log_truncated').notNull().default(false),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 复合外键的引用目标：版本只能被自己所属环境的线上指针引用。
    unique('runtime_environment_versions_id_environment_idx').on(t.id, t.environmentId),
    // 升序复合索引由 PostgreSQL 反向扫描满足 (created_at, id) 倒序分页。
    index('runtime_environment_versions_environment_created_idx').on(
      t.environmentId,
      t.createdAt,
      t.id,
    ),
    check(
      'runtime_environment_versions_status_check',
      sql`${t.status} in ('queued', 'building', 'ready', 'failed')`,
    ),
    check(
      'runtime_environment_versions_ready_image_check',
      sql`${t.status} <> 'ready' or ${t.imageId} is not null`,
    ),
  ],
);

/** 命名的运行环境：智能体绑定环境，不绑定构建版本。 */
export const runtimeEnvironments = pgTable(
  'runtime_environments',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** Dockerfile 草稿；每次构建入队时快照到版本行。 */
    dockerfile: text('dockerfile').notNull().default(DEFAULT_RUNTIME_DOCKERFILE),
    /** 平台默认环境；至多一个，由 partial unique index 保证。 */
    isDefault: boolean('is_default').notNull().default(false),
    /** 线上版本指针；发布与回退都只改这里。 */
    onlineVersionId: text('online_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('runtime_environments_name_idx').on(t.name),
    uniqueIndex('runtime_environments_default_idx')
      .on(t.isDefault)
      .where(sql`${t.isDefault} = true`),
    // 线上版本必须属于本环境：复合外键让跨环境的指针写不进来。
    foreignKey({
      columns: [t.onlineVersionId, t.id],
      foreignColumns: [runtimeEnvironmentVersions.id, runtimeEnvironmentVersions.environmentId],
      name: 'runtime_environments_online_version_fk',
    }),
  ],
);
