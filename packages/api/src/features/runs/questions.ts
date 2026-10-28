import { repo } from '@agentport/db';
import {
  idParams,
  publicQuestionResponseSchema,
  publicRunQuestion,
  publicRunQuestionSchema,
} from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { reject } from '../../plugins/errors.js';
import { isRunCancelRequested } from '../../queue/producer.js';
import { typed } from '../../types.js';

const questionsRepo = repo.questions;
const runsRepo = repo.runs;

const responseParams = idParams.extend({ requestId: z.string().min(1).max(256) });
const listSchema = z.object({ items: z.array(publicRunQuestionSchema) });

/** 澄清提问的读取与回答；回答只是一次输入，不构成工具授权。 */
export function registerRunQuestionRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.get(
    '/api/runs/:id/questions',
    { ...auth, schema: { params: idParams, response: { 200: listSchema } } },
    async (request, reply) => {
      const agentId = await runsRepo.getRunAgentId(app.db, request.params.id);
      if (!agentId) {
        return reject(reply, 'RUN_NOT_FOUND', '运行记录不存在，可能已被清理；请刷新运行列表');
      }
      return {
        items: (await questionsRepo.listQuestions(app.db, request.params.id)).map(
          publicRunQuestion,
        ),
      };
    },
  );

  app.post(
    '/api/runs/:id/questions/:requestId/response',
    {
      ...auth,
      schema: {
        params: responseParams,
        body: publicQuestionResponseSchema,
        response: { 200: publicRunQuestionSchema },
      },
    },
    async (request, reply) => {
      const { id: runId, requestId } = request.params;
      if (await isRunCancelRequested(runId)) {
        return reject(reply, 'CONFLICT', '运行正在停止，无法回答这次提问');
      }
      const question = await questionsRepo.respondToQuestion(
        app.db,
        runId,
        requestId,
        request.body,
      );
      if (!question) {
        return reject(reply, 'NOT_FOUND', '这次提问不存在，可能已失效；请刷新后重试');
      }
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.run.question.responded',
        target: runId,
        input: { requestId, status: question.status },
        status: 'ok',
        requestId: request.id,
      });
      return publicRunQuestion(question);
    },
  );
}
