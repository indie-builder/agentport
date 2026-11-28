import {
  KNOWLEDGE_DOCUMENT_TITLE_MAX_CHARS,
  knowledgeFaqAnswerStrategySchema,
  knowledgeFaqSchema,
} from '@agentport/shared';
import { z } from 'zod';
import type { KnowledgeFaqSummary } from '../../../lib/api.js';

const faqValidationSchema = knowledgeFaqSchema.pick({ question: true, answers: true });

export const faqFormSchema = z
  .object({
    title: z
      .string()
      .max(KNOWLEDGE_DOCUMENT_TITLE_MAX_CHARS, `最多 ${KNOWLEDGE_DOCUMENT_TITLE_MAX_CHARS} 个字符`),
    question: z.string(),
    similarQuestions: z.string(),
    negativeQuestions: z.string(),
    answers: z.array(z.string()),
    folderId: z.string(),
    tags: z.string(),
    answerStrategy: knowledgeFaqAnswerStrategySchema,
    isRecommended: z.boolean(),
  })
  .superRefine((values, ctx) => {
    const parsed = faqValidationSchema.safeParse({
      question: values.question,
      answers: values.answers,
    });
    if (parsed.success) return;
    const seen = new Set<string>();
    for (const issue of parsed.error.issues) {
      const pathKey = issue.path.map(String).join('.');
      if (seen.has(pathKey)) continue;
      seen.add(pathKey);
      let message = issue.message;
      if (issue.path[0] === 'question') {
        if (issue.code === 'too_small') message = '请填写标准问';
        else if (issue.code === 'too_big') message = `最多 ${String(issue.maximum)} 个字符`;
      } else if (issue.path[0] === 'answers') {
        if (issue.path.length === 2 && issue.code === 'too_big') {
          message = `每个答案最多 ${String(issue.maximum)} 个字符`;
        } else if (issue.path.length === 1 && issue.code === 'too_small') {
          message = '至少一个答案';
        } else if (issue.path.length === 1 && issue.code === 'custom') {
          message = '至少填写一个答案';
        }
      }
      ctx.addIssue({
        code: 'custom',
        path: issue.path,
        message,
      });
    }
  });

export type FaqForm = z.infer<typeof faqFormSchema>;

export function splitQuestions(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function indexedErrorMessage(errors: unknown, index: number): string | undefined {
  if (!Array.isArray(errors)) return undefined;
  const entry = errors[index] as { message?: unknown } | undefined;
  return typeof entry?.message === 'string' ? entry.message : undefined;
}

export function rootErrorMessage(errors: unknown): string | undefined {
  if (Array.isArray(errors)) return undefined;
  const entry = errors as { message?: unknown } | undefined;
  return typeof entry?.message === 'string' ? entry.message : undefined;
}

export function readString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export const FAQ_BATCH_LIMIT = 100;

export function faqStatus(
  item: KnowledgeFaqSummary,
): 'published' | 'draft' | 'disabled' | 'processing' | 'failed' {
  if (item.status === 'failed') return 'failed';
  if (item.status === 'processing') return 'processing';
  if (item.status === 'disabled') return 'disabled';
  if (item.status === 'pending') return 'draft';
  return item.currentVersionId ? 'published' : 'draft';
}

export const faqStatusLabel = {
  published: '已发布',
  draft: '未发布草稿',
  disabled: '已停用',
  processing: '解析中',
  failed: '失败',
} as const;

export const faqStatusTone = {
  published: 'success',
  draft: 'warn',
  disabled: 'outline',
  processing: 'warn',
  failed: 'danger',
} as const;
