import { runsContract } from '@agentport/contract/runs';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import { publicRunQuestion } from '@agentport/shared';
import { implement } from '@orpc/server';
import { actorOf } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { isRunCancelRequested } from '../../queue/producer.js';
import { enforceContentPolicy } from '../security/policy-gate.js';
import { authorizeRun } from './access.js';

const questionsRepo = repo.questions;

export async function answerRunQuestion(
  context: RequestContext,
  runId: string,
  requestId: string,
  body: Parameters<typeof questionsRepo.respondToQuestion>[3],
): Promise<ReturnType<typeof publicRunQuestion>> {
  if (await isRunCancelRequested(runId)) {
    fail('CONFLICT', '运行正在停止，无法回答这次提问');
  }
  const sourceId = `question:${runId}:${requestId}`;
  if ('answers' in body) {
    const [run, questions] = await Promise.all([
      repo.chat.getRun(context.db, runId),
      questionsRepo.listQuestions(context.db, runId),
    ]);
    const question = questions.find((item) => item.requestId === requestId);
    if (run === null || question === undefined) {
      fail('NOT_FOUND', '这次提问不存在，可能已失效；请刷新后重试');
    }
    const answers = questionsRepo.buildQuestionAnswers(question.questions, body);
    const originalTexts = question.questions.map((item) => answers[item.question] ?? '');
    const [first, ...rest] = originalTexts;
    if (first !== undefined) {
      const decision = await enforceContentPolicy({
        db: context.db,
        log: context.log,
        requestId: context.requestId,
        actor: actorOf(context),
        agentId: run.agentId,
        runId,
        origin: 'question',
        sourceKind: 'run_prompt',
        sourceId,
        texts: [first, ...rest],
        payload: (texts) => ({
          data: texts.some((text, index) => text !== originalTexts[index])
            ? {
                ...body,
                choices: {},
                answers: Object.fromEntries(texts.map((text, index) => [String(index), text])),
              }
            : body,
          binding: { runId, requestId, answers },
        }),
      });
      body = decision.payload;
    }
  }
  const question = await questionsRepo.respondToQuestion(context.db, runId, requestId, body);
  if (!question) {
    fail('NOT_FOUND', '这次提问不存在，可能已失效；请刷新后重试');
  }
  await repo.notifications.markBySource(context.db, 'question', sourceId).catch((err: unknown) => {
    context.log.warn({ err, runId, requestId }, 'question notification mark-read failed');
  });
  await repo.audit.writeAudit(context.db, context.log, {
    actor: actorOf(context),
    action: 'agent.run.question.responded',
    target: runId,
    input: { requestId, status: question.status },
    status: 'ok',
    requestId: context.requestId,
  });
  return publicRunQuestion(question);
}

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
    return answerRunQuestion(context, runId, requestId, input.body);
  }),
};
