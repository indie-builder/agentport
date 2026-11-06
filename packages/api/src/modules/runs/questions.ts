import { runsContract } from '@agentport/contract/runs';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import { publicRunQuestion } from '@agentport/shared';
import { implement } from '@orpc/server';
import { actorOf, authorizeObject } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { AppError } from '../../http/errors.js';
import { writeAudit } from '../../plugins/audit.js';
import { isRunCancelRequested } from '../../queue/producer.js';

const questionsRepo = repo.questions;
const chatRepo = repo.chat;
const RUN_MISSING = '运行记录不存在，可能已被清理；请刷新运行列表';
async function authorizeRunAccess(
  context: RequestContext,
  runId: string,
  permissionId: 'runs.read' | 'runs.questions.answer',
) {
  const run = await chatRepo.getRun(context.db, runId);
  if (!run) throw new AppError('RUN_NOT_FOUND', RUN_MISSING);
  if (run.channelId !== null) throw new AppError('RUN_NOT_FOUND', RUN_MISSING);
  await authorizeObject(
    context,
    permissionId,
    { objectId: run.id, createdBy: run.initiatedBy, privateContent: true },
    RUN_MISSING,
  );
}
const os = implement(runsContract).$context<RequestContext>();
export const runsQuestionsRouter = {
  questions: os.questions.handler(async ({ input, context }) => {
    await authorizeRunAccess(context, input.params.id, 'runs.read');
    return {
      items: (await questionsRepo.listQuestions(context.db, input.params.id)).map(
        publicRunQuestion,
      ),
    };
  }),
  respondToQuestion: os.respondToQuestion.handler(async ({ input, context }) => {
    const { id: runId, requestId } = input.params;
    await authorizeRunAccess(context, runId, 'runs.questions.answer');
    if (await isRunCancelRequested(runId)) {
      return fail('CONFLICT', '运行正在停止，无法回答这次提问');
    }
    const question = await questionsRepo.respondToQuestion(
      context.db,
      runId,
      requestId,
      input.body,
    );
    if (!question) {
      return fail('NOT_FOUND', '这次提问不存在，可能已失效；请刷新后重试');
    }
    await writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'agent.run.question.responded',
      target: runId,
      input: { requestId, status: question.status },
      status: 'ok',
      requestId: context.requestId,
    });
    return publicRunQuestion(question);
  }),
};
