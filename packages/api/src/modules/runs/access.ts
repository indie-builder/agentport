import { AppError, isAppError } from '@agentport/core';
import { repo } from '@agentport/db';
import { authorizeObject } from '../../http/access.js';
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
    | 'runs.questions.answer',
) {
  const run = await repo.chat.getRun(context.db, runId);
  if (!run || run.channelId !== null) throw new AppError('RUN_NOT_FOUND', RUN_MISSING);
  try {
    await authorizeObject(
      context,
      permissionId,
      { objectId: run.id, createdBy: run.initiatedBy, privateContent: true },
      RUN_MISSING,
    );
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND')
      throw new AppError('RUN_NOT_FOUND', RUN_MISSING);
    throw error;
  }
  return run;
}
