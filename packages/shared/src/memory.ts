import { z } from 'zod';
import { slugSchema } from './params.js';
import { runStatusSchema } from './run-state.js';
import { utf8Bytes } from './utf8.js';

/**
 * 个人记忆与记忆审核的共享契约。
 * 记忆内容本身仍落官方文件（个人记忆文件 / `agent-memory/` / `.claude/rules/`），
 * 这里只描述审核请求、提案和历史变更的形状。
 */

/** 记忆目录内的扁平 Markdown 文件名；API 参数、提案目标、journal 与 web 表单共用这一份。 */
export const memoryFileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.md$/;
export const memoryFileNameSchema = z
  .string()
  .regex(memoryFileNamePattern, '记忆文件名非法：只允许 <name>.md');

/** 官方启动只读 MEMORY.md 的前 200 行或 25KB，先到者为准；超限拒绝而非截断。 */
export const AGENT_MEMORY_MAX_LINES = 200;
export const AGENT_MEMORY_MAX_BYTES = 25 * 1024;
/** 任何记忆文件的底层大小上限。 */
export const MEMORY_FILE_MAX_BYTES = 200_000;
/** 主题文件超过该天数没有更新即视为陈旧，只提示、不自动删除。 */
export const MEMORY_TOPIC_STALE_DAYS = 60;

/** 专家记忆写入方式：`native_auto` 由 SDK auto-memory 直接写，`proposal_only` 只能经记忆提案写入。 */
const memoryWriteModeSchema = z.enum(['native_auto', 'proposal_only']);

/**
 * 专家记忆策略：只约束运行期如何挂载/注入记忆，不改变官方记忆文件本身。
 * - `enabled=false`：运行期不挂载、不加载专家记忆；新的记忆提案被拒绝（409），手工浏览/编辑仍可用。
 * - `writeMode=native_auto`：SDK auto-memory 开启，模型可直接写记忆目录。
 * - `writeMode=proposal_only`：关闭 auto-memory，运行期不可写，只能经记忆提案写入。
 * - `injectPersonalMemory=false`：该专家运行时不注入当前用户的个人记忆。
 * - `injectRules=false`：该专家运行时不渲染项目规则。
 * - `topicLimit`：主题文件（非 MEMORY.md）数量上限，超出时新的主题创建/提案采纳被拒绝（409）。
 */
export const memoryPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    writeMode: memoryWriteModeSchema.default('native_auto'),
    injectPersonalMemory: z.boolean().default(true),
    injectRules: z.boolean().default(true),
    topicLimit: z.number().int().min(3).max(48).default(20),
  })
  .strict();

export type MemoryPolicy = z.infer<typeof memoryPolicySchema>;

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  enabled: true,
  writeMode: 'native_auto',
  injectPersonalMemory: true,
  injectRules: true,
  topicLimit: 20,
};

/** 读取已落库的策略；缺失或非法时整体回落默认值，不让半套策略进入运行期。 */
export function resolveMemoryPolicy(value: unknown): MemoryPolicy {
  const parsed = memoryPolicySchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_MEMORY_POLICY };
}

/**
 * 个人偏好正文上限：9000 个 Unicode 字符（按码点计，不是 UTF-8 字节）。
 * 官方 UserPromptSubmit additionalContext 单次上限为 10,000 字符，这里留出余量。
 * API 保存、worker 注入与 web 表单共用这一份。
 */
export const PERSONAL_MEMORY_MAX_CHARS = 9000;
/** 异常内容护栏：9000 个字符最坏约 36 KB，超过说明文件异常，读写都拒绝。 */
export const PERSONAL_MEMORY_MAX_BYTES = 36 * 1024;
/** 个人偏好投影到宿主与沙盒只读挂载的文件名。 */
export const PERSONAL_MEMORY_FILENAME = 'CLAUDE.md';

export const memoryReviewTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal') }).strict(),
  z
    .object({
      kind: z.literal('agent_memory'),
      agentId: z.string().min(1),
      /** 一次提案只处理一个文件；MEMORY.md 也走同名目标，不设隐式默认值。 */
      name: memoryFileNameSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('agent_rule'),
      agentId: z.string().min(1),
      // 与普通规则接口共用同一校验：slug 会成为 .claude/rules/<slug>.md 的文件名。
      slug: slugSchema,
    })
    .strict(),
]);

export type MemoryReviewTarget = z.infer<typeof memoryReviewTargetSchema>;

/** 主题文件伴随的 MEMORY.md 快照；没有索引文件时 content 为 null。 */
export const memoryIndexSnapshotSchema = z.object({ content: z.string().nullable() }).strict();

/**
 * 变更前后的记忆快照；personal 与 agent_memory 没有路径作用域，globs 为 null，agent_rule 保留规则自身的 globs。
 * personal、agent_rule、agent_memory/MEMORY.md 的 index 为 null。
 */
export const memoryContentSnapshotSchema = z
  .object({
    content: z.string().nullable(),
    globs: z.string().nullable(),
    index: memoryIndexSnapshotSchema.nullable(),
  })
  .strict();

export type MemoryContentSnapshot = z.infer<typeof memoryContentSnapshotSchema>;

/** 审核取材的会话区间；省略消息 id 表示整段会话。 */
export const memoryReviewSourceSchema = z
  .object({
    conversationId: z.string().min(1),
    fromMessageId: z.string().min(1).optional(),
    throughMessageId: z.string().min(1).optional(),
  })
  .strict();

export type MemoryReviewSource = z.infer<typeof memoryReviewSourceSchema>;

export const createMemoryReviewInputSchema = z
  .object({
    modelAgentId: z.string().min(1),
    target: memoryReviewTargetSchema,
    sources: z.array(memoryReviewSourceSchema).min(1).max(10),
    instruction: z.string().max(4000).default(''),
  })
  .strict();

export type CreateMemoryReviewInput = z.infer<typeof createMemoryReviewInputSchema>;

/** 证据只用于审核归因，不进入官方记忆文件。 */
export const memoryReviewEvidenceKindSchema = z.enum([
  'user_fact',
  'confirmed_decision',
  'assistant_suggestion',
]);

export type MemoryReviewEvidenceKind = z.infer<typeof memoryReviewEvidenceKindSchema>;

export const memoryReviewEvidenceSchema = z
  .object({
    messageId: z.string().min(1),
    quote: z.string().min(1),
    kind: memoryReviewEvidenceKindSchema,
  })
  .strict();

export type MemoryReviewEvidence = z.infer<typeof memoryReviewEvidenceSchema>;

/** 只有不写入正文（proposedContent 为 null）的提案可以没有证据；非 null 正文要求入口验证至少一条 user 证据。 */
export const memoryReviewProposalSchema = z
  .object({
    summary: z.string().min(1),
    proposedContent: z.string().nullable(),
    evidence: z.array(memoryReviewEvidenceSchema),
  })
  .strict();

export type MemoryReviewProposal = z.infer<typeof memoryReviewProposalSchema>;

export const INDEX_FILE_NAME = 'MEMORY.md';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 索引正文里是否有指向该平面文件名（可带 ./ 与 title）的普通行内链接；图片不算链接。 */
export function memoryIndexLinksFile(indexContent: string, name: string): boolean {
  const link = `(?<!!)\\[[^\\]\\n]*\\]\\(\\s*(?:\\./)?${escapeRegExp(name)}(?:\\s+(?:"[^"\\n]*"|'[^'\\n]*'|\\([^)\\n]*\\)))?\\s*\\)`;
  return new RegExp(link).test(indexContent);
}

/**
 * 主题正文非 null 时保证索引里有一行指向它的相对链接，其余索引字节原样保留。
 * MEMORY.md 自身不调用；缺索引时从空串开始。
 */
export function memoryIndexContentAfter(
  name: string,
  content: string | null,
  indexContent: string | null,
): string | null {
  if (content === null || name === INDEX_FILE_NAME) return indexContent;
  if (memoryIndexLinksFile(indexContent ?? '', name)) return indexContent;
  const index = indexContent ?? '';
  const separator = index === '' || index.endsWith('\n') ? '' : '\n';
  return `${index}${separator}- [${name}](${name})\n`;
}

function sameIndex(
  before: MemoryContentSnapshot['index'],
  after: MemoryContentSnapshot['index'],
): boolean {
  if (before === null || after === null) return before === after;
  return before.content === after.content;
}

/** null 表示没有值得写入的内容，也就是不改变任何文件。 */
export function memoryReviewAfter(
  target: MemoryReviewTarget,
  before: MemoryContentSnapshot,
  proposedContent: string | null,
): MemoryContentSnapshot {
  if (proposedContent === null) return before;
  if (target.kind === 'agent_memory' && target.name !== INDEX_FILE_NAME) {
    return {
      content: proposedContent,
      globs: before.globs,
      index: {
        content: memoryIndexContentAfter(
          target.name,
          proposedContent,
          before.index?.content ?? null,
        ),
      },
    };
  }
  return { content: proposedContent, globs: before.globs, index: before.index };
}

/** 纯函数判断一次提案是否真的会改动文件；补索引链接也算变化。 */
export function memoryReviewHasChanges(
  target: MemoryReviewTarget,
  before: MemoryContentSnapshot,
  proposal: MemoryReviewProposal,
): boolean {
  if (proposal.proposedContent === null) return false;
  const after = memoryReviewAfter(target, before, proposal.proposedContent);
  return (
    after.content !== before.content ||
    after.globs !== before.globs ||
    !sameIndex(before.index, after.index)
  );
}

/** 空串 0 行；否则去掉且仅去掉一个末尾换行后按 \n 计数。 */
export function countMemoryLines(content: string): number {
  if (content === '') return 0;
  const withoutTrailingNewline = content.endsWith('\n') ? content.slice(0, -1) : content;
  return withoutTrailingNewline.split('\n').length;
}

/**
 * 返回内容超限的用户可见问题，未超限返回 null。
 * 调用方按上下文区分错误码：总字节限额是 413，索引限额是 400。
 */
export function validateMemoryContent(name: string, content: string): string | null {
  const bytes = utf8Bytes(content);
  if (bytes > MEMORY_FILE_MAX_BYTES) {
    return `记忆文件不能超过 ${MEMORY_FILE_MAX_BYTES} 字节（UTF-8）`;
  }
  if (name !== INDEX_FILE_NAME) return null;
  if (bytes > AGENT_MEMORY_MAX_BYTES) {
    return `MEMORY.md 不能超过 ${AGENT_MEMORY_MAX_BYTES} 字节（UTF-8）；请把详细内容移到主题文件`;
  }
  if (countMemoryLines(content) > AGENT_MEMORY_MAX_LINES) {
    return `MEMORY.md 不能超过 ${AGENT_MEMORY_MAX_LINES} 行；请把详细内容移到主题文件`;
  }
  return null;
}

export const memoryReviewDecisionSchema = z.enum(['pending', 'applied', 'rejected']);

export type MemoryReviewDecision = z.infer<typeof memoryReviewDecisionSchema>;

/** 变更只会在事务提交时落账，不存在 prepared 中间态。 */
export const memoryChangeStateSchema = z.literal('applied');

/** 审核详情：status 来自它背后的运行，decision 是用户是否采纳提案。 */
export const memoryReviewSchema = z.object({
  runId: z.string(),
  /** 执行审核的专家；目标可以是另一个专家或个人记忆。 */
  modelAgentId: z.string(),
  target: memoryReviewTargetSchema,
  status: runStatusSchema,
  decision: memoryReviewDecisionSchema,
  sources: z.array(
    z.object({
      conversationId: z.string(),
      title: z.string(),
      messageCount: z.number().int().nonnegative(),
    }),
  ),
  before: memoryContentSnapshotSchema,
  proposal: memoryReviewProposalSchema.nullable(),
  appliedChangeId: z.string().nullable(),
  /** numeric 列经 pg 驱动返回字符串，沿用运行列表的表示。 */
  costUsd: z.string().nullable(),
  error: z.string().nullable(),
});

export type MemoryReview = z.infer<typeof memoryReviewSchema>;

export const personalMemorySchema = z.object({
  content: z.string(),
  revision: z.number().int().nonnegative(),
  /** 从未写入过时没有更新时刻。 */
  updatedAt: z.string().nullable(),
});

export type PersonalMemory = z.infer<typeof personalMemorySchema>;

export const writePersonalMemoryInputSchema = z
  .object({
    content: z.string(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export type WritePersonalMemoryInput = z.infer<typeof writePersonalMemoryInputSchema>;

export const memoryChangeSchema = z.object({
  id: z.string(),
  target: memoryReviewTargetSchema,
  before: memoryContentSnapshotSchema,
  after: memoryContentSnapshotSchema,
  sourceReviewRunId: z.string().nullable(),
  reversesChangeId: z.string().nullable(),
  state: memoryChangeStateSchema,
  createdAt: z.string(),
});

export type MemoryChange = z.infer<typeof memoryChangeSchema>;

/** 一条记忆健康提示；level 只表达严重度，不触发任何自动修复。 */
export const memoryHealthSchema = z
  .object({
    code: z.string(),
    level: z.enum(['ok', 'warn', 'danger']),
    title: z.string(),
    detail: z.string(),
  })
  .strict();

export type MemoryHealth = z.infer<typeof memoryHealthSchema>;

/** 专家记忆概览：只读派生自策略、记忆文件、规则、个人记忆与账本，不新增存储。 */
export const agentMemoryOverviewSchema = z
  .object({
    policy: memoryPolicySchema,
    index: z
      .object({
        present: z.boolean(),
        lines: z.number().int(),
        bytes: z.number().int(),
        maxLines: z.number().int(),
        maxBytes: z.number().int(),
      })
      .strict(),
    topics: z
      .object({
        count: z.number().int(),
        bytes: z.number().int(),
        /** 索引里没有链接的主题文件名，按名称排序。 */
        unlinked: z.array(z.string()),
        /** 超过 MEMORY_TOPIC_STALE_DAYS 未更新的主题文件名，按名称排序。 */
        stale: z.array(z.string()),
      })
      .strict(),
    rules: z
      .object({
        count: z.number().int(),
        bytes: z.number().int(),
      })
      .strict(),
    personal: z
      .object({
        chars: z.number().int(),
        maxChars: z.number().int(),
      })
      .strict(),
    unaccounted: z
      .object({
        count: z.number().int(),
        names: z.array(z.string()),
      })
      .strict(),
    health: z.array(memoryHealthSchema),
    /** 最近变更的轻量投影：只带文件名、时间与首行摘要，不回传前后全文。 */
    recentChanges: z.array(
      z
        .object({
          name: z.string(),
          createdAt: z.string(),
          /** 变更后正文的首个非空行，最长 120 个字符。 */
          summary: z.string(),
        })
        .strict(),
    ),
    /** `memory_changes` 中该专家记忆变更的真实总数，与 recentChanges 的截断长度无关。 */
    changesTotal: z.number().int(),
  })
  .strict();

export type AgentMemoryOverview = z.infer<typeof agentMemoryOverviewSchema>;

/**
 * 运行期装配视图：描述一次运行里实际会加载什么、以什么方式加载。
 * path 为沙盒内可见路径；个人记忆不在专家记忆目录内，单独按 /mnt/user 投影。
 */
export const agentMemoryAssemblySchema = z
  .object({
    blocks: z.array(
      z
        .object({
          kind: z.enum(['personal', 'index', 'rule', 'topic']),
          name: z.string(),
          path: z.string(),
          /** 文件正文的 UTF-8 字节数；个人记忆按其上限口径用码点数。 */
          chars: z.number().int(),
          /** 本次装配未读取正文时为 null。 */
          lines: z.number().int().nullable(),
          trigger: z.enum(['every-run', 'on-demand', 'skipped']),
          reason: z.string().nullable(),
          /** 仅规则使用；其余为 null。 */
          globs: z.string().nullable(),
        })
        .strict(),
    ),
    /** 四项单位各不相同：个人记忆按码点，其余按 UTF-8 字节。 */
    totals: z
      .object({
        personalChars: z.number().int(),
        indexBytes: z.number().int(),
        rulesBytes: z.number().int(),
        topicBytes: z.number().int(),
      })
      .strict(),
    notes: z.array(z.string()),
  })
  .strict();

export type AgentMemoryAssembly = z.infer<typeof agentMemoryAssemblySchema>;
