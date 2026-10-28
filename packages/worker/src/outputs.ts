import { join, relative } from 'node:path';
import {
  outputDraftBlockedReason,
  prepareOutputDraft,
  publishOutputSnapshot,
  setOutputDraftBlocked,
} from '@agentport/core';
import { type Database, schema } from '@agentport/db';
import { type OutputRef, outputRefSchema } from '@agentport/shared';
import { desc, eq } from 'drizzle-orm';

/** 容器内的交付目录；worker 只把本 run 的草稿挂到这里。 */
export const OUTPUTS_CONTAINER_DIR = '/mnt/outputs';

/** 草稿挂载：独立 rw 目录；定义挂载仍由 provider 以只读方式加。 */
export function outputsMount(hostPath: string): {
  hostPath: string;
  containerPath: string;
  readonly: false;
} {
  return { hostPath, containerPath: OUTPUTS_CONTAINER_DIR, readonly: false };
}

export interface RunOutputsIdentity {
  workspacesDir: string;
  hostWorkspacesDir: string;
  slug: string;
  conversationId: string;
  runId: string;
}

/** content.output 只在符合 shared 契约时采用；其余形状按「没有选择」处理。 */
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

/**
 * 用户选择了旧版本文件时，在首条消息里给出草稿里的同一路径。
 * 草稿内容已由 prepareOutputDraft 复制过来，模型改同一路径即可。
 */
export function promptWithSelectedOutput(prompt: string, output: OutputRef | null): string {
  if (output === null) return prompt;
  return [
    prompt,
    '',
    `用户选择了上一版交付文件作为修改对象：${join(OUTPUTS_CONTAINER_DIR, output.path)}`,
    '直接在该路径上修改；未改动的文件保持原样，用户会看到新版本。',
  ].join('\n');
}

/**
 * 准备本轮草稿目录并换算成宿主路径：核心按 workspacesDir 组织，
 * docker 需要的是宿主 daemon 能看到的同相对路径。
 */
export async function prepareRunOutputs(
  input: RunOutputsIdentity & { sourceRunId?: string; sourcePath?: string },
): Promise<{ hostPath: string }> {
  const dir = await prepareOutputDraft({
    root: input.workspacesDir,
    slug: input.slug,
    conversationId: input.conversationId,
    runId: input.runId,
    ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
    ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
  });
  return { hostPath: join(input.hostWorkspacesDir, relative(input.workspacesDir, dir)) };
}

/**
 * 不发布快照的原因；返回文案时本轮产出保持草稿状态，不覆盖同 run 的已发布版本。
 * - 容器清理失败：可能还在写，不能把变化中的文件当完整快照；
 * - 还会被 BullMQ 重试：本轮没跑完，重试会在同一草稿上重建。
 */
export function outputPublishProblem(input: {
  cleanupError?: string;
  retrying: boolean;
}): string | undefined {
  if (input.cleanupError !== undefined)
    return `容器未能确认停止，产出未发布：${input.cleanupError}`;
  if (input.retrying) return '基础设施重试中，本轮产出未发布';
  return undefined;
}

export interface PublishRunOutputsInput {
  status: 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  userMessageId: string;
  /** 本轮最后一条真实消息；只有工具调用的轮次也要取到，不能依赖助手文本。 */
  afterMessageId: string | (() => Promise<string>);
  /** 生产 worker 显式传入消息事务结果；内部独立发布调用可直接提供已保存边界。 */
  messagesWritten?: boolean;
  messageSaveError?: string;
  /** 本轮还会被 BullMQ 重试：草稿留着给下一次尝试。 */
  retrying: boolean;
  /** runner-client 的容器清理失败；容器可能还在写文件。 */
  cleanupError?: string;
}

/** 本轮真实消息边界：用户消息也在内，只有工具调用的轮次同样有行。 */
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

/** 只有真正创建过的容器无清理错误地返回，才确认本次尝试已停稳。 */
export async function recordOutputSandboxSettlement(
  identity: RunOutputsIdentity,
  outcome: { sandboxId: string; cleanupError?: string },
): Promise<void> {
  const input = { root: identity.workspacesDir, ...identity };
  if (outcome.cleanupError !== undefined) {
    await setOutputDraftBlocked(input, outcome.cleanupError);
  } else if (outcome.sandboxId !== '') {
    await setOutputDraftBlocked(input, null);
  }
}

/**
 * 容器停稳且不再重试时才发布；否则保留草稿并返回原因。
 * 这里只负责门禁，真正的快照写入交给 core 的单一存储实现。
 */
export async function publishRunOutputsIfSettled(
  identity: RunOutputsIdentity,
  input: PublishRunOutputsInput,
): Promise<{ published: boolean; problem?: string }> {
  const storage = { root: identity.workspacesDir, ...identity };
  if (input.cleanupError !== undefined) await setOutputDraftBlocked(storage, input.cleanupError);
  if (input.messagesWritten === false) {
    return {
      published: false,
      problem: `消息未保存，产出未发布：${input.messageSaveError ?? '消息保存被拒绝，运行可能已由外部终止'}`,
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
