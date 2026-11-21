import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  canonicalJson,
  conversationInputsDir,
  decodeAttachmentInput,
  displayAttachmentFilename,
  fail,
  notFound,
  readConversationAttachment,
  sha256Hex,
  writeConversationAttachments,
} from '@agentport/core';
import { logEvent } from '@agentport/core/logger';
import { type Database, newId, repo } from '@agentport/db';
import {
  type AccessResource,
  attachmentByteLimit,
  attachmentExtension,
  type ChatRequest,
  isTextAttachment,
  type MessageAttachment,
  messageAttachments,
  type PermissionId,
  type Principal,
  RUNS_QUEUE,
  runEnqueueOptions,
} from '@agentport/shared';
import type { SQL } from 'bun';
import type { Logger } from 'pino';
import type { Config } from '../../config.js';
import { getQueue } from '../../queue/producer.js';
import { runQueueHasCapacity } from '../runs/capacity.js';
import { enqueueRunJob, failQueuedRunEnqueue, failRunEnqueue } from '../runs/enqueue.js';
import { deleteConversationWithSandboxes } from '../runtime/runtime-deletion.js';
import { enforceContentPolicy } from '../security/policy-gate.js';
import { CONVERSATION_MISSING } from './access.js';
import {
  checkOpenUiActionSource,
  OPENUI_ACTION_MAX_BYTES,
  openUiActionContent,
  openUiActionContentSchema,
  openUiActionPolicyTexts,
  sourcePairingProblem,
} from './openui-actions.js';
import { checkOutputSelection } from './outputs.js';
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
  options?: {
    trigger?: 'chat' | 'event';
    auditInput?: Record<string, unknown>;
    externalRequest?: repo.chat.ExternalRequest;
  },
) {
  const { openuiAction, attachments, ...chatInput } = body;
  const { message, output } = chatInput;
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
  const originalParts = openuiAction === undefined ? undefined : openUiActionContent(openuiAction);
  const originalAction = originalParts === undefined ? '' : JSON.stringify(originalParts);
  if (Buffer.byteLength(originalAction) > OPENUI_ACTION_MAX_BYTES) {
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
      return fail(
        outputProblem.code,
        outputProblem.message,
        outputProblem.resource === undefined ? {} : { resource: outputProblem.resource },
      );
    }
  }
  const agentId = chatInput.agentId ?? (await repo.agents.getDefaultAgent(deps.db))?.id;
  if (agentId === undefined) {
    return fail('SERVICE_UNAVAILABLE', '通用助手尚未初始化，请稍后重试');
  }
  if (!(await chatRepo.agentExists(deps.db, agentId))) notFound('agent');
  if (!(await chatRepo.agentEnabled(deps.db, agentId))) {
    return fail('AGENT_DISABLED', '该智能体已停用，无法发起新对话；请到智能体页面启用后再试');
  }
  await deps.authorize('agents.use', { agentId }, '智能体不存在，可能已被删除；请刷新后重新选择');
  if (body.conversationId === undefined) {
    await deps.authorize('conversations.create', {
      createdBy: principal.businessId,
    });
    if (options?.trigger === 'event') {
      await deps.authorize(
        'conversations.update',
        { createdBy: principal.businessId },
        CONVERSATION_MISSING,
      );
    }
  } else {
    const conversation = await chatRepo.getConversation(deps.db, body.conversationId);
    if (!conversation || conversation.agentId !== agentId)
      notFound('conversation', '会话不存在或不属于该智能体；请从会话列表重新打开');
    await deps.authorize(
      'conversations.update',
      { objectId: conversation.id, createdBy: conversation.createdBy, privateContent: true },
      CONVERSATION_MISSING,
    );
  }
  const externalRequest = options?.externalRequest;
  const replayExternalRun = async (run: repo.chat.AgentRun, request: repo.chat.ExternalRequest) => {
    const replayed = (current: repo.chat.AgentRun) => ({
      runId: current.id,
      conversationId: current.conversationId,
      replayed: true as const,
    });
    if (run.status === 'queued') {
      const prompt = await chatRepo.getRunUserMessageText(deps.db, run.id);
      if (prompt === null) failRunEnqueue();
      await enqueueRunJob(deps, {
        runId: run.id,
        agentId: run.agentId,
        conversationId: run.conversationId,
        prompt,
      });
      return replayed(run);
    }
    if (repo.runPredicates.isNeverStartedFailure(run)) {
      const storedText = await chatRepo.getRunUserMessageText(deps.db, run.id);
      if (storedText !== null) {
        const policyDecision = await enforceContentPolicy({
          db: deps.db,
          log: deps.log,
          requestId: deps.requestId,
          actor: run.initiatedBy ?? principal.businessId,
          anthropicBaseUrl: deps.config.ANTHROPIC_BASE_URL,
          texts: [storedText],
          payload: ([text]) => ({
            data: text,
            binding: { runId: run.id, idempotencyKey: request.idempotencyKey, text },
          }),
          agentId: run.agentId,
          origin: 'external',
          sourceKind: 'run_prompt',
          sourceId: `external:${request.sourceKind}:${request.sourceId}:${request.idempotencyKey}`,
          runId: run.id,
        });
        if (policyDecision.approvalId !== null) {
          const approval = await repo.security.getPolicyApproval(
            deps.db,
            policyDecision.approvalId,
          );
          if (approval?.status !== 'approved') {
            fail('CONTENT_APPROVAL_REQUIRED', '敏感内容外发需要审批', {
              resource: 'policy_approval',
              resourceId: policyDecision.approvalId,
              hint: '审批后重试同一请求',
            });
          }
        }
        const prompt = policyDecision.payload;
        if (
          await chatRepo.requeueInfraFailedRun(
            deps.db,
            run.id,
            prompt,
            policyDecision.approvalId ?? undefined,
          )
        ) {
          await enqueueRunJob(deps, {
            runId: run.id,
            agentId: run.agentId,
            conversationId: run.conversationId,
            prompt,
          });
          return replayed(run);
        }
        const latest = await chatRepo.getRun(deps.db, run.id);
        if (latest === null) failRunEnqueue();
        if (latest.status === 'queued') {
          await enqueueRunJob(deps, {
            runId: latest.id,
            agentId: latest.agentId,
            conversationId: latest.conversationId,
            prompt,
          });
          return replayed(latest);
        }
        if (repo.runPredicates.isNeverStartedFailure(latest)) {
          failRunEnqueue();
        }
        return replayed(latest);
      }
      failRunEnqueue();
    }
    return replayed(run);
  };
  if (externalRequest !== undefined) {
    const run = await chatRepo.findExternalRequestRun(deps.db, externalRequest);
    if (run !== null) return replayExternalRun(run, externalRequest);
  }
  if (!(await runQueueHasCapacity())) {
    return fail('SERVICE_UNAVAILABLE', '运行队列已满，请稍后重试');
  }
  const agent = await repo.agents.getAgent(deps.db, agentId);
  if (!agent) return notFound('agent');
  const agentVersion = agent.publishedVersion;
  const uploads = (attachments ?? []).map(decodeAttachmentInput).map((attachment) => ({
    attachment,
    text: isTextAttachment(attachment.mimeType) ? attachment.data.toString('utf8') : '',
  }));
  const policyDecision = await enforceContentPolicy({
    db: deps.db,
    log: deps.log,
    requestId: deps.requestId,
    actor: principal.businessId,
    anthropicBaseUrl: deps.config.ANTHROPIC_BASE_URL,
    texts: [message ?? '', openuiAction?.message ?? '', ...uploads.map(({ text }) => text)],
    extraTexts: [
      ...uploads.map(({ attachment }) => attachment.filename),
      ...(openuiAction === undefined || originalParts === undefined
        ? []
        : new Set([
            ...openUiActionPolicyTexts(openuiAction),
            ...openUiActionPolicyTexts(originalParts[1]),
          ])),
    ],
    payload: ([text, actionText, ...attachmentTexts]) => {
      const parts =
        originalParts === undefined
          ? undefined
          : ([
              { ...originalParts[0], text: actionText ?? originalParts[0].text },
              originalParts[1],
            ] satisfies ReturnType<typeof openUiActionContent>);
      const finalAttachments = uploads.map(({ attachment, text: original }, index) => {
        const redacted = attachmentTexts[index];
        if (redacted === undefined || redacted === original) return attachment;
        const data = Buffer.from(redacted, 'utf8');
        if (data.length > attachmentByteLimit(attachment.mimeType)) {
          fail('PAYLOAD_TOO_LARGE', '脱敏后的附件超过文件大小上限，请缩小附件后重试');
        }
        return { ...attachment, data, size: data.length, sha256: sha256Hex(data) };
      });
      return {
        data: { message: text, openuiAction: parts, attachments: finalAttachments },
        binding: {
          conversationId: body.conversationId ?? null,
          message: text,
          submittedMessageHash: sha256Hex(message ?? ''),
          openuiAction: parts,
          submittedActionHash: sha256Hex(canonicalJson(openuiAction ?? null)),
          output,
          attachments: finalAttachments.map(({ filename, sha256 }, index) => ({
            filename,
            sha256,
            submittedSha256: uploads[index]?.attachment.sha256,
          })),
        },
      };
    },
    agentId,
    ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
    origin: externalRequest !== undefined || options?.trigger === 'event' ? 'external' : 'chat',
    sourceKind: 'run_prompt',
    sourceId: body.conversationId ?? deps.requestId,
  });
  const {
    message: messageText,
    openuiAction: actionParts,
    attachments: finalAttachments,
  } = policyDecision.payload;
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
      if (!conversation || conversation.agentId !== agentId)
        notFound('conversation', '会话不存在或不属于该智能体；请从会话列表重新打开');
    }
    const agentSlug = await repo.agents.findAgentSlug(deps.db, agentId);
    if (agentSlug === null) {
      if (createdConversationId !== undefined) {
        await deleteCreatedConversation(deps, createdConversationId, principal.businessId).catch(
          () => undefined,
        );
      }
      notFound('agent');
    }
    attachmentSlug = agentSlug;
    try {
      writtenAttachments = await writeConversationAttachments({
        root: deps.config.WORKSPACES_DIR,
        slug: agentSlug,
        conversationId: requestedConversationId,
        attachments: finalAttachments,
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
    actionParts === undefined
      ? {
          type: 'text',
          text: messageText,
          ...(writtenAttachments === undefined ? {} : { attachments: writtenAttachments }),
          ...(output === undefined ? {} : { output }),
        }
      : output === undefined
        ? actionParts
        : [{ ...actionParts[0], output }, actionParts[1]];
  let admitted: Awaited<ReturnType<typeof chatRepo.admitChatRun>>;
  try {
    admitted = await chatRepo.admitChatRun(deps.db, {
      agentId,
      message: messageText,
      subject: { kind: 'user', businessId: principal.businessId },
      ...(agentVersion === null ? {} : { agentVersion }),
      trigger: options?.trigger ?? 'chat',
      ...(requestedConversationId === undefined ? {} : { conversationId: requestedConversationId }),
      userContent,
      ...(policyDecision.eventId === null ? {} : { policyEventId: policyDecision.eventId }),
      ...(policyDecision.approvalId === null
        ? {}
        : { consumePolicyApprovalId: policyDecision.approvalId }),
      ...(externalRequest === undefined ? {} : { externalRequest }),
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
  const { run, conversationId } = admitted;
  if (admitted.replayed === true) {
    return externalRequest === undefined
      ? { runId: run.id, conversationId, replayed: true as const }
      : replayExternalRun(run, externalRequest);
  }
  await enqueueRunJob(deps, { runId: run.id, agentId, conversationId, prompt: messageText });
  logEvent(deps.log, 'run enqueued', { runId: run.id, queue: RUNS_QUEUE });
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: principal.businessId,
    action: 'agent.run.requested',
    target: run.id,
    input: options?.auditInput ?? {
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
  return {
    runId: run.id,
    conversationId,
    ...(writtenAttachments === undefined || writtenAttachments.length === 0
      ? {}
      : { attachments: writtenAttachments }),
  };
}
export async function regenerateLastRun(
  principal: Extract<Principal, { kind: 'user' }>,
  conversationId: string,
  deps: StartRunDependencies,
) {
  const conversation = await chatRepo.getConversation(deps.db, conversationId);
  if (!conversation) notFound('conversation', '会话不存在或已被删除；请刷新后重试');
  const agentId = conversation.agentId;
  if (!(await chatRepo.agentExists(deps.db, agentId))) notFound('agent');
  if (!(await chatRepo.agentEnabled(deps.db, agentId))) {
    return fail('AGENT_DISABLED', '该智能体已停用，无法重新生成；请到智能体页面启用后再试');
  }
  await deps.authorize('agents.use', { agentId }, '智能体不存在，可能已被删除；请刷新后重新选择');
  await deps.authorize(
    'conversations.update',
    { objectId: conversation.id, createdBy: conversation.createdBy, privateContent: true },
    CONVERSATION_MISSING,
  );
  if (!(await runQueueHasCapacity())) {
    return fail('SERVICE_UNAVAILABLE', '运行队列已满，请稍后重试');
  }
  const agent = await repo.agents.getAgent(deps.db, agentId);
  if (!agent) return notFound('agent');
  const agentVersion = agent.publishedVersion;
  const last = await chatRepo.getLastUserMessage(deps.db, conversationId);
  if (last === null || last.runId === null) return fail('CONFLICT', '该会话没有可重新生成的回复');
  const originalText = chatRepo.messageText(last.content) ?? '';
  const parsedParts = openUiActionContentSchema.safeParse(last.content);
  const originalParts = parsedParts.success ? parsedParts.data : undefined;
  const attachments = messageAttachments(last.content);
  const attachmentTexts = await Promise.all(
    attachments
      .filter(({ mimeType }) => isTextAttachment(mimeType))
      .map(async (attachment) => {
        const { data } = await readConversationAttachment({
          root: deps.config.WORKSPACES_DIR,
          slug: agent.slug,
          conversationId,
          attachment,
        });
        return data.toString('utf8');
      }),
  );
  const policyDecision = await enforceContentPolicy({
    db: deps.db,
    log: deps.log,
    requestId: deps.requestId,
    actor: principal.businessId,
    anthropicBaseUrl: deps.config.ANTHROPIC_BASE_URL,
    agentId,
    conversationId,
    origin: 'regenerate',
    texts: [originalText],
    extraTexts: [
      ...attachmentTexts,
      ...attachments.map(({ filename }) => filename),
      ...(originalParts === undefined ? [] : openUiActionPolicyTexts(originalParts[1])),
    ],
    payload: ([text]) => ({
      data: {
        message: text,
        openuiAction:
          originalParts === undefined
            ? undefined
            : [{ ...originalParts[0], text }, originalParts[1]],
      },
      binding: {
        conversationId,
        messageId: last.id,
        message: text,
        storedTextHash: sha256Hex(originalText),
        openuiAction: originalParts,
        attachments: attachments.map(({ filename, sha256 }) => ({ filename, sha256 })),
      },
    }),
    sourceKind: 'run_prompt',
    sourceId: last.id,
  });
  const admitted = await chatRepo.admitChatRun(deps.db, {
    agentId,
    message: '',
    subject: { kind: 'user', businessId: principal.businessId },
    ...(agentVersion === null ? {} : { agentVersion }),
    trigger: 'chat',
    conversationId,
    regenerate: true,
    regeneratePrompt: { messageId: last.id, text: policyDecision.payload.message },
    ...(policyDecision.approvalId === null
      ? {}
      : { consumePolicyApprovalId: policyDecision.approvalId }),
    ...(policyDecision.eventId === null ? {} : { policyEventId: policyDecision.eventId }),
  });
  const { run, regenerate } = admitted;
  if (regenerate === undefined) return fail('CONFLICT', '该会话没有可重新生成的回复');
  try {
    await getQueue().add(
      'run',
      {
        runId: run.id,
        agentId,
        conversationId,
        prompt: regenerate.prompt,
        requestId: deps.requestId,
        replacesRunId: regenerate.replacesRunId,
        regenerateContent: {
          openuiAction: policyDecision.payload.openuiAction,
        },
        ...(regenerate.forkFromMessageUuid === undefined
          ? {}
          : { forkFromMessageUuid: regenerate.forkFromMessageUuid }),
      },
      runEnqueueOptions(run.id),
    );
  } catch {
    try {
      await failQueuedRunEnqueue(deps.db, run.id);
    } catch {
      deps.log.warn({ runId: run.id }, 'regenerate enqueue failure cleanup failed');
    }
    failRunEnqueue();
  }
  deps.log.info(
    { runId: run.id, replacesRunId: regenerate.replacesRunId },
    'regenerate run enqueued',
  );
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: principal.businessId,
    action: 'agent.run.requested',
    target: run.id,
    input: { agentId, regenerateOf: regenerate.replacesRunId },
    status: 'ok',
    requestId: deps.requestId,
  });
  return { runId: run.id, conversationId };
}
