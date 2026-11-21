import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Database, repo, type schema } from '@agentport/db';
import type { KnowledgeJobPayload } from '@agentport/shared';
import { errorText, knowledgeJobPayloadSchema } from '@agentport/shared';
import {
  type Options,
  query,
  type SDKMessage,
  type SDKResultSuccess,
} from '@anthropic-ai/claude-agent-sdk';
import { hermeticQueryOptions, runOneShotSdkQuery } from '../one-shot-sdk.js';
import { KnowledgeCancelled } from './ingestion.js';
import { requireOneShotSuccess } from './one-shot-result.js';

type JobRow = typeof schema.knowledgeJobs.$inferSelect;
type SummaryPayload = Extract<KnowledgeJobPayload, { type: 'summary' }>;

const CONTENT_LIMIT = 12_000;

export type SummaryQueryFn = (params: {
  prompt: string;
  options: Options;
}) => AsyncGenerator<SDKMessage, void>;

export interface SummaryDeps {
  db: Database;
  config: {
    KNOWLEDGE_DIR: string;
    KNOWLEDGE_SUMMARY_MODEL?: string | undefined;
    ANTHROPIC_BASE_URL: string | undefined;
  };
  signal: AbortSignal;
  queryFn?: SummaryQueryFn;
}

function buildPrompt(title: string, content: string): string {
  return [
    `请为文档《${title}》撰写摘要。`,
    '输出不超过约 200 字的中文摘要，只输出摘要正文，不要标题、Markdown 标记或额外解释。',
    '',
    content,
  ].join('\n');
}

export async function runKnowledgeSummary(job: JobRow, deps: SummaryDeps): Promise<void> {
  const { db, signal } = deps;
  if (signal.aborted) throw new KnowledgeCancelled();
  const parsed = knowledgeJobPayloadSchema.parse(job.payload);
  if (parsed.type !== 'summary') throw new Error('只有 summary 任务可以生成文档摘要');
  const payload: SummaryPayload = parsed;

  const document = await repo.knowledge.getDocument(db, payload.documentId);
  if (!document || document.baseId !== payload.baseId) {
    throw new Error('文档不存在或不属于该知识库');
  }
  if (document.status === 'disabled' || document.disabledReason !== null) {
    throw new Error('文档已停用，不能生成摘要');
  }
  if (!document.currentVersionId) throw new Error('文档还没有可用版本，不能生成摘要');
  const versionId = payload.versionId;

  const fail = async (message: string): Promise<never> => {
    await repo.knowledge.setDocumentSummary(
      db,
      document.id,
      {
        summaryStatus: 'failed',
        summaryVersionId: versionId,
        summary: null,
        summaryGeneratedAt: null,
        summaryError: message,
      },
      versionId,
    );
    throw new Error(message);
  };

  if (!(await repo.knowledge.isDocumentReadable(db, document.id))) {
    return fail('文档当前不可读（来源未授权或不在范围）');
  }
  if (document.currentVersionId !== payload.versionId) {
    return fail('文档版本已变化，请重新生成');
  }

  const model = deps.config.KNOWLEDGE_SUMMARY_MODEL;
  if (!model) return fail('摘要模型未配置(KNOWLEDGE_SUMMARY_MODEL)');

  let summary: string | null = null;
  try {
    const content = await repo.knowledge.readVersionText(db, versionId, CONTENT_LIMIT);
    if (content === '') throw new Error('文档当前版本没有可用正文');
    await repo.knowledge.beginDocumentSummary(db, document.id, versionId, 'generating', versionId);
    const cwd = join(deps.config.KNOWLEDGE_DIR, 'summary-sdk', job.id);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const queryFn = deps.queryFn ?? query;
    const outcome = await runOneShotSdkQuery({
      signal,
      cwd,
      create: (controller) =>
        queryFn({
          prompt: buildPrompt(document.title, content),
          options: hermeticQueryOptions({
            model,
            cwd,
            anthropicBaseUrl: deps.config.ANTHROPIC_BASE_URL,
            maxTurns: 1,
            maxBudgetUsd: 0.2,
            abortController: controller,
          }),
        }),
      onSuccessFrame: (message: SDKResultSuccess) => {
        const text = message.result.trim();
        if (text !== '') summary = text;
      },
    });
    requireOneShotSuccess(outcome);
    if (summary === null) throw new Error('SDK 没有返回摘要内容');

    await repo.knowledge.setDocumentSummary(
      db,
      document.id,
      {
        summary,
        summaryStatus: 'ready',
        summaryVersionId: versionId,
        summaryGeneratedAt: new Date(),
        summaryError: null,
      },
      versionId,
    );
  } catch (err) {
    if (signal.aborted || err instanceof KnowledgeCancelled) {
      await repo.knowledge
        .setDocumentSummary(
          db,
          document.id,
          {
            summaryStatus: 'failed',
            summaryVersionId: versionId,
            summary: null,
            summaryGeneratedAt: null,
            summaryError: '摘要生成已取消',
          },
          versionId,
        )
        .catch(() => undefined);
      throw new KnowledgeCancelled();
    }
    await repo.knowledge
      .setDocumentSummary(
        db,
        document.id,
        {
          summaryStatus: 'failed',
          summaryVersionId: versionId,
          summary: null,
          summaryGeneratedAt: null,
          summaryError: errorText(err).slice(0, 500),
        },
        versionId,
      )
      .catch(() => undefined);
    throw err;
  }
}
