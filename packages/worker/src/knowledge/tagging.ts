import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Database, repo, type schema } from '@agentport/db';
import type { KnowledgeJobPayload } from '@agentport/shared';
import { knowledgeJobPayloadSchema } from '@agentport/shared';
import {
  type Options,
  query,
  type SDKMessage,
  type SDKResultSuccess,
} from '@anthropic-ai/claude-agent-sdk';
import { hermeticQueryOptions, runOneShotSdkQuery } from '../one-shot-sdk.js';
import { KnowledgeCancelled } from './ingestion.js';

type JobRow = typeof schema.knowledgeJobs.$inferSelect;
type TagPayload = Extract<KnowledgeJobPayload, { type: 'tag_generate' }>;

const CONTENT_LIMIT = 12_000;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 64;

export type TaggingQueryFn = (params: {
  prompt: string;
  options: Options;
}) => AsyncGenerator<SDKMessage, void>;

export interface TaggingDeps {
  db: Database;
  config: { KNOWLEDGE_DIR: string; KNOWLEDGE_SUMMARY_MODEL?: string | undefined };
  signal: AbortSignal;
  queryFn?: TaggingQueryFn;
}

function buildPrompt(title: string, content: string): string {
  return [
    `请为文档《${title}》生成 3-8 个简洁的中文标签。`,
    '只输出一个 JSON 字符串数组，例如 ["标签一","标签二"]；不要解释，不要 Markdown 代码块。',
    '',
    content,
  ].join('\n');
}

function parseTags(raw: string): string[] {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('标签结果不是 JSON 字符串数组');
  }
  const names = [
    ...new Set(
      parsed.map((item) => item.trim().slice(0, MAX_TAG_LENGTH)).filter((item) => item !== ''),
    ),
  ];
  return names.slice(0, MAX_TAGS);
}

export async function runKnowledgeTagging(job: JobRow, deps: TaggingDeps): Promise<void> {
  const { db, signal } = deps;
  if (signal.aborted) throw new KnowledgeCancelled();
  const parsed = knowledgeJobPayloadSchema.parse(job.payload);
  if (parsed.type !== 'tag_generate') throw new Error('只有 tag_generate 任务可以生成文档标签');
  const payload: TagPayload = parsed;

  const document = await repo.knowledge.getDocument(db, payload.documentId);
  if (!document || document.baseId !== payload.baseId) {
    throw new Error('文档不存在或不属于该知识库');
  }
  if (document.status === 'disabled' || document.disabledReason !== null) {
    throw new Error('文档已停用，不能生成标签');
  }
  if (!document.currentVersionId) throw new Error('文档还没有可用版本，不能生成标签');
  if (!(await repo.knowledge.isDocumentReadable(db, document.id))) {
    throw new Error('文档当前不可读（来源未授权或不在范围）');
  }

  const model = deps.config.KNOWLEDGE_SUMMARY_MODEL;
  if (!model) throw new Error('标签模型未配置(KNOWLEDGE_SUMMARY_MODEL)');

  const content =
    document.summary !== null && document.summaryVersionId === document.currentVersionId
      ? `${document.title}\n\n${document.summary}`
      : await repo.knowledge.readVersionText(db, document.currentVersionId, CONTENT_LIMIT);
  if (content.trim() === '') throw new Error('文档当前版本没有可用正文');

  const result: { tags: string[] | null } = { tags: null };
  const cwd = join(deps.config.KNOWLEDGE_DIR, 'tagging-sdk', job.id);
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
          maxTurns: 1,
          maxBudgetUsd: 0.1,
          abortController: controller,
        }),
      }),
    onSuccessFrame: (message: SDKResultSuccess) => {
      result.tags = parseTags(message.result);
    },
  });
  if (outcome.status === 'aborted') throw new KnowledgeCancelled();
  if (outcome.status === 'no_result') throw new Error('SDK 没有返回结果');
  if (outcome.status === 'failure') throw new Error(outcome.message);
  const names = result.tags;
  if (names === null) throw new Error('SDK 没有返回标签');
  if (names.length === 0) throw new Error('SDK 没有返回有效标签');

  const rows = await repo.knowledge.upsertTags(db, document.baseId, names);
  await repo.knowledge.replaceAutoTags(
    db,
    document.id,
    rows.map((row) => row.id),
  );
}
