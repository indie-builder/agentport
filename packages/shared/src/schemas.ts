import { z } from 'zod';
import { runTriggerSchema } from './ops.js';

/**
 * 前端真正解析的响应形状。路由声明 `response` 后，Fastify 会按 schema 序列化：
 * 漏声明的字段会被静默丢弃，多余字段同样被丢弃，类型不符则 500 RESPONSE_INVALID。
 * 只覆盖前端消费的端点，不追求覆盖全部路由。
 */

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
]);

/** /api/runs 列表项；costUsd 是 numeric，pg 驱动返回字符串。 */
export const runListItemSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string().nullable(),
  status: runStatusSchema,
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  latencyMs: z.number().nullable(),
  costUsd: z.string().nullable(),
  turns: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  error: z.string().nullable(),
  trigger: runTriggerSchema.optional(),
  /** 入队时的智能体配置版本（provenance；执行使用当前配置，不做快照回放）。 */
  agentVersion: z.number().nullable().optional(),
});

export type RunListItem = z.infer<typeof runListItemSchema>;

export const runListSchema = z.object({ items: z.array(runListItemSchema) });

export const runStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), at: z.string(), text: z.string() }),
  z.object({ kind: z.literal('assistant'), at: z.string(), text: z.string() }),
  z.object({
    kind: z.literal('tool'),
    at: z.string(),
    name: z.string().nullable(),
    toolUseId: z.string().nullable(),
    content: z.unknown(),
    /** 调用结果；与 content（参数）分开。 */
    result: z.unknown().optional(),
    parentToolUseId: z.string().nullable(),
  }),
]);

/** 失败分类：infra=平台/沙箱基础设施，agent=模型或工具，sandbox=容器异常退出。 */
export const runErrorKindSchema = z.enum(['cancelled', 'timeout', 'sandbox', 'agent', 'infra']);

export const runDetailSchema = z.object({
  run: runListItemSchema.extend({
    conversationId: z.string(),
    sessionId: z.string().nullable(),
    sandboxId: z.string().nullable(),
    // optional：db 的 runColumns 尚未取该列，缺失时响应序列化不能失败。
    errorKind: runErrorKindSchema.nullable().optional(),
  }),
  steps: z.array(runStepSchema),
  conversation: z.object({ id: z.string(), agentId: z.string(), title: z.string() }),
});

/** /api/overview 的 recent：没有 tokens 两列。 */
export const recentRunSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string().nullable(),
  status: runStatusSchema,
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  costUsd: z.string().nullable(),
  turns: z.number().nullable(),
  latencyMs: z.number().nullable(),
  error: z.string().nullable(),
});

export const overviewSchema = z.object({
  window: z.object({ days: z.number(), since: z.string() }),
  counts: z.object({
    servers: z.number(),
    agents: z.number(),
    runs: z.number(),
    running: z.number(),
    failed: z.number(),
    tokens: z.number(),
    costUsd: z.number(),
    avgLatencyMs: z.number().nullable(),
  }),
  agents: z.array(
    z.object({
      agentId: z.string(),
      name: z.string(),
      slug: z.string(),
      createdAt: z.string().nullable(),
      enabled: z.boolean(),
      lastRunStartTime: z.string().nullable(),
      runCount: z.number(),
      totalCost: z.number(),
      errorRate: z.number(),
      latencyP50: z.number().nullable(),
      latencyP99: z.number().nullable(),
      totalTokens: z.number(),
    }),
  ),
  recent: z.array(recentRunSchema),
});

export const evalCaseFieldsSchema = z.object({
  name: z.string().trim().min(1).max(128),
  prompt: z.string().min(1).max(20_000),
  expectation: z.string().max(5_000).default(''),
});

export const evalDatasetSchema = z.object({
  format: z.literal('agentport/eval@1'),
  exportedAt: z.iso.datetime(),
  cases: z.array(evalCaseFieldsSchema).max(500),
});

export type EvalDataset = z.infer<typeof evalDatasetSchema>;
export interface EvalDatasetImportResult {
  imported: number;
  skipped: number;
  warnings: string[];
}

/** 评估运行：worker 崩溃时把原因写进 error；前端据此说明失败原因。 */
export const evalRunSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  total: z.number(),
  passed: z.number(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

export type EvalRun = z.infer<typeof evalRunSchema>;

export const evalResultSchema = z.object({
  // 用例或运行被清理后，结果仍保留：引用置空而不是级联删除历史。
  caseId: z.string().nullable(),
  name: z.string(),
  prompt: z.string(),
  expectation: z.string(),
  passed: z.boolean(),
  output: z.string(),
  runId: z.string().nullable(),
});

export const evalRunExportSchema = z.object({
  format: z.literal('agentport/eval-run@1'),
  exportedAt: z.iso.datetime(),
  configurationPinned: z.literal(false),
  evalRun: evalRunSchema,
  results: z.array(evalResultSchema).max(500),
});

export type EvalRunExport = z.infer<typeof evalRunExportSchema>;

export const evalComparisonRowSchema = z.object({
  key: z.string(),
  status: z.enum([
    'improved',
    'regressed',
    'unchanged',
    'changed_inputs',
    'base_only',
    'head_only',
    'unverified',
  ]),
  base: evalResultSchema.nullable(),
  head: evalResultSchema.nullable(),
});

export const evalComparisonSchema = z.object({
  baseRun: evalRunSchema,
  headRun: evalRunSchema,
  rows: z.array(evalComparisonRowSchema),
});

export type EvalComparison = z.infer<typeof evalComparisonSchema>;

export const evalRunDetailSchema = z.object({
  evalRun: evalRunSchema,
  results: z.array(evalResultSchema),
});
