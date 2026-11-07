import { runsContract } from '@agentport/contract/runs';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import { publicRunQuestion } from '@agentport/shared';
import { implement } from '@orpc/server';
import { actorOf } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { isRunCancelRequested } from '../../queue/producer.js';
import { authorizeRun } from './access.js';

const questionsRepo = repo.questions;
const os = implement(runsContract).$context<RequestContext>();
export const runsQuestionsRouter = {
  questions: os.questions.handler(async ({ input, context }) => {
    await authorizeRun(context, input.params.id, 'runs.read');
    return {
      items: (await questionsRepo.listQuestions(context.db, input.params.id)).map(
        publicRunQuestion,
      ),
    };
  }),
  respondToQuestion: os.respondToQuestion.handler(async ({ input, context }) => {
    const { id: runId, requestId } = input.params;
    await authorizeRun(context, runId, 'runs.questions.answer');
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
    await repo.audit.writeAudit(context.db, context.log, {
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
