import type { RuntimeEnvironmentVersionStatus } from '@agentport/shared';
import {
  DEFAULT_RUNTIME_DOCKERFILE,
  runtimeEnvironmentVersionStatusSchema,
} from '@agentport/shared';
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

export const runtimeEnvironmentVersions = pgTable(
  'runtime_environment_versions',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references((): AnyPgColumn => runtimeEnvironments.id, { onDelete: 'restrict' }),
    dockerfile: text('dockerfile').notNull(),
    baseImageId: text('base_image_id').notNull(),
    status: text('status', {
      enum: runtimeEnvironmentVersionStatusSchema.options as [
        RuntimeEnvironmentVersionStatus,
        ...RuntimeEnvironmentVersionStatus[],
      ],
    })
      .notNull()
      .default('queued'),
    imageTag: text('image_tag'),
    imageId: text('image_id'),
    buildLog: text('build_log').notNull().default(''),
    logTruncated: boolean('log_truncated').notNull().default(false),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('runtime_environment_versions_id_environment_idx').on(t.id, t.environmentId),
    index('runtime_environment_versions_environment_created_idx').on(
      t.environmentId,
      t.createdAt,
      t.id,
    ),
    check(
      'runtime_environment_versions_status_check',
      sql`${t.status} in (${sql.raw(runtimeEnvironmentVersionStatusSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'runtime_environment_versions_ready_image_check',
      sql`${t.status} <> 'ready' or ${t.imageId} is not null`,
    ),
  ],
);

export const runtimeEnvironments = pgTable(
  'runtime_environments',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    dockerfile: text('dockerfile').notNull().default(DEFAULT_RUNTIME_DOCKERFILE),
    isDefault: boolean('is_default').notNull().default(false),
    onlineVersionId: text('online_version_id'),
    ownerBusinessId: text('owner_business_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('runtime_environments_name_idx').on(t.name),
    uniqueIndex('runtime_environments_default_idx')
      .on(t.isDefault)
      .where(sql`${t.isDefault} = true`),
    foreignKey({
      columns: [t.onlineVersionId, t.id],
      foreignColumns: [runtimeEnvironmentVersions.id, runtimeEnvironmentVersions.environmentId],
      name: 'runtime_environments_online_version_fk',
    }),
  ],
);
