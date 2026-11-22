import { z } from 'zod';
import { slugSchema } from './params.js';
import { runStatusSchema } from './run-state.js';
import { utf8Bytes } from './utf8.js';

export const memoryFileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.md$/;
export const MEMORY_FILE_NAME_INVALID_MESSAGE = '记忆文件名非法：只允许 <name>.md';
export const MEMORY_REVIEW_NOT_FOUND_MESSAGE = '记忆审核不存在，可能已被清理';
export const MEMORY_REVIEW_REJECTED_MESSAGE = '该审核已被拒绝，不能采纳';
export const MEMORY_VERSION_NOT_FOUND_MESSAGE = '记忆版本不存在，可能已被清理';
export const PERSONAL_MEMORY_STALE_MESSAGE = '个人记忆已被其他编辑更新，请刷新后重试';
export const MEMORY_ROLLBACK_STALE_MESSAGE = '目标内容已变化，无法回滚';
export const memoryFileNameSchema = z
  .string()
  .regex(memoryFileNamePattern, MEMORY_FILE_NAME_INVALID_MESSAGE);

/** 官方启动只读 MEMORY.md 的前 200 行或 25KB，先到者为准；超限拒绝而非截断。 */
export const AGENT_MEMORY_MAX_LINES = 200;
export const AGENT_MEMORY_MAX_BYTES = 25 * 1024;
export const MEMORY_FILE_MAX_BYTES = 200_000;
export const MEMORY_FILE_TOO_LARGE_MESSAGE = `记忆文件不能超过 ${MEMORY_FILE_MAX_BYTES} 字节`;
export const MEMORY_TOPIC_STALE_DAYS = 60;

const memoryWriteModeSchema = z.enum(['native_auto', 'proposal_only']);

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

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = memoryPolicySchema.parse({});

export function memoryWritable(policy: MemoryPolicy): boolean {
  return policy.enabled && policy.writeMode === 'native_auto';
}

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
export const PERSONAL_MEMORY_MAX_BYTES = 36 * 1024;
export const PERSONAL_MEMORY_FILENAME = 'CLAUDE.md';

export const memoryReviewTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal') }).strict(),
  z
    .object({
      kind: z.literal('agent_memory'),
      agentId: z.string().min(1),
      name: memoryFileNameSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('agent_rule'),
      agentId: z.string().min(1),
      slug: slugSchema,
    })
    .strict(),
]);

export type MemoryReviewTarget = z.infer<typeof memoryReviewTargetSchema>;

export const memoryIndexSnapshotSchema = z.object({ content: z.string().nullable() }).strict();

export const memoryContentSnapshotSchema = z
  .object({
    content: z.string().nullable(),
    globs: z.string().nullable(),
    index: memoryIndexSnapshotSchema.nullable(),
  })
  .strict();

export type MemoryContentSnapshot = z.infer<typeof memoryContentSnapshotSchema>;

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

export function memoryIndexLinksFile(indexContent: string, name: string): boolean {
  const link = `(?<!!)\\[[^\\]\\n]*\\]\\(\\s*(?:\\./)?${escapeRegExp(name)}(?:\\s+(?:"[^"\\n]*"|'[^'\\n]*'|\\([^)\\n]*\\)))?\\s*\\)`;
  return new RegExp(link).test(indexContent);
}

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

export function countMemoryLines(content: string): number {
  if (content === '') return 0;
  const withoutTrailingNewline = content.endsWith('\n') ? content.slice(0, -1) : content;
  return withoutTrailingNewline.split('\n').length;
}

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

export const memoryReviewDecisionValueSchema = z.enum(['pending', 'applied', 'rejected']);

export type MemoryReviewDecision = z.infer<typeof memoryReviewDecisionValueSchema>;

export const memoryChangeStateSchema = z.literal('applied');

export const memoryReviewSchema = z.object({
  runId: z.string(),
  modelAgentId: z.string(),
  target: memoryReviewTargetSchema,
  status: runStatusSchema,
  decision: memoryReviewDecisionValueSchema,
  createdAt: z.string(),
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
  costUsd: z.string().nullable(),
  error: z.string().nullable(),
});

export type MemoryReview = z.infer<typeof memoryReviewSchema>;

export const personalMemorySchema = z.object({
  content: z.string(),
  revision: z.number().int().nonnegative(),
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

export const memoryHealthSchema = z
  .object({
    code: z.string(),
    level: z.enum(['ok', 'warn', 'danger']),
    title: z.string(),
    detail: z.string(),
  })
  .strict();

export type MemoryHealth = z.infer<typeof memoryHealthSchema>;

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
        unlinked: z.array(z.string()),
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
    recentChanges: z.array(
      z
        .object({
          name: z.string(),
          createdAt: z.string(),
          summary: z.string(),
        })
        .strict(),
    ),
    changesTotal: z.number().int(),
  })
  .strict();

export type AgentMemoryOverview = z.infer<typeof agentMemoryOverviewSchema>;

export const agentMemoryAssemblySchema = z
  .object({
    blocks: z.array(
      z
        .object({
          kind: z.enum(['personal', 'index', 'rule', 'topic']),
          name: z.string(),
          path: z.string(),
          chars: z.number().int(),
          lines: z.number().int().nullable(),
          trigger: z.enum(['every-run', 'on-demand', 'skipped']),
          reason: z.string().nullable(),
          globs: z.string().nullable(),
        })
        .strict(),
    ),
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
