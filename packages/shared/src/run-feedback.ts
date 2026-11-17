import { z } from 'zod';
import { outputPathSchema } from './outputs.js';

export const runFeedbackDecisionSchema = z.enum(['accepted', 'rejected']);

export type RunFeedbackDecision = z.infer<typeof runFeedbackDecisionSchema>;

export const runFeedbackSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  runId: z.string(),
  messageId: z.string().nullable(),
  outputPath: outputPathSchema.nullable(),
  outputSha256: z.string().nullable(),
  decision: runFeedbackDecisionSchema,
  rating: z.number().int().min(1).max(5).nullable(),
  comment: z.string(),
  reason: z.string(),
  evalCaseId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
});

export type RunFeedback = z.infer<typeof runFeedbackSchema>;

export const runFeedbackListSchema = z.object({ items: z.array(runFeedbackSchema) });

export type RunFeedbackList = z.infer<typeof runFeedbackListSchema>;

export const submitRunFeedbackSchema = z
  .object({
    decision: runFeedbackDecisionSchema,
    rating: z
      .number({ error: '评分必须是数字' })
      .int('评分必须是整数')
      .min(1, '评分须在 1 到 5 之间')
      .max(5, '评分须在 1 到 5 之间')
      .nullable()
      .optional(),
    comment: z
      .string({ error: '评价必须是文本' })
      .trim()
      .max(2000, '评价不能超过 2000 个字符')
      .optional()
      .default(''),
    reason: z
      .string({ error: '拒绝原因必须是文本' })
      .trim()
      .max(2000, '拒绝原因不能超过 2000 个字符')
      .optional()
      .default(''),
    messageId: z
      .string({ error: '消息 ID 必须是文本' })
      .min(1, '消息 ID 不能为空')
      .max(200, '消息 ID 不能超过 200 个字符')
      .nullable()
      .optional(),
    outputPath: outputPathSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => value.decision !== 'rejected' || value.reason.length > 0, {
    message: '拒绝成果时必须填写原因',
    path: ['reason'],
  })
  .refine((value) => !(value.messageId != null && value.outputPath != null), {
    message: '消息锚点与成果路径不能同时指定',
    path: ['outputPath'],
  });

export type SubmitRunFeedback = z.infer<typeof submitRunFeedbackSchema>;
