import { repo as allRepo } from '@agentport/db';
import * as repo from '@agentport/db/repo/agents.js';
import type { Agent, AgentInput } from '@agentport/shared';
import { agentInputSchema, permissionModeSchema } from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { renderAgentWorkspace } from './workspace.js';

const idParams = z.object({ id: z.string().min(1) });
const versionParams = z.object({
  id: z.string().min(1),
  version: z.coerce.number().int().positive(),
});
const rollbackBody = z.object({ version: z.number().int().positive() });

/** `default` / `acceptEdits` / `auto` 依赖宿主审批通道，当前平台没有实现；保存时直接拒绝。 */
const unsupportedPermissionModes = new Set(['default', 'acceptEdits', 'auto']);

function unsupportedPermissionMode(mode: string | undefined): string | undefined {
  return mode !== undefined && unsupportedPermissionModes.has(mode)
    ? `permissionMode "${mode}" 当前平台未实现该模式，仅支持 dontAsk 与 plan`
    : undefined;
}

// 字段与 agentInputSchema 保持一致；PATCH 用显式可选字段，才能区分「没传」与「传了默认值」。
const patchSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, '仅允许小写字母、数字、- 和 _')
    .optional(),
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(300).optional(),
  model: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  serverIds: z.array(z.string()).optional(),
  skillIds: z.array(z.string()).optional(),
  subAgentIds: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  permissionMode: permissionModeSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  maxThinkingTokens: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
  /** 乐观锁：首次加载时的 updatedAt。 */
  expectedUpdatedAt: z.coerce.date().optional(),
});

function invalid(reply: FastifyReply, message: string) {
  return reply.status(400).send({ code: 'INVALID_INPUT', message });
}

function notFound(reply: FastifyReply) {
  return reply.status(404).send({ code: 'NOT_FOUND', message: 'agent not found' });
}

/** slug 上有唯一索引，冲突转 409。drizzle 把 pg 错误包在 cause 里，得顺着链找。 */
/** 外键失败意味着引用了不存在的 server/skill，属于客户端错误。 */
/** drizzle 把 pg 错误包在 cause 链里，需要逐层查找。 */
function pgCode(err: unknown): string | undefined {
  let cause: unknown = err;
  for (let depth = 0; depth < 5 && typeof cause === 'object' && cause !== null; depth += 1) {
    if ('code' in cause && typeof cause.code === 'string') return cause.code;
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return undefined;
}

function rethrowConflict(err: unknown): never {
  const code = pgCode(err);
  if (code === '23505') {
    throw Object.assign(new Error('agent slug already exists'), {
      statusCode: 409,
      code: 'CONFLICT',
    });
  }
  if (code === '23503') {
    throw Object.assign(new Error('referenced server or skill does not exist'), {
      statusCode: 400,
      code: 'INVALID_REFERENCE',
    });
  }
  throw err;
}

function toWrite(
  input: Omit<AgentInput, 'serverIds' | 'skillIds' | 'subAgentIds'>,
): repo.AgentWrite {
  return {
    slug: input.slug,
    name: input.name,
    description: input.description,
    model: input.model,
    systemPromptMd: input.systemPrompt,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    permissionMode: input.permissionMode,
    effort: input.effort ?? null,
    maxThinkingTokens: input.maxThinkingTokens ?? null,
    enabled: input.enabled,
    maxTurns: input.maxTurns,
    maxBudgetUsd: String(input.maxBudgetUsd),
    timeoutMs: input.timeoutMs,
  };
}

// slug 是工作区目录名，改了旧目录会变孤儿，只能显式拒绝。
function assertSlugUnchanged(current: string, next: string | undefined): string | undefined {
  return next !== undefined && next !== current ? 'slug cannot change' : undefined;
}

/**
 * 单层委派校验：自己不能当子智能体，候选只能是「没有 parent」的顶层 agent。
 * 返回错误文案；合法时返回 undefined。
 */
async function validateSubAgents(
  app: FastifyInstance,
  selfId: string | null,
  subAgentIds: string[],
): Promise<string | undefined> {
  if (new Set(subAgentIds).size !== subAgentIds.length) return 'duplicate sub-agent';
  if (selfId !== null && subAgentIds.includes(selfId)) return 'an agent cannot delegate to itself';
  const rows = await repo.getAgentsByIds(app.db, subAgentIds);
  if (rows.length !== subAgentIds.length) return 'referenced sub-agent does not exist';
  for (const row of rows) {
    if (row.parentId !== null && row.parentId !== selfId) {
      return `agent ${row.slug} already has a parent (single-level delegation only)`;
    }
  }
  // 候选自己不能再有子智能体，否则会拼出两层。
  const nested = await repo.listAgentSubAgentIds(
    app.db,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    if ((nested.get(row.id) ?? []).length > 0) {
      return `agent ${row.slug} already has sub-agents (single-level delegation only)`;
    }
  }
  return undefined;
}

/** 快照是共享 Agent（camelCase）；回滚时先转回 DB 写入形状，slug 保持不变。 */
function snapshotToWrite(snapshot: Agent, slug: string): repo.AgentWrite {
  return {
    slug,
    name: snapshot.name,
    description: snapshot.description,
    model: snapshot.model,
    systemPromptMd: snapshot.systemPrompt,
    allowedTools: snapshot.allowedTools,
    disallowedTools: snapshot.disallowedTools,
    permissionMode: snapshot.permissionMode,
    effort: snapshot.effort ?? null,
    maxThinkingTokens: snapshot.maxThinkingTokens ?? null,
    enabled: snapshot.enabled,
    maxTurns: snapshot.maxTurns,
    maxBudgetUsd: String(snapshot.maxBudgetUsd),
    timeoutMs: snapshot.timeoutMs,
  };
}

export function registerAgentRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.requireAuth] };

  app.get('/api/agents', auth, async () => {
    const rows = await repo.listAgents(app.db);
    const ids = rows.map((row) => row.id);
    const [servers, skills, subAgents] = await Promise.all([
      repo.listAgentServerIds(app.db, ids),
      repo.listAgentSkillIds(app.db, ids),
      repo.listAgentSubAgentIds(app.db, ids),
    ]);
    return rows.map((row) =>
      repo.toAgent(
        row,
        servers.get(row.id) ?? [],
        skills.get(row.id) ?? [],
        subAgents.get(row.id) ?? [],
      ),
    );
  });

  app.post('/api/agents', auth, async (request, reply) => {
    const parsed = agentInputSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? 'invalid body');
    const modeError = unsupportedPermissionMode(parsed.data.permissionMode);
    if (modeError) return invalid(reply, modeError);
    const { serverIds, skillIds, subAgentIds, ...rest } = parsed.data;
    const subAgentError = await validateSubAgents(app, null, subAgentIds);
    if (subAgentError) return invalid(reply, subAgentError);
    try {
      const row = await repo.createAgent(app.db, toWrite(rest), serverIds, skillIds, subAgentIds);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.created',
        target: row.id,
        input: parsed.data,
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(201).send(repo.toAgent(row, serverIds, skillIds, subAgentIds));
    } catch (err) {
      rethrowConflict(err);
    }
  });

  app.get('/api/agents/:id', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const row = await repo.getAgent(app.db, params.data.id);
    if (!row) return notFound(reply);
    const [serverIds, skillIds, subAgentIds] = await Promise.all([
      repo.getAgentServerIds(app.db, row.id),
      repo.getAgentSkillIds(app.db, row.id),
      repo.getAgentSubAgentIds(app.db, row.id),
    ]);
    return repo.toAgent(row, serverIds, skillIds, subAgentIds);
  });

  app.patch('/api/agents/:id', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const body = patchSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message ?? 'invalid body');
    const modeError = unsupportedPermissionMode(body.data.permissionMode);
    if (modeError) return invalid(reply, modeError);

    const current = await repo.getAgent(app.db, params.data.id);
    if (!current) return notFound(reply);
    const slugError = assertSlugUnchanged(current.slug, body.data.slug);
    if (slugError) return invalid(reply, slugError);
    if (body.data.subAgentIds !== undefined) {
      // 自己已经是子智能体时不能再有子智能体，否则就是两层。
      if (current.parentId !== null && body.data.subAgentIds.length > 0) {
        return invalid(reply, 'a sub-agent cannot have its own sub-agents');
      }
      const subAgentError = await validateSubAgents(app, current.id, body.data.subAgentIds);
      if (subAgentError) return invalid(reply, subAgentError);
    }

    const input = body.data;
    const patch: Partial<repo.AgentWrite> = {
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      model: input.model ?? current.model,
      systemPromptMd: input.systemPrompt ?? current.systemPromptMd,
      allowedTools: input.allowedTools ?? current.allowedTools,
      disallowedTools: input.disallowedTools ?? current.disallowedTools,
      permissionMode: input.permissionMode ?? current.permissionMode,
      effort: input.effort ?? current.effort,
      maxThinkingTokens: input.maxThinkingTokens ?? current.maxThinkingTokens,
      enabled: input.enabled ?? current.enabled,
      maxTurns: input.maxTurns ?? current.maxTurns,
      maxBudgetUsd:
        input.maxBudgetUsd === undefined ? current.maxBudgetUsd : String(input.maxBudgetUsd),
      timeoutMs: input.timeoutMs ?? current.timeoutMs,
    };

    try {
      const row = await repo.updateAgent(
        app.db,
        current.id,
        patch,
        input.serverIds,
        input.skillIds,
        null,
        input.subAgentIds,
        input.expectedUpdatedAt,
      );
      // 版本不匹配时仓储抛 409，走到这里只剩「行不存在」。
      if (!row) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.updated',
        target: row.id,
        input: body.data,
        status: 'ok',
        requestId: request.id,
      });
      const [serverIds, skillIds, subAgentIds] = await Promise.all([
        input.serverIds ?? repo.getAgentServerIds(app.db, current.id),
        input.skillIds ?? repo.getAgentSkillIds(app.db, current.id),
        input.subAgentIds ?? repo.getAgentSubAgentIds(app.db, current.id),
      ]);
      return repo.toAgent(row, serverIds, skillIds, subAgentIds);
    } catch (err) {
      rethrowConflict(err);
    }
  });

  app.delete('/api/agents/:id', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const ok = await repo.deleteAgent(app.db, params.data.id);
    if (!ok) return notFound(reply);
    await writeAudit(app.db, request.log, {
      actor: 'admin',
      action: 'agent.deleted',
      target: params.data.id,
      status: 'ok',
      requestId: request.id,
    });
    return reply.status(204).send();
  });

  // 检查配置是否可渲染的最直接方式就是真渲染一次；只预览，不落盘。
  // 预览永远只含密钥键名，reveal=1 也不返回明文，仅要求浏览器不缓存。
  app.get<{ Params: { id: string }; Querystring: { reveal?: string } }>(
    '/api/agents/:id/files',
    auth,
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return invalid(reply, 'invalid id');
      const files = await renderAgentWorkspace(app, params.data.id);
      if (!files) return notFound(reply);
      if (request.query.reveal === '1') reply.header('Cache-Control', 'no-store');
      return files;
    },
  );

  app.get('/api/agents/:id/versions', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const current = await repo.getAgent(app.db, params.data.id);
    if (!current) return notFound(reply);
    return allRepo.agentVersions.listAgentVersions(app.db, current.id);
  });

  app.get('/api/agents/:id/versions/:version', auth, async (request, reply) => {
    const params = versionParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid version');
    const current = await repo.getAgent(app.db, params.data.id);
    if (!current) return notFound(reply);
    const row = await allRepo.agentVersions.getAgentVersion(
      app.db,
      current.id,
      params.data.version,
    );
    if (!row) {
      return reply.status(404).send({ code: 'NOT_FOUND', message: 'version not found' });
    }
    return { version: row.version, snapshot: row.snapshot, createdAt: row.createdAt.toISOString() };
  });

  app.post('/api/agents/:id/rollback', auth, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid id');
    const body = rollbackBody.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message ?? 'invalid body');

    const current = await repo.getAgent(app.db, params.data.id);
    if (!current) return notFound(reply);
    const target = await allRepo.agentVersions.getAgentVersion(
      app.db,
      current.id,
      body.data.version,
    );
    if (!target) {
      return reply.status(404).send({ code: 'NOT_FOUND', message: 'version not found' });
    }

    const snapshot = target.snapshot;
    // 旧快照没有 subAgentIds 字段；缺失时保持现有关系不动。
    const snapshotSubAgentIds = snapshot.subAgentIds as string[] | undefined;
    if (snapshotSubAgentIds !== undefined) {
      if (current.parentId !== null && snapshotSubAgentIds.length > 0) {
        return invalid(reply, 'a sub-agent cannot have its own sub-agents');
      }
      const subAgentError = await validateSubAgents(app, current.id, snapshotSubAgentIds);
      if (subAgentError) return invalid(reply, subAgentError);
    }
    try {
      const row = await repo.updateAgent(
        app.db,
        current.id,
        snapshotToWrite(snapshot, current.slug),
        snapshot.serverIds,
        snapshot.skillIds,
        `rollback to v${target.version}`,
        snapshotSubAgentIds,
      );
      if (!row) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.rolled_back',
        target: row.id,
        input: { version: target.version },
        status: 'ok',
        requestId: request.id,
      });
      return repo.toAgent(row, snapshot.serverIds, snapshot.skillIds, snapshotSubAgentIds ?? []);
    } catch (err) {
      rethrowConflict(err);
    }
  });
}
