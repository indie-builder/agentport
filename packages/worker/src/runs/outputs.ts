import { join } from 'node:path';
import {
  outputDraftBlockedReason,
  prepareOutputDraft,
  publishOutputSnapshot,
  setOutputDraftBlocked,
} from '@agentport/core';
import { type Database, schema } from '@agentport/db';
import {
  type ExecutionSettlement,
  OUTPUTS_CONTAINER_DIR,
  type OutputRef,
  outputRefSchema,
  type TerminalRunStatus,
} from '@agentport/shared';
import { desc, eq } from 'drizzle-orm';

import { MESSAGES_NOT_SAVED_ERROR } from '../messages.js';
import { toHostWorkspacePath } from '../session-workspace.js';

export interface RunOutputsIdentity {
  workspacesDir: string;
  hostWorkspacesDir: string;
  slug: string;
  conversationId: string;
  runId: string;
}

export function selectedOutput(content: unknown): OutputRef | null {
  if (Array.isArray(content)) {
    for (const part of content) {
      const found = selectedOutput(part);
      if (found) return found;
    }
    return null;
  }
  if (typeof content !== 'object' || content === null) return null;
  const parsed = outputRefSchema.safeParse((content as { output?: unknown }).output);
  return parsed.success ? parsed.data : null;
}

export function promptWithSelectedOutput(prompt: string, output: OutputRef | null): string {
  if (output === null) return prompt;
  return [
    prompt,
    '',
    `用户选择了上一版交付文件作为修改对象：${join(OUTPUTS_CONTAINER_DIR, output.path)}`,
    '直接在该路径上修改；未改动的文件保持原样，用户会看到新版本。',
  ].join('\n');
}

export async function prepareRunOutputs(
  input: RunOutputsIdentity & { sourceRunId?: string; sourcePath?: string },
): Promise<{ dir: string; hostPath: string }> {
  const dir = await prepareOutputDraft({
    root: input.workspacesDir,
    slug: input.slug,
    conversationId: input.conversationId,
    runId: input.runId,
    ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
    ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
  });
  return { dir, hostPath: toHostWorkspacePath(input, dir) };
}

function outputPublishProblem(input: {
  cleanupError?: string;
  retrying: boolean;
}): string | undefined {
  if (input.cleanupError !== undefined)
    return `容器未能确认停止，产出未发布：${input.cleanupError}`;
  if (input.retrying) return '基础设施重试中，本轮产出未发布';
  return undefined;
}

interface PublishRunOutputsInput {
  status: TerminalRunStatus;
  userMessageId: string;
  afterMessageId: string | (() => Promise<string>);
  messagesWritten?: boolean;
  messageSaveError?: string;
  retrying: boolean;
  cleanupError?: string;
}

export async function lastMessageIdOfRun(db: Database, runId: string): Promise<string> {
  const [row] = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(eq(schema.messages.runId, runId))
    .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
    .limit(1);
  if (row === undefined) throw new Error(`run ${runId} has no persisted message boundary`);
  return row.id;
}

export async function recordOutputSandboxSettlement(
  identity: RunOutputsIdentity,
  outcome: { settlement: ExecutionSettlement },
): Promise<void> {
  await setOutputDraftBlocked(
    { root: identity.workspacesDir, ...identity },
    outcome.settlement.state === 'stopped' ? null : outcome.settlement.error,
  );
}

export async function publishRunOutputsIfSettled(
  identity: RunOutputsIdentity,
  input: PublishRunOutputsInput,
): Promise<{ published: boolean; problem?: string }> {
  const storage = { root: identity.workspacesDir, ...identity };
  if (input.cleanupError !== undefined) await setOutputDraftBlocked(storage, input.cleanupError);
  if (input.messagesWritten === false) {
    return {
      published: false,
      problem: `${MESSAGES_NOT_SAVED_ERROR}：${input.messageSaveError ?? '消息保存被拒绝，运行可能已由外部终止'}`,
    };
  }
  const blocked = await outputDraftBlockedReason(storage);
  const problem = outputPublishProblem({
    ...(blocked === null ? {} : { cleanupError: blocked }),
    retrying: input.retrying,
  });
  if (problem !== undefined) return { published: false, problem };
  await publishOutputSnapshot({
    root: identity.workspacesDir,
    slug: identity.slug,
    conversationId: identity.conversationId,
    runId: identity.runId,
    status: input.status,
    userMessageId: input.userMessageId,
    afterMessageId:
      typeof input.afterMessageId === 'string'
        ? input.afterMessageId
        : await input.afterMessageId(),
  });
  await setOutputDraftBlocked(storage, null);
  return { published: true };
}
