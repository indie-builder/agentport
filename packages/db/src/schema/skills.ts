import { skillStatusSchema } from '@agentport/shared';
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const skills = pgTable(
  'skills',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    body: text('body').notNull().default(''),
    license: text('license'),
    compatibility: text('compatibility'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    sourceId: text('source_id'),
    ownerBusinessId: text('owner_business_id'),
    status: text('status', {
      enum: skillStatusSchema.options as [
        (typeof skillStatusSchema.options)[number],
        ...(typeof skillStatusSchema.options)[number][],
      ],
    })
      .notNull()
      .default('published'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    reviewNote: text('review_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('skills_slug_idx').on(t.slug),
    uniqueIndex('skills_source_id_idx').on(t.sourceId),
    index('skills_status_updated_idx').on(t.status, t.updatedAt),
    check(
      'skills_status_check',
      sql`${t.status} in (${sql.raw(skillStatusSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
  ],
);

export const skillFiles = pgTable(
  'skill_files',
  {
    id: text('id').primaryKey(),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    content: text('content').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('skill_files_skill_path_idx').on(t.skillId, t.path),
    index('skill_files_skill_idx').on(t.skillId),
  ],
);
