import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { KNOWLEDGE_DOCUMENT_MISSING_MESSAGE } from '@agentport/core';
import { type Database, repo, type schema } from '@agentport/db';
import type { KnowledgeJobPayload } from '@agentport/shared';
import {
  DOCUMENT_NO_CONTENT_MESSAGE,
  DOCUMENT_UNREADABLE_MESSAGE,
  knowledgeJobPayloadSchema,
  TAGGING_DOCUMENT_DISABLED_MESSAGE,
  TAGGING_DOCUMENT_NO_VERSION_MESSAGE,
} from '@agentport/shared';
import {
  type Options,
  query,
  type SDKMessage,
  type SDKResultSuccess,
} from '@anthropic-ai/claude-agent-sdk';
import {
  hermeticQueryOptions,
  requireOneShotSuccess,
  runOneShotSdkQuery,
} from '../one-shot-sdk.js';
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

interface TaggingDeps {
  db: Database;
  config: {
    KNOWLEDGE_DIR: string;
    KNOWLEDGE_SUMMARY_MODEL?: string | undefined;
    ANTHROPIC_BASE_URL?: string | undefined;
  };
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
    throw new Error(KNOWLEDGE_DOCUMENT_MISSING_MESSAGE);
  }
  if (document.status === 'disabled' || document.disabledReason !== null) {
    throw new Error(TAGGING_DOCUMENT_DISABLED_MESSAGE);
  }
  if (!document.currentVersionId) throw new Error(TAGGING_DOCUMENT_NO_VERSION_MESSAGE);
  const versionId = payload.versionId ?? document.currentVersionId;
  if (payload.versionId !== undefined && document.currentVersionId !== payload.versionId) {
    throw new Error('文档版本已变化，标签未更新');
  }
  if (!(await repo.knowledge.isDocumentReadable(db, document.id))) {
    throw new Error(DOCUMENT_UNREADABLE_MESSAGE);
  }

  const model = deps.config.KNOWLEDGE_SUMMARY_MODEL;
  if (!model) throw new Error('标签模型未配置(KNOWLEDGE_SUMMARY_MODEL)');

  const content =
    document.summary !== null && document.summaryVersionId === versionId
      ? `${document.title}\n\n${document.summary}`
      : await repo.knowledge.readVersionText(db, versionId, CONTENT_LIMIT);
  if (content.trim() === '') throw new Error(DOCUMENT_NO_CONTENT_MESSAGE);

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
          anthropicBaseUrl: deps.config.ANTHROPIC_BASE_URL,
          maxTurns: 1,
          maxBudgetUsd: 0.1,
          abortController: controller,
        }),
      }),
    onSuccessFrame: (message: SDKResultSuccess) => {
      result.tags = parseTags(message.result);
    },
  });
  requireOneShotSuccess(outcome, () => new KnowledgeCancelled());
  const names = result.tags;
  if (names === null) throw new Error('SDK 没有返回标签');
  if (names.length < 3) throw new Error('SDK 返回的有效标签少于 3 个');

  const latest = await repo.knowledge.getDocument(db, document.id);
  if (latest?.currentVersionId !== versionId) {
    throw new Error('文档版本已变化，标签未更新');
  }

  const rows = await repo.knowledge.upsertTags(db, document.baseId, names);
  await repo.knowledge.replaceAutoTags(
    db,
    document.id,
    rows.map((row) => row.id),
  );
}
