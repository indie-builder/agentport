import { z } from 'zod';
import { slugSchema } from './params.js';
import { runStatusSchema } from './schemas.js';

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

const INDEX_FILE_NAME = 'MEMORY.md';
const UTF8_BYTES_2 = 0x800;
const UTF8_BYTES_3 = 0x10000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function indexHasLink(indexContent: string, name: string): boolean {
  // 只识别带标签的普通行内链接并排除图片；目标是平面文件名的相对路径（可带 ./ 与 title）。
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
  if (indexHasLink(indexContent ?? '', name)) return indexContent;
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

/** shared 不带 Node/DOM lib；按码点手算 UTF-8 字节数，浏览器与 Node 都能用。 */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < UTF8_BYTES_2 ? 2 : cp < UTF8_BYTES_3 ? 3 : 4;
  }
  return bytes;
}

function lineCount(content: string): number {
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
  if (lineCount(content) > AGENT_MEMORY_MAX_LINES) {
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
