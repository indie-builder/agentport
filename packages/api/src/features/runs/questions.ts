import { repo } from '@agentport/db';
import {
  idParams,
  publicQuestionResponseSchema,
  publicRunQuestion,
  publicRunQuestionSchema,
} from '@agentport/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { AppError, reject } from '../../plugins/errors.js';
import { isRunCancelRequested } from '../../queue/producer.js';
import { typed } from '../../types.js';
import { actorOf, authorizeObject } from '../access.js';

const questionsRepo = repo.questions;
const chatRepo = repo.chat;

const RUN_MISSING = '运行记录不存在，可能已被清理；请刷新运行列表';

/** 问题属于运行私有正文：本人 O 或对应叶 P，服务运行只有 P。 */
async function authorizeRunAccess(
  app: FastifyInstance,
  request: FastifyRequest,
  runId: string,
  permissionId: 'runs.read' | 'runs.questions.answer',
) {
  const run = await chatRepo.getRun(app.db, runId);
  if (!run) throw new AppError('RUN_NOT_FOUND', RUN_MISSING);
  // 频道 run 的 initiatedBy 是触发者；M2 私有入口不做频道授权，统一按不存在处理。
  if (run.channelId !== null) throw new AppError('RUN_NOT_FOUND', RUN_MISSING);
  await authorizeObject(
    app,
    request,
    permissionId,
    { objectId: run.id, createdBy: run.initiatedBy, privateContent: true },
    RUN_MISSING,
  );
}

const responseParams = idParams.extend({ requestId: z.string().min(1).max(256) });
const listSchema = z.object({ items: z.array(publicRunQuestionSchema) });

/** 澄清提问的读取与回答；回答只是一次输入，不构成工具授权。 */
export function registerRunQuestionRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);

  app.get(
    '/api/runs/:id/questions',
    {
      config: { access: { kind: 'permission', permissionId: 'runs.read' } },
      schema: { params: idParams, response: { 200: listSchema } },
    },
    async (request) => {
      await authorizeRunAccess(app, request, request.params.id, 'runs.read');
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
      config: { access: { kind: 'permission', permissionId: 'runs.questions.answer' } },
      schema: {
        params: responseParams,
        body: publicQuestionResponseSchema,
        response: { 200: publicRunQuestionSchema },
      },
    },
    async (request, reply) => {
      const { id: runId, requestId } = request.params;
      await authorizeRunAccess(app, request, runId, 'runs.questions.answer');
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
        actor: actorOf(request),
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
