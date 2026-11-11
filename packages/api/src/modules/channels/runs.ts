import { channelsContract } from '@agentport/contract/channels';
import { fail, listOutputFiles, readOutputFile } from '@agentport/core';
import { repo } from '@agentport/db';
import { type OutputFile, outputContentSchema, publicRunQuestion } from '@agentport/shared';
import { implement } from '@orpc/server';
import { requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { isAppError } from '../../http/errors.js';
import { toIso } from '../../lib/iso.js';
import { agentSlug, decodeUtf8, isTextPreview, PREVIEW_MAX_BYTES } from '../chat/outputs.js';
import { answerRunQuestion } from '../runs/questions.js';

const runsRepo = repo.runs;
const questionsRepo = repo.questions;
const channelControl = repo.channelControl;
const RUN_MISSING = '运行不存在，可能已被删除';
const RUN_NOT_IN_CHANNEL = '运行不存在或不属于该频道';
const ANSWER_FORBIDDEN = '当前频道角色无权回答该提问';

async function memberRun(context: RequestContext, channelId: string, runId: string) {
  const access = await channelControl.getChannelRunForMember(
    context.db,
    requireUser(context).businessId,
    channelId,
    runId,
  );
  if (!access) return fail('NOT_FOUND', RUN_NOT_IN_CHANNEL);
  return access;
}

async function runConversation(context: RequestContext, runId: string) {
  const detail = await runsRepo.getRunDetail(context.db, runId);
  if (!detail) return fail('NOT_FOUND', RUN_MISSING);
  return detail;
}

async function readOutput(
  context: RequestContext,
  conversationId: string,
  agentId: string,
  runId: string,
  path: string,
): Promise<{ file: OutputFile; data: Buffer }> {
  const slug = await agentSlug(context, agentId);
  if (slug === null) return fail('NOT_FOUND', '成果文件不存在，可能已被清理');
  try {
    return await readOutputFile({
      root: context.config.WORKSPACES_DIR,
      slug,
      conversationId,
      runId,
      path,
    });
  } catch (err) {
    if (isAppError(err) && err.code === 'NOT_FOUND') {
      return fail('NOT_FOUND', '成果文件不存在，可能已被清理');
    }
    if (isAppError(err) && err.code === 'INVALID_INPUT') {
      return fail('INVALID_INPUT', '所选成果路径不合法；请刷新成果列表后重试');
    }
    throw err;
  }
}

export async function readChannelRunOutput(
  context: RequestContext,
  channelId: string,
  runId: string,
  path: string,
): Promise<{ file: OutputFile; data: Buffer }> {
  await memberRun(context, channelId, runId);
  const detail = await runConversation(context, runId);
  return readOutput(context, detail.conversation.id, detail.conversation.agentId, runId, path);
}

const os = implement(channelsContract).$context<RequestContext>();
export const channelsRunsRouter = {
  runDetail: os.runDetail.handler(async ({ input, context }) => {
    const { id, runId } = input.params;
    await memberRun(context, id, runId);
    const detail = await runConversation(context, runId);
    return {
      run: {
        ...detail.run,
        startedAt: toIso(detail.run.startedAt),
        endedAt: toIso(detail.run.endedAt),
      },
      steps: detail.steps,
      conversation: detail.conversation,
    };
  }),
  runQuestions: os.runQuestions.handler(async ({ input, context }) => {
    const { id, runId } = input.params;
    await memberRun(context, id, runId);
    return {
      items: (await questionsRepo.listQuestions(context.db, runId)).map(publicRunQuestion),
    };
  }),
  respondToRunQuestion: os.respondToRunQuestion.handler(async ({ input, context }) => {
    const { id, runId, requestId } = input.params;
    const businessId = requireUser(context).businessId;
    const access = await memberRun(context, id, runId);
    if (access.role === 'viewer') return fail('FORBIDDEN', ANSWER_FORBIDDEN);
    if (access.role === 'member' && access.run.initiatedBy !== businessId) {
      return fail('FORBIDDEN', ANSWER_FORBIDDEN);
    }
    return answerRunQuestion(context, runId, requestId, input.body);
  }),
  runOutputs: os.runOutputs.handler(async ({ input, context }) => {
    const { id, runId } = input.params;
    await memberRun(context, id, runId);
    const detail = await runConversation(context, runId);
    const slug = await agentSlug(context, detail.conversation.agentId);
    if (slug === null) return { items: [], nextBefore: null };
    const { limit, before } = input.query;
    try {
      return await listOutputFiles({
        root: context.config.WORKSPACES_DIR,
        slug,
        conversationId: detail.conversation.id,
        limit,
        ...(before === undefined ? {} : { before }),
        runId,
      });
    } catch (err) {
      if (before !== undefined && isAppError(err) && err.code === 'INVALID_INPUT') {
        return fail('INVALID_INPUT', 'before 游标无效，请刷新成果列表后重试');
      }
      throw err;
    }
  }),
  runOutputContent: os.runOutputContent.handler(async ({ input, context }) => {
    const { id, runId } = input.params;
    const { file, data } = await readChannelRunOutput(context, id, runId, input.query.path);
    if (data.length > PREVIEW_MAX_BYTES) {
      return fail('PAYLOAD_TOO_LARGE', '文件超过 1MiB，请下载原件查看');
    }
    if (!isTextPreview(file.mediaType)) {
      return fail('UNSUPPORTED_MEDIA_TYPE', '该文件不能直接预览，请下载原件');
    }
    const content = decodeUtf8(data);
    if (content === null) {
      return fail('UNSUPPORTED_MEDIA_TYPE', '该文件不能直接预览，请下载原件');
    }
    return outputContentSchema.parse({ file, content });
  }),
};
