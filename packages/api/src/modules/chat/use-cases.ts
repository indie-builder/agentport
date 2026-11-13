import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  conversationInputsDir,
  displayAttachmentFilename,
  fail,
  writeConversationAttachments,
} from '@agentport/core';
import { type Database, newId, repo } from '@agentport/db';
import {
  type AccessResource,
  attachmentExtension,
  type ChatRequest,
  type MessageAttachment,
  type PermissionId,
  type Principal,
  RUN_QUEUE_MAX_WAITING,
  runEnqueueOptions,
} from '@agentport/shared';
import type { SQL } from 'bun';
import type { Logger } from 'pino';
import type { Config } from '../../config.js';
import { getQueue } from '../../queue/producer.js';
import { failQueuedRunEnqueue } from '../runs/enqueue.js';
import { deleteConversationWithSandboxes } from '../runtime-deletion.js';
import { CONVERSATION_MISSING } from './access.js';
import {
  actionBytes,
  checkOpenUiActionSource,
  OPENUI_ACTION_MAX_BYTES,
  openUiActionContent,
  sourcePairingProblem,
} from './openui-actions.js';
import { checkOutputSelection, outputUserContent } from './outputs.js';
export type StartRunDependencies = {
  db: Database;
  client: SQL;
  config: Config;
  log: Logger;
  requestId: string;
  authorize: (
    permissionId: PermissionId,
    resource: AccessResource,
    notFoundMessage?: string,
  ) => Promise<void>;
};
const chatRepo = repo.chat;
function attachmentConversationTitle(
  message: string,
  attachments: Array<{
    filename: string;
  }>,
): string {
  if (message.trim().length > 0) return message.slice(0, 80);
  const filename = displayAttachmentFilename(attachments[0]?.filename ?? '');
  return filename.length > 0 ? filename.slice(0, 80) : '附件';
}
async function removeWrittenAttachments(input: {
  root: string;
  slug: string;
  conversationId: string;
  attachments: MessageAttachment[];
}): Promise<void> {
  const dir = resolve(conversationInputsDir(input));
  await Promise.all(
    input.attachments.map((attachment) => {
      const file = resolve(dir, `${attachment.id}${attachmentExtension(attachment.mimeType)}`);
      if (!file.startsWith(`${dir}${sep}`)) return Promise.resolve();
      return rm(file, { force: true });
    }),
  );
}
export function deleteCreatedConversation(
  context: Pick<StartRunDependencies, 'client' | 'config'>,
  conversationId: string,
  businessId: string,
): Promise<unknown> {
  return deleteConversationWithSandboxes({
    client: context.client,
    redisUrl: context.config.REDIS_URL,
    deletion: { id: conversationId, access: { businessId, scopes: ['own_data'] } },
  });
}
export async function startRun(
  principal: Extract<Principal, { kind: 'user' }>,
  body: ChatRequest,
  deps: StartRunDependencies,
) {
  const { openuiAction, attachments, ...chatInput } = body;
  const { message, output } = chatInput;
  const messageText = message ?? '';
  if (attachments !== undefined && openuiAction !== undefined) {
    return fail('INVALID_INPUT', '附件与生成式 UI 动作不能同时发送，请只保留一种');
  }
  const pairingProblem = openuiAction === undefined ? null : sourcePairingProblem(openuiAction);
  if (pairingProblem !== null) {
    return fail('INVALID_INPUT', pairingProblem);
  }
  if (openuiAction?.type === 'open_url') {
    return null;
  }
  if (openuiAction !== undefined && actionBytes(openuiAction) > OPENUI_ACTION_MAX_BYTES) {
    return fail('PAYLOAD_TOO_LARGE', '生成式 UI 动作数据超过 64KB 上限，未发送');
  }
  const sourceProblem =
    openuiAction === undefined
      ? null
      : await checkOpenUiActionSource(deps.db, body.conversationId, openuiAction);
  if (sourceProblem !== null) {
    return fail('INVALID_INPUT', sourceProblem);
  }
  if (output !== undefined) {
    const outputProblem = await checkOutputSelection(deps, {
      conversationId: body.conversationId,
      output,
    });
    if (outputProblem !== null) {
      return fail(outputProblem.code, outputProblem.message);
    }
  }
  const agentId = chatInput.agentId ?? (await repo.agents.getDefaultAgent(deps.db))?.id;
  if (agentId === undefined) {
    return fail('SERVICE_UNAVAILABLE', '通用助手尚未初始化，请稍后重试');
  }
  if (!(await chatRepo.agentExists(deps.db, agentId))) {
    return fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请刷新后重新选择');
  }
  if (!(await chatRepo.agentEnabled(deps.db, agentId))) {
    return fail('AGENT_DISABLED', '该智能体已停用，无法发起新对话；请到智能体页面启用后再试');
  }
  await deps.authorize('agents.use', { agentId }, '智能体不存在，可能已被删除；请刷新后重新选择');
  if (body.conversationId === undefined) {
    await deps.authorize('conversations.create', {
      createdBy: principal.businessId,
    });
  } else {
    const conversation = await chatRepo.getConversation(deps.db, body.conversationId);
    if (!conversation || conversation.agentId !== agentId) {
      return fail('CONVERSATION_NOT_FOUND', '会话不存在或不属于该智能体；请从会话列表重新打开');
    }
    await deps.authorize(
      'conversations.update',
      { objectId: conversation.id, createdBy: conversation.createdBy, privateContent: true },
      CONVERSATION_MISSING,
    );
  }
  if ((await getQueue().getWaitingCount()) > RUN_QUEUE_MAX_WAITING) {
    return fail('SERVICE_UNAVAILABLE', '运行队列已满，请稍后重试');
  }
  const agentVersion = await repo.agentVersions.latestAgentVersion(deps.db, agentId);
  let createdConversationId: string | undefined;
  let attachmentSlug: string | undefined;
  let requestedConversationId = body.conversationId;
  let writtenAttachments: MessageAttachment[] | undefined;
  if (attachments !== undefined) {
    if (requestedConversationId === undefined) {
      createdConversationId = newId('conversation');
      await chatRepo.createConversation(deps.db, {
        id: createdConversationId,
        agentId,
        title: attachmentConversationTitle(messageText, attachments),
        subject: { kind: 'user', businessId: principal.businessId },
      });
      requestedConversationId = createdConversationId;
    } else {
      const conversation = await chatRepo.getConversation(deps.db, requestedConversationId);
      if (!conversation || conversation.agentId !== agentId) {
        return fail('CONVERSATION_NOT_FOUND', '会话不存在或不属于该智能体；请从会话列表重新打开');
      }
    }
    const agentSlug = await repo.agents.findAgentSlug(deps.db, agentId);
    if (agentSlug === null) {
      if (createdConversationId !== undefined) {
        await deleteCreatedConversation(deps, createdConversationId, principal.businessId).catch(
          () => undefined,
        );
      }
      return fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请刷新后重新选择');
    }
    attachmentSlug = agentSlug;
    try {
      writtenAttachments = await writeConversationAttachments({
        root: deps.config.WORKSPACES_DIR,
        slug: agentSlug,
        conversationId: requestedConversationId,
        inputs: attachments,
      });
    } catch (err) {
      if (createdConversationId !== undefined) {
        await deleteCreatedConversation(deps, createdConversationId, principal.businessId).catch(
          () => undefined,
        );
      }
      throw err;
    }
  }
  const userContent =
    writtenAttachments === undefined
      ? output === undefined
        ? openuiAction === undefined
          ? undefined
          : openUiActionContent(openuiAction)
        : outputUserContent({
            text: messageText,
            output,
            ...(openuiAction === undefined ? {} : { openuiAction }),
          })
      : {
          type: 'text',
          text: messageText,
          attachments: writtenAttachments,
          ...(output === undefined ? {} : { output }),
        };
  let admitted: Awaited<ReturnType<typeof chatRepo.admitChatRun>>;
  try {
    admitted = await chatRepo.admitChatRun(deps.db, {
      agentId,
      message: messageText,
      subject: { kind: 'user', businessId: principal.businessId },
      ...(agentVersion === null ? {} : { agentVersion }),
      trigger: 'chat',
      ...(requestedConversationId === undefined ? {} : { conversationId: requestedConversationId }),
      ...(userContent === undefined ? {} : { userContent }),
    });
  } catch (err) {
    if (
      writtenAttachments !== undefined &&
      attachmentSlug !== undefined &&
      requestedConversationId !== undefined
    ) {
      await removeWrittenAttachments({
        root: deps.config.WORKSPACES_DIR,
        slug: attachmentSlug,
        conversationId: requestedConversationId,
        attachments: writtenAttachments,
      }).catch((cleanupErr: unknown) => {
        deps.log.warn({ err: cleanupErr }, 'attachment cleanup after admission failure failed');
      });
    }
    if (createdConversationId !== undefined) {
      await deleteCreatedConversation(deps, createdConversationId, principal.businessId).catch(
        () => undefined,
      );
    }
    throw err;
  }
  const { run, conversationId, inherited } = admitted;
  try {
    await getQueue().add(
      'run',
      {
        runId: run.id,
        agentId,
        conversationId,
        prompt: messageText,
      },
      runEnqueueOptions(run.id),
    );
  } catch {
    try {
      await failQueuedRunEnqueue(deps.db, run.id);
    } catch {
      deps.log.warn({ runId: run.id }, 'chat enqueue failure cleanup failed');
    }
    fail('SERVICE_UNAVAILABLE', '运行入队失败，请稍后重试');
  }
  deps.log.info({ runId: run.id }, 'run enqueued');
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: principal.businessId,
    action: 'agent.run.requested',
    target: run.id,
    input: {
      agentId,
      prompt: messageText,
      ...(writtenAttachments === undefined
        ? {}
        : {
            attachmentCount: writtenAttachments.length,
            attachmentNames: writtenAttachments.map(({ filename }) => filename),
          }),
      ...(openuiAction === undefined
        ? {}
        : {
            openuiAction: openuiAction.type,
            ...(openuiAction.messageId === undefined
              ? {}
              : { openuiMessageId: openuiAction.messageId }),
            ...(openuiAction.blockKey === undefined
              ? {}
              : { openuiBlockKey: openuiAction.blockKey }),
          }),
    },
    status: 'ok',
    requestId: deps.requestId,
  });
  if (inherited.length > 0) {
    await repo.audit.writeAudit(deps.db, deps.log, {
      actor: principal.businessId,
      action: 'agent.run.approvals_inherited',
      target: run.id,
      input: { toolNames: inherited },
      status: 'ok',
      requestId: deps.requestId,
    });
  }
  return {
    runId: run.id,
    conversationId,
    ...(writtenAttachments === undefined || writtenAttachments.length === 0
      ? {}
      : { attachments: writtenAttachments }),
  };
}
