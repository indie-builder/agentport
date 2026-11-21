import { channelsContract } from '@agentport/contract/channels';
import { fail, isAppError, removeChannelInputs, writeChannelAttachments } from '@agentport/core';
import { newId, repo } from '@agentport/db';
import {
  ATTACHMENT_LIMITS,
  attachmentByteLimit,
  attachmentMimeForFilename,
  type ChatAttachmentInput,
  isActiveRunStatus,
  type MessageAttachment,
} from '@agentport/shared';
import { implement } from '@orpc/server';
import { actorOf, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { listWorkspaceOutputs, readWorkspaceOutput } from '../../lib/outputs.js';
import { getQueue } from '../../queue/producer.js';
import { loadReadableConversation } from '../chat/access.js';
import { notFound } from './errors.js';
import { publishChannelMessageSafely } from './publish.js';
import { dispatchChannelWakes } from './wakes.js';

const channelRepo = repo.channels;
const HANDOFF_BODY_LIMIT = 32000;
const HANDOFF_FIRST_USER_CHARS = 500;
const HANDOFF_LAST_ASSISTANT_CHARS = 2000;

function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

const os = implement(channelsContract).$context<RequestContext>();
export const channelsHandoffRouter = {
  handoff: os.handoff.handler(async ({ input, context }) => {
    const principal = requireUser(context);
    const { id } = input.params;
    const subject = { businessId: principal.businessId };
    const detail = await channelRepo.getChannelDetail(context.db, subject, id);
    if ('kind' in detail) return notFound();
    const role = detail.members.find((member) => member.businessId === principal.businessId)?.role;
    if (role === undefined) return notFound();
    if (role === 'viewer') return fail('FORBIDDEN', 'viewer 不能发起交接');
    if (detail.channel.archivedAt !== null) return fail('CONFLICT', '频道已关闭，不能发起交接');
    const binding = detail.agentBindings.find((item) => item.agentId === input.body.targetAgentId);
    if (binding === undefined || binding.status !== 'active') {
      return notFound('目标智能体不在频道内或已断开');
    }
    const targetAgent = await repo.agents.getAgent(context.db, input.body.targetAgentId);
    if (!targetAgent?.enabled) return notFound('目标智能体不存在或已停用');
    const targetActiveRun = await repo.channelWakes.findActiveChannelRunForAgent(context.db, {
      channelId: id,
      agentId: targetAgent.id,
    });
    if (targetActiveRun !== null) {
      return fail('CONFLICT', '目标智能体正在运行，请等本轮结束后再交接');
    }

    const source = await repo.runs.getRunDetail(context.db, input.body.sourceRunId);
    if (!source) return notFound('来源运行不存在，可能已被删除');
    if (source.run.channelId !== null) {
      const access = await repo.channelControl.getChannelRunForMember(
        context.db,
        principal.businessId,
        source.run.channelId,
        source.run.id,
      );
      if (!access) return notFound('来源运行不存在，可能已被删除');
    } else {
      await loadReadableConversation(context, source.run.conversationId);
    }
    if (isActiveRunStatus(source.run.status)) {
      return fail('CONFLICT', '运行结束后才能交接');
    }
    if (source.run.agentId === targetAgent.id) {
      return fail('INVALID_INPUT', '不能交接给来源智能体自身');
    }
    const sourceAgent = await repo.agents.getAgent(context.db, source.run.agentId);
    if (!sourceAgent) return notFound('来源智能体不存在，可能已被删除');

    const triggerMessage =
      source.run.channelId !== null && source.run.channelTriggerMessageId !== null
        ? await channelRepo.getMessageForMember(
            context.db,
            principal.businessId,
            source.run.channelId,
            source.run.channelTriggerMessageId,
          )
        : null;
    const firstUser =
      triggerMessage?.body || source.steps.find((step) => step.kind === 'user')?.text || '';

    const outputs = await listWorkspaceOutputs(context, {
      slug: sourceAgent.slug,
      conversationId: source.run.conversationId,
      runId: source.run.id,
      limit: 20,
    });

    const picked: Array<(typeof outputs.items)[number]> = [];
    let pickedBytes = 0;
    for (const file of outputs.items) {
      if (picked.length >= ATTACHMENT_LIMITS.count) break;
      const mime = attachmentMimeForFilename(file.path);
      if (mime === null) continue;
      if (file.size === 0 || file.size > attachmentByteLimit(mime)) continue;
      if (pickedBytes + file.size > ATTACHMENT_LIMITS.totalBytes) continue;
      picked.push(file);
      pickedBytes += file.size;
    }

    const messageId = newId('channelMessage');
    const discardAttachments = async (): Promise<void> => {
      try {
        await removeChannelInputs({
          root: context.config.WORKSPACES_DIR,
          channelId: id,
          messageId,
        });
      } catch (err) {
        context.log.warn(
          { err, channelId: id, messageId },
          'channel handoff attachment cleanup failed',
        );
      }
    };

    const written: MessageAttachment[] = [];
    if (picked.length > 0) {
      try {
        for (const file of picked) {
          let input: ChatAttachmentInput;
          try {
            const { data } = await readWorkspaceOutput(context, {
              slug: sourceAgent.slug,
              conversationId: source.run.conversationId,
              runId: source.run.id,
              path: file.path,
            });
            input = {
              filename: file.path.split('/').at(-1) ?? file.path,
              dataBase64: data.toString('base64'),
            };
          } catch (err) {
            if (isAppError(err) && (err.code === 'NOT_FOUND' || err.code === 'INVALID_INPUT')) {
              context.log.warn({ err, path: file.path }, 'handoff output skipped');
              continue;
            }
            throw err;
          }
          try {
            const [attachment] = await writeChannelAttachments({
              root: context.config.WORKSPACES_DIR,
              channelId: id,
              messageId,
              inputs: [input],
            });
            if (attachment !== undefined) written.push(attachment);
          } catch (err) {
            if (isAppError(err) && err.code === 'INVALID_INPUT') {
              context.log.warn({ err, path: file.path }, 'handoff output attachment skipped');
              continue;
            }
            throw err;
          }
        }
      } catch (err) {
        await discardAttachments();
        throw err;
      }
    }

    const lastAssistant = [...source.steps]
      .reverse()
      .find((step) => step.kind === 'assistant')?.text;
    const lines = [
      `【运行交接】来自智能体「${sourceAgent.name}」的运行 ${source.run.id}。`,
      '',
      '原任务：',
      clip(firstUser, HANDOFF_FIRST_USER_CHARS) || '（无记录）',
      '',
      '最近回复：',
      clip(lastAssistant ?? '', HANDOFF_LAST_ASSISTANT_CHARS) || '（无记录）',
      '',
      '成果引用：',
      ...(outputs.items.length === 0
        ? ['（本次运行没有成果文件）']
        : outputs.items.map((file) => `- ${file.path}`)),
      ...(input.body.note === undefined || input.body.note === ''
        ? []
        : ['', '备注：', input.body.note]),
      '',
      `请「${targetAgent.name}」基于以上上下文继续推进。`,
    ];
    const body = clip(lines.join('\n'), HANDOFF_BODY_LIMIT);

    let result: Awaited<ReturnType<typeof channelRepo.postMessage>>;
    try {
      result = await channelRepo.postMessage(context.db, subject, id, {
        id: messageId,
        body,
        mentions: [targetAgent.id],
        ...(written.length === 0 ? {} : { attachments: written }),
      });
    } catch (err) {
      await discardAttachments();
      throw err;
    }
    if (result.kind !== 'ok' || result.duplicate) {
      await discardAttachments();
    }
    switch (result.kind) {
      case 'not_found':
        return notFound();
      case 'forbidden':
        return fail('FORBIDDEN', 'viewer 不能发起交接');
      case 'invalid_mentions':
        return fail('INVALID_INPUT', '目标智能体不在频道内或状态异常');
      case 'too_many_wakes':
        return fail('INVALID_INPUT', '一次最多唤醒一个目标智能体');
      case 'ok': {
        if (result.duplicate) return fail('CONFLICT', '交接消息重复，请刷新后重试');
        const message = repo.channels.toChannelMessage(result.message);
        await publishChannelMessageSafely(context.log, id, message, { seq: message.seq });
        await dispatchChannelWakes({
          db: context.db,
          log: context.log,
          queue: getQueue(),
          workspacesDir: context.config.WORKSPACES_DIR,
          anthropicBaseUrl: context.config.ANTHROPIC_BASE_URL,
          channelMessageId: message.id,
        });
        await repo.audit.writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'channel.handoff.created',
          target: message.id,
          input: {
            channelId: id,
            sourceRunId: source.run.id,
            targetAgentId: targetAgent.id,
            attachmentCount: written.length,
          },
          status: 'ok',
          requestId: context.requestId,
        });
        return message;
      }
    }
  }),
};
