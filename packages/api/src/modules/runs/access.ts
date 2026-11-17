import { fail, isAppError, notFound } from '@agentport/core';
import { repo } from '@agentport/db';
import type { ChannelRole } from '@agentport/shared';
import { authorizeObject, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';

export const RUN_MISSING = '运行记录不存在，可能已被清理；请刷新运行列表';

export async function authorizeRun(
  context: RequestContext,
  runId: string,
  permissionId:
    | 'runs.read'
    | 'runs.approve'
    | 'runs.cancel'
    | 'runs.export'
    | 'runs.feedback'
    | 'runs.questions.answer',
) {
  const run = await repo.chat.getRun(context.db, runId);
  if (!run || run.channelId !== null) notFound('run');
  try {
    await authorizeObject(
      context,
      permissionId,
      { objectId: run.id, createdBy: run.initiatedBy, privateContent: true },
      RUN_MISSING,
    );
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound('run');
    throw error;
  }
  return run;
}

export async function authorizeRunFeedback(
  context: RequestContext,
  runId: string,
  permissionId: 'runs.read' | 'runs.feedback',
): Promise<{
  run: NonNullable<Awaited<ReturnType<typeof repo.chat.getRun>>>;
  channelRole: ChannelRole | null;
}> {
  const run = await repo.chat.getRun(context.db, runId);
  if (!run) notFound('run', RUN_MISSING);
  if (run.channelId === null) {
    try {
      await authorizeObject(
        context,
        permissionId,
        { objectId: run.id, createdBy: run.initiatedBy, privateContent: true },
        RUN_MISSING,
      );
    } catch (error) {
      if (isAppError(error) && error.code === 'NOT_FOUND') notFound('run');
      throw error;
    }
    return { run, channelRole: null };
  }
  const access = await repo.channelControl.getChannelRunForMember(
    context.db,
    requireUser(context).businessId,
    run.channelId,
    run.id,
  );
  if (!access) notFound('run', RUN_MISSING);
  if (permissionId === 'runs.feedback' && access.role === 'viewer') {
    fail('FORBIDDEN', '当前频道角色无权验收');
  }
  return { run, channelRole: access.role };
}
