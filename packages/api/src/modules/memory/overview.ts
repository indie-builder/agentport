import { type Database, repo, schema } from '@agentport/db';
import {
  AGENT_MEMORY_MAX_BYTES,
  AGENT_MEMORY_MAX_LINES,
  type AgentMemoryAssembly,
  type AgentMemoryOverview,
  countMemoryLines,
  DEFAULT_MEMORY_POLICY,
  INDEX_FILE_NAME,
  MEMORY_TOPIC_STALE_DAYS,
  type MemoryFile,
  type MemoryHealth,
  type MemoryPolicy,
  memoryIndexLinksFile,
  PERSONAL_MEMORY_FILENAME,
  PERSONAL_MEMORY_MAX_CHARS,
} from '@agentport/shared';
import { asc, eq } from 'drizzle-orm';
import { listMemoryFiles, readMemoryFile } from '../agents/memory-files.js';
import { readPersonalMemory } from './personal.js';

/** 索引行数/大小的预警线：行数 90%，大小 22 KiB（低于 25 KiB 硬上限约 12%）。 */
const INDEX_LINES_NEAR = Math.ceil(AGENT_MEMORY_MAX_LINES * 0.9);
const INDEX_BYTES_NEAR = 22 * 1024;
/** 账本与文件时间戳的容忍差：平台写入与文件 mtime 不要求完全相等。 */
const UNACCOUNTED_TOLERANCE_MS = 60_000;
/** 概览里最近变更条数。 */
const RECENT_CHANGE_LIMIT = 5;
/** 最近变更摘要只展示首个非空行的前 120 个字符。 */
const RECENT_CHANGE_SUMMARY_CHARS = 120;

function utf8Bytes(content: string | null): number {
  return content === null ? 0 : Buffer.byteLength(content, 'utf8');
}

/** 个人记忆上限按 Unicode 码点计，概览沿用同一口径。 */
function charCount(content: string): number {
  return [...content].length;
}

function topicsOf(files: MemoryFile[]): MemoryFile[] {
  return files.filter((file) => file.name !== INDEX_FILE_NAME);
}

/** 主题文件（非 MEMORY.md）数量；记忆策略上限与提案入口共用这一口径。 */
export async function countMemoryTopics(workspacesDir: string, slug: string): Promise<number> {
  return topicsOf((await listMemoryFiles(workspacesDir, slug)).files).length;
}

async function resolvePolicy(db: Database, agentId: string): Promise<MemoryPolicy> {
  return (await repo.agents.getAgentMemoryPolicy(db, agentId)) ?? DEFAULT_MEMORY_POLICY;
}

function namedList(names: string[], limit = 3): string {
  const listed = names.slice(0, limit).join('、');
  return names.length > limit ? `${listed} 等 ${names.length} 个` : listed;
}

/** 行数与字节两组预警同时命中时只保留更严重的一条，避免同一问题刷两条。 */
function indexSizeHealth(lines: number, bytes: number): MemoryHealth[] {
  const linesEntry: MemoryHealth | null =
    lines >= AGENT_MEMORY_MAX_LINES
      ? {
          code: 'index_lines_full',
          level: 'danger',
          title: '记忆索引超过行数上限',
          detail: `MEMORY.md 共 ${lines} 行，上限 ${AGENT_MEMORY_MAX_LINES} 行。`,
        }
      : lines >= INDEX_LINES_NEAR
        ? {
            code: 'index_lines_near',
            level: 'warn',
            title: '记忆索引接近行数上限',
            detail: `MEMORY.md 共 ${lines} 行，接近上限 ${AGENT_MEMORY_MAX_LINES} 行。`,
          }
        : null;
  const bytesEntry: MemoryHealth | null =
    bytes >= AGENT_MEMORY_MAX_BYTES
      ? {
          code: 'index_bytes_full',
          level: 'danger',
          title: '记忆索引超过大小上限',
          detail: `MEMORY.md 共 ${bytes} 字节，上限 ${AGENT_MEMORY_MAX_BYTES} 字节。`,
        }
      : bytes >= INDEX_BYTES_NEAR
        ? {
            code: 'index_bytes_near',
            level: 'warn',
            title: '记忆索引接近大小上限',
            detail: `MEMORY.md 共 ${bytes} 字节，接近上限 ${AGENT_MEMORY_MAX_BYTES} 字节。`,
          }
        : null;
  if (linesEntry === null) return bytesEntry === null ? [] : [bytesEntry];
  if (bytesEntry === null) return [linesEntry];
  return bytesEntry.level === 'danger' && linesEntry.level !== 'danger'
    ? [bytesEntry]
    : [linesEntry];
}

interface HealthInput {
  policy: MemoryPolicy;
  index: { present: boolean; lines: number; bytes: number };
  topics: { count: number; unlinked: string[]; stale: string[] };
  personalChars: number;
  unaccounted: number;
}

/** 健康提示顺序固定；全部由已有数据算出，不做任何推测性判断。 */
function buildHealth(input: HealthInput): MemoryHealth[] {
  const { policy, index, topics, personalChars, unaccounted } = input;
  // 停用只影响主会话记忆：索引与主题的加载类提示不再适用，子智能体记忆不受影响。
  if (!policy.enabled) {
    return [
      {
        code: 'policy_disabled',
        level: 'ok',
        title: '专家记忆已停用',
        detail: '该专家主会话运行时不挂载、不加载主会话记忆；子智能体记忆不受此开关约束。',
      },
    ];
  }

  const health: MemoryHealth[] = [];
  if (!index.present) {
    health.push({
      code: 'index_missing',
      level: 'warn',
      title: '缺少记忆索引',
      detail: '还没有 MEMORY.md，主题不会随运行自动加载。',
    });
  }
  health.push(...indexSizeHealth(index.lines, index.bytes));
  if (topics.unlinked.length > 0) {
    health.push({
      code: 'topics_unlinked',
      level: 'danger',
      title: '主题没有进入索引',
      detail: `索引未链接：${namedList(topics.unlinked)}`,
    });
  }
  if (topics.stale.length > 0) {
    health.push({
      code: 'topics_stale',
      level: 'warn',
      title: '主题长期未更新',
      detail: `超过 ${MEMORY_TOPIC_STALE_DAYS} 天未更新：${namedList(topics.stale)}`,
    });
  }
  if (topics.count > policy.topicLimit) {
    health.push({
      code: 'topics_over_limit',
      level: 'danger',
      title: '主题数量超过上限',
      detail: `现有 ${topics.count} 个主题，上限 ${policy.topicLimit} 个。`,
    });
  } else if (topics.count >= Math.ceil(policy.topicLimit * 0.9)) {
    health.push({
      code: 'topics_over_limit',
      level: 'warn',
      title: '主题数量接近上限',
      detail: `现有 ${topics.count} 个主题，上限 ${policy.topicLimit} 个。`,
    });
  }
  if (personalChars >= Math.ceil(PERSONAL_MEMORY_MAX_CHARS * 0.9)) {
    health.push({
      code: 'personal_near_limit',
      level: 'warn',
      title: '个人记忆接近上限',
      detail: `当前用户个人记忆 ${personalChars} 个字符，上限 ${PERSONAL_MEMORY_MAX_CHARS} 个字符。`,
    });
  }
  if (unaccounted > 0) {
    health.push({
      code: 'unaccounted_changes',
      level: 'warn',
      title: '存在未记账的记忆改动',
      detail: `有 ${unaccounted} 个记忆文件的更新时间晚于最近一次平台写入，可能由模型直接写入。`,
    });
  }
  if (health.length === 0) {
    health.push({
      code: 'healthy',
      level: 'ok',
      title: '记忆状态正常',
      detail: '索引、主题、规则与账本都没有需要处理的问题。',
    });
  }
  return health;
}

/**
 * 未记账文件：按每个文件最近一次平台写入时间与 mtime 比较；SDK 原生写入不进账本，
 * 因此晚于最近一次记账超过容忍差即为未记账。从未记账的文件同样计入。
 */
function unaccountedFiles(files: MemoryFile[], latest: Map<string, Date>): string[] {
  return files
    .filter((file) => {
      const accountedAt = latest.get(file.name)?.getTime();
      if (accountedAt === undefined) return true;
      const updatedAt = file.updatedAt === null ? 0 : Date.parse(file.updatedAt);
      return updatedAt - accountedAt > UNACCOUNTED_TOLERANCE_MS;
    })
    .map((file) => file.name);
}

/** 最近变更只回轻量投影：变更后正文的首个非空行去掉 Markdown 标题符号，截断到 120 个字符。 */
function recentChange(
  row: repo.memoryChanges.MemoryChangeRow,
): AgentMemoryOverview['recentChanges'][number] {
  const name = row.target.kind === 'agent_memory' ? row.target.name : '';
  const firstLine =
    (row.after.content ?? '')
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim()
      .replace(/^#{1,6}\s*/, '') ?? '';
  return {
    name,
    createdAt: row.createdAt.toISOString(),
    summary: [...firstLine].slice(0, RECENT_CHANGE_SUMMARY_CHARS).join(''),
  };
}

export interface MemoryReadInput {
  db: Database;
  workspacesDir: string;
  agentId: string;
  slug: string;
  businessId: string;
}

export async function buildMemoryOverview(input: MemoryReadInput): Promise<AgentMemoryOverview> {
  const { db, workspacesDir, agentId, slug, businessId } = input;
  const policy = await resolvePolicy(db, agentId);
  const files = (await listMemoryFiles(workspacesDir, slug)).files;
  const indexContent = files.some((file) => file.name === INDEX_FILE_NAME)
    ? ((await readMemoryFile(workspacesDir, slug, INDEX_FILE_NAME))?.content ?? null)
    : null;
  const topics = topicsOf(files);
  const lines = indexContent === null ? 0 : countMemoryLines(indexContent);
  const bytes = utf8Bytes(indexContent);
  // 没有索引时所有主题都不可达，但根因是缺索引，不重复报「未链接」。
  const unlinked =
    indexContent === null
      ? []
      : topics
          .filter((topic) => !memoryIndexLinksFile(indexContent, topic.name))
          .map((topic) => topic.name);
  const staleBefore = Date.now() - MEMORY_TOPIC_STALE_DAYS * 86_400_000;
  const stale = topics
    .filter((topic) => topic.updatedAt !== null && Date.parse(topic.updatedAt) < staleBefore)
    .map((topic) => topic.name);

  const rules = await db
    .select({ content: schema.agentRules.content })
    .from(schema.agentRules)
    .where(eq(schema.agentRules.agentId, agentId))
    .orderBy(asc(schema.agentRules.slug));
  const personalChars = charCount((await readPersonalMemory(db, businessId)).content);
  const accountedAt = await repo.memoryChanges.latestCreatedAtByTarget(db, agentId, 'agent_memory');
  const unaccounted = unaccountedFiles(files, accountedAt);
  const [recentChanges, changesTotal] = await Promise.all([
    repo.memoryChanges.listFiltered(db, {
      agentId,
      kind: 'agent_memory',
      limit: RECENT_CHANGE_LIMIT,
    }),
    repo.memoryChanges.countFiltered(db, { agentId, kind: 'agent_memory' }),
  ]);
  const index = {
    present: indexContent !== null,
    lines,
    bytes,
    maxLines: AGENT_MEMORY_MAX_LINES,
    maxBytes: AGENT_MEMORY_MAX_BYTES,
  };
  const topicStats = {
    count: topics.length,
    bytes: topics.reduce((total, topic) => total + topic.size, 0),
    unlinked,
    stale,
  };

  return {
    policy,
    index,
    topics: topicStats,
    rules: {
      count: rules.length,
      bytes: rules.reduce((total, rule) => total + utf8Bytes(rule.content), 0),
    },
    personal: { chars: personalChars, maxChars: PERSONAL_MEMORY_MAX_CHARS },
    unaccounted: { count: unaccounted.length, names: unaccounted },
    health: buildHealth({
      policy,
      index,
      topics: topicStats,
      personalChars,
      unaccounted: unaccounted.length,
    }),
    recentChanges: recentChanges.map(recentChange),
    changesTotal,
  };
}

/** 运行期装配：personal → index → rules（按 slug） → topics（按名称）；只描述不改文件。 */
export async function buildMemoryAssembly(input: MemoryReadInput): Promise<AgentMemoryAssembly> {
  const { db, workspacesDir, agentId, slug, businessId } = input;
  const policy = await resolvePolicy(db, agentId);
  const files = (await listMemoryFiles(workspacesDir, slug)).files;
  const indexContent = files.some((file) => file.name === INDEX_FILE_NAME)
    ? ((await readMemoryFile(workspacesDir, slug, INDEX_FILE_NAME))?.content ?? null)
    : null;
  const topics = topicsOf(files);
  const rules = await db
    .select({
      slug: schema.agentRules.slug,
      content: schema.agentRules.content,
      globs: schema.agentRules.globs,
    })
    .from(schema.agentRules)
    .where(eq(schema.agentRules.agentId, agentId))
    .orderBy(asc(schema.agentRules.slug));
  const personalChars = charCount((await readPersonalMemory(db, businessId)).content);

  // 个人记忆由 injectPersonalMemory 独立控制：专家记忆停用不代表个人记忆不投影。
  const personalSkipped = !policy.injectPersonalMemory
    ? '策略未注入个人记忆'
    : personalChars === 0
      ? '当前用户还没有个人记忆'
      : null;
  const indexSkipped = !policy.enabled
    ? '专家记忆已停用'
    : indexContent === null
      ? '还没有 MEMORY.md 索引'
      : null;
  // 项目规则只由 injectRules 决定：运行期不读 enabled，停用记忆不影响规则渲染。
  const rulesSkipped = policy.injectRules ? null : '该专家运行时不渲染项目规则';
  const topicsSkipped = !policy.enabled ? '专家记忆已停用' : null;

  const blocks: AgentMemoryAssembly['blocks'] = [
    {
      kind: 'personal',
      name: PERSONAL_MEMORY_FILENAME,
      path: '/mnt/user/CLAUDE.md',
      chars: personalChars,
      lines: null,
      trigger: personalSkipped === null ? 'every-run' : 'skipped',
      reason: personalSkipped,
      globs: null,
    },
    {
      kind: 'index',
      name: INDEX_FILE_NAME,
      path: '/mnt/agent-memory/MEMORY.md',
      chars: utf8Bytes(indexContent),
      lines: indexContent === null ? null : countMemoryLines(indexContent),
      trigger: indexSkipped === null ? 'every-run' : 'skipped',
      reason: indexSkipped,
      globs: null,
    },
    ...rules.map((rule) => ({
      kind: 'rule' as const,
      name: rule.slug,
      path: `/workspace/.claude/rules/${rule.slug}.md`,
      chars: utf8Bytes(rule.content),
      lines: countMemoryLines(rule.content),
      trigger: rulesSkipped === null ? ('every-run' as const) : ('skipped' as const),
      reason: rulesSkipped,
      globs: rule.globs,
    })),
    ...topics.map((topic) => ({
      kind: 'topic' as const,
      name: topic.name,
      path: `/mnt/agent-memory/${topic.name}`,
      chars: topic.size,
      lines: null,
      trigger: topicsSkipped === null ? ('on-demand' as const) : ('skipped' as const),
      reason: topicsSkipped,
      globs: null,
    })),
  ];

  const loaded = blocks.filter((block) => block.trigger !== 'skipped');
  const loadedBytes = (kind: AgentMemoryAssembly['blocks'][number]['kind']): number =>
    loaded.filter((block) => block.kind === kind).reduce((total, block) => total + block.chars, 0);
  return {
    blocks,
    totals: {
      personalChars: loadedBytes('personal'),
      indexBytes: loadedBytes('index'),
      rulesBytes: loadedBytes('rule'),
      topicBytes: loadedBytes('topic'),
    },
    notes: ['频道与服务主体由运行期固定不注入个人记忆。'],
  };
}
