import { z } from 'zod';

/**
 * 原生 AskUserQuestion 的输入/回答契约。
 *
 * 官方工具输入保持原样落库：这里只做边界校验，不 trim、不改写问题文本。
 * 答案以问题文本为键，所以问题文本重复时无法区分回答，入口直接拒绝。
 */
export const QUESTION_LIMITS = {
  questions: 4,
  options: 4,
  header: 12,
  question: 2_000,
  optionLabel: 200,
  optionDescription: 1_000,
  answer: 2_000,
  /** 单次回答的载荷上限；超过说明模型或客户端在灌数据。 */
  responseBytes: 8 * 1_024,
} as const;

const nonBlank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, { message: '不能为空' });

export const nativeQuestionSchema = z.object({
  question: nonBlank(QUESTION_LIMITS.question),
  header: nonBlank(QUESTION_LIMITS.header),
  options: z
    .array(
      z.object({
        label: nonBlank(QUESTION_LIMITS.optionLabel),
        description: z.string().max(QUESTION_LIMITS.optionDescription),
      }),
    )
    .min(2)
    .max(QUESTION_LIMITS.options),
  multiSelect: z.boolean(),
});

export type NativeQuestion = z.infer<typeof nativeQuestionSchema>;

export const nativeQuestionsSchema = z
  .array(nativeQuestionSchema)
  .min(1)
  .max(QUESTION_LIMITS.questions)
  .superRefine((questions, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of questions.entries()) {
      if (seen.has(item.question)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'question'],
          message: '问题文本重复，回答无法按问题区分',
        });
      }
      seen.add(item.question);
    }
  });

export type NativeQuestions = z.infer<typeof nativeQuestionsSchema>;

/** 官方工具输入的完整形状：questions 1–4，每题 2–4 个选项。 */
export const nativeQuestionInputSchema = z.object({ questions: nativeQuestionsSchema });

export type NativeQuestionInput = z.infer<typeof nativeQuestionInputSchema>;

const answersSchema = z
  .record(nonBlank(QUESTION_LIMITS.question), nonBlank(QUESTION_LIMITS.answer))
  .refine((answers) => Object.keys(answers).length <= QUESTION_LIMITS.questions, {
    message: `一次最多回答 ${QUESTION_LIMITS.questions} 个问题`,
  })
  .refine((answers) => JSON.stringify(answers).length <= QUESTION_LIMITS.responseBytes, {
    message: '回答内容超出大小限制',
  });

/** 回答要么给出答案，要么明确暂不回答；两者互斥。 */
export const questionResponseSchema = z.union([
  z.object({ answers: answersSchema }).strict(),
  z.object({ decline: z.literal(true) }).strict(),
]);

export type QuestionResponse = z.infer<typeof questionResponseSchema>;

const questionIndexSchema = z.string().regex(/^[0-3]$/);
/** HTTP 表单只传自由文本和稳定选项序号；SDK stdin 仍用 QuestionResponse。 */
export const publicQuestionResponseSchema = z.union([
  z
    .object({
      answers: z.record(questionIndexSchema, nonBlank(QUESTION_LIMITS.answer)),
      choices: z.record(questionIndexSchema, z.array(questionIndexSchema).min(1).max(4)).optional(),
    })
    .strict()
    .refine((response) => JSON.stringify(response).length <= QUESTION_LIMITS.responseBytes, {
      message: '回答内容超出大小限制',
    }),
  z.object({ decline: z.literal(true) }).strict(),
]);
export type PublicQuestionResponse = z.infer<typeof publicQuestionResponseSchema>;

export const runQuestionStatusSchema = z.enum(['pending', 'answered', 'declined', 'closed']);
export type RunQuestionStatus = z.infer<typeof runQuestionStatusSchema>;

/** 一次提问的运行记录；answers 为 null 表示尚未回答。 */
export const runQuestionSchema = z.object({
  requestId: z.string().min(1).max(256),
  runId: z.string().min(1),
  toolUseId: z.string().min(1).max(256),
  questions: nativeQuestionsSchema,
  status: runQuestionStatusSchema,
  answers: z
    .record(nonBlank(QUESTION_LIMITS.question), nonBlank(QUESTION_LIMITS.answer))
    .nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  expiresAt: z.string(),
  closeReason: z.string().max(1_000).nullable(),
});

export type RunQuestion = z.infer<typeof runQuestionSchema>;

/** 脱敏展示投影：题序号为答案键，选项 value 为原数组序号。 */
export const publicRunQuestionSchema = runQuestionSchema.extend({
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string(),
      multiSelect: z.boolean(),
      options: z.array(
        z.object({
          value: questionIndexSchema,
          label: z.string(),
          description: z.string(),
        }),
      ),
    }),
  ),
  answers: z.record(questionIndexSchema, z.string()).nullable(),
});
export type PublicRunQuestion = z.infer<typeof publicRunQuestionSchema>;

/** runner stdin 命令；当前只有回答一个问题。 */
export const sandboxInputCommandSchema = z.object({
  type: z.literal('question_response'),
  requestId: z.string().min(1).max(256),
  response: questionResponseSchema,
});

export type SandboxInputCommand = z.infer<typeof sandboxInputCommandSchema>;
