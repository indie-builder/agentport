import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const skills = pgTable(
  'skills',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    body: text('body').notNull().default(''),
    /** SKILL.md frontmatter 的来源描述字段，导入/安装时原样保留。 */
    license: text('license'),
    compatibility: text('compatibility'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    /** skills.sh 来源 `owner/repo/skill`；内部自建为 null。 */
    sourceId: text('source_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('skills_slug_idx').on(t.slug),
    // 同一市场技能只允许装一次；Postgres 唯一索引允许多个 NULL，内部技能不受影响。
    uniqueIndex('skills_source_id_idx').on(t.sourceId),
  ],
);

/**
 * 技能的支持资源文件（官方 SKILL.md 目录里的 scripts/、references/ 等）。
 * 每个文件落到工作区 `.claude/skills/<slug>/<path>`；path 是相对技能目录的安全相对路径。
 */
export const skillFiles = pgTable(
  'skill_files',
  {
    id: text('id').primaryKey(),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    /** 相对技能目录的路径，如 `scripts/run.sh`、`references/api.md`。 */
    path: text('path').notNull(),
    content: text('content').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('skill_files_skill_path_idx').on(t.skillId, t.path),
    index('skill_files_skill_idx').on(t.skillId),
  ],
);
