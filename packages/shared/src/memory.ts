import { z } from 'zod';
import { slugSchema } from './params.js';
import { runStatusSchema } from './schemas.js';

/**
 * 个人记忆与记忆审核的共享契约。
 * 记忆内容本身仍落官方文件（个人记忆文件 / `agent-memory/` / `.claude/rules/`），
 * 这里只描述审核请求、提案和历史变更的形状。
 */

export const memoryReviewTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal') }).strict(),
  z.object({ kind: z.literal('agent_memory'), agentId: z.string().min(1) }).strict(),
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

/** 变更前后的记忆快照；个人记忆没有路径作用域，globs 为 null。 */
export const memoryContentSnapshotSchema = z
  .object({
    content: z.string().nullable(),
    globs: z.string().nullable(),
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

export const memoryReviewEvidenceSchema = z
  .object({ messageId: z.string().min(1), quote: z.string().min(1) })
  .strict();

export type MemoryReviewEvidence = z.infer<typeof memoryReviewEvidenceSchema>;

/** 提案允许没有证据（模型判断不需要引用）或不需要改正文。 */
export const memoryReviewProposalSchema = z
  .object({
    summary: z.string().min(1),
    proposedContent: z.string().nullable(),
    evidence: z.array(memoryReviewEvidenceSchema),
  })
  .strict();

export type MemoryReviewProposal = z.infer<typeof memoryReviewProposalSchema>;

export const memoryReviewDecisionSchema = z.enum(['pending', 'applied', 'rejected']);

export type MemoryReviewDecision = z.infer<typeof memoryReviewDecisionSchema>;

/** 变更只会在事务提交时落账，不存在 prepared 中间态。 */
export const memoryChangeStateSchema = z.literal('applied');

export type MemoryChangeState = z.infer<typeof memoryChangeStateSchema>;

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
