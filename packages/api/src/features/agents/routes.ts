import { DEFAULT_DISALLOWED_TOOLS, fail } from '@agentport/core';
import { repo as allRepo } from '@agentport/db';
import * as repo from '@agentport/db/repo/agents.js';
import type { Agent, AgentInput } from '@agentport/shared';
import {
  agentInputSchema,
  agentSchema,
  idParams,
  permissionModeSchema,
  slugSchema,
} from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isPgCode, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { renderAgentWorkspace } from './workspace.js';

const versionParams = z.object({
  id: z.string().min(1),
  version: z.coerce.number().int().positive(),
});
const rollbackBody = z.object({ version: z.number().int().positive() });

/** default/acceptEdits 直接透传 SDK；auto 依赖无法审计的模型分类器，暂不开放。 */
const unsupportedPermissionModes = new Set(['auto']);

function unsupportedPermissionMode(mode: string | undefined): string | undefined {
  return mode !== undefined && unsupportedPermissionModes.has(mode)
    ? `permissionMode "${mode}" 依赖模型分类器，平台暂不开放；可用 dontAsk、plan、default、acceptEdits`
    : undefined;
}

const blockedAllowedTools = new Set(
  DEFAULT_DISALLOWED_TOOLS.filter(
    (tool) => !['Agent', 'TaskStop', 'ListAgents', 'SendMessage'].includes(tool),
  ),
);

function unsupportedAllowedTool(tools: string[]): string | undefined {
  const tool = tools.find((rule) => blockedAllowedTools.has(rule.split('(')[0]?.trim() ?? rule));
  return tool === undefined
    ? undefined
    : `allowedTools 中的「${tool}」被运行时固定禁用，无法放行；请移除该项`;
}

const allowedToolsSchema = z.array(z.string()).superRefine((tools, ctx) => {
  const message = unsupportedAllowedTool(tools);
  if (message) ctx.addIssue({ code: 'custom', message });
});
const createSchema = agentInputSchema.extend({ allowedTools: allowedToolsSchema.default([]) });

// 字段与 agentInputSchema 保持一致；PATCH 用显式可选字段，才能区分「没传」与「传了默认值」。
const patchSchema = z.object({
  slug: slugSchema.optional(),
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(300).optional(),
  model: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  serverIds: z.array(z.string()).optional(),
  skillIds: z.array(z.string()).optional(),
  subAgentIds: z.array(z.string()).optional(),
  allowedTools: allowedToolsSchema.optional(),
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
  return reject(reply, 'INVALID_INPUT', message);
}

function notFound(reply: FastifyReply) {
  return reject(reply, 'AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请返回列表刷新后重试');
}

/** slug 有唯一索引（23505）→ 409；外键失败（23503）→ 引用了不存在的 server/skill。 */
function rethrowConflict(err: unknown): never {
  if (isPgCode(err, '23505')) fail('CONFLICT', '该 slug 已被其他智能体占用，请换一个');
  if (isPgCode(err, '23503'))
    fail('INVALID_REFERENCE', '引用的 MCP Server 或技能不存在，请刷新后重新选择');
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
  return next !== undefined && next !== current
    ? 'slug 是工作区目录名，创建后不能修改；需要新名称请另建智能体'
    : undefined;
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
  if (new Set(subAgentIds).size !== subAgentIds.length) {
    return '同一个智能体被重复选为子智能体，请去掉重复项';
  }
  if (selfId !== null && subAgentIds.includes(selfId)) return '智能体不能把自己设为子智能体';
  const rows = await repo.getAgentsByIds(app.db, subAgentIds);
  if (rows.length !== subAgentIds.length) return '选中的子智能体已被删除，请刷新后重新选择';
  for (const row of rows) {
    if (row.parentId !== null && row.parentId !== selfId) {
      return `「${row.name}」已经是其他智能体的子智能体；只支持一层委派`;
    }
  }
  // 候选自己不能再有子智能体，否则会拼出两层。
  const nested = await repo.listAgentSubAgentIds(
    app.db,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    if ((nested.get(row.id) ?? []).length > 0) {
      return `「${row.name}」自己还有子智能体；只支持一层委派，请先解除它的子智能体`;
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

export function registerAgentRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.get(
    '/api/agents',
    { ...auth, schema: { response: { 200: z.array(agentSchema) } } },
    async () => {
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
    },
  );

  app.post('/api/agents', { ...auth, schema: { body: createSchema } }, async (request, reply) => {
    const input = request.body;
    const modeError = unsupportedPermissionMode(input.permissionMode);
    if (modeError) return invalid(reply, modeError);
    const { serverIds, skillIds, subAgentIds, ...rest } = input;
    const subAgentError = await validateSubAgents(app, null, subAgentIds);
    if (subAgentError) return invalid(reply, subAgentError);
    try {
      const row = await repo.createAgent(app.db, toWrite(rest), serverIds, skillIds, subAgentIds);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.created',
        target: row.id,
        input,
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(201).send(repo.toAgent(row, serverIds, skillIds, subAgentIds));
    } catch (err) {
      rethrowConflict(err);
    }
  });

  app.get('/api/agents/:id', { ...auth, schema: { params: idParams } }, async (request, reply) => {
    const row = await repo.getAgent(app.db, request.params.id);
    if (!row) return notFound(reply);
    const [serverIds, skillIds, subAgentIds] = await Promise.all([
      repo.getAgentServerIds(app.db, row.id),
      repo.getAgentSkillIds(app.db, row.id),
      repo.getAgentSubAgentIds(app.db, row.id),
    ]);
    return repo.toAgent(row, serverIds, skillIds, subAgentIds);
  });

  app.patch(
    '/api/agents/:id',
    { ...auth, schema: { params: idParams, body: patchSchema } },
    async (request, reply) => {
      const input = request.body;
      const modeError = unsupportedPermissionMode(input.permissionMode);
      if (modeError) return invalid(reply, modeError);

      const current = await repo.getAgent(app.db, request.params.id);
      if (!current) return notFound(reply);
      const slugError = assertSlugUnchanged(current.slug, input.slug);
      if (slugError) return invalid(reply, slugError);
      if (input.subAgentIds !== undefined) {
        // 自己已经是子智能体时不能再有子智能体，否则就是两层。
        if (current.parentId !== null && input.subAgentIds.length > 0) {
          return invalid(reply, 'a sub-agent cannot have its own sub-agents');
        }
        const subAgentError = await validateSubAgents(app, current.id, input.subAgentIds);
        if (subAgentError) return invalid(reply, subAgentError);
      }

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
          input,
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
    },
  );

  app.delete(
    '/api/agents/:id',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const ok = await repo.deleteAgent(app.db, request.params.id);
      if (!ok) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.deleted',
        target: request.params.id,
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  // 检查配置是否可渲染的最直接方式就是真渲染一次；只预览，不落盘。
  // 预览永远只含密钥键名，reveal=1 也不返回明文，仅要求浏览器不缓存。
  app.get(
    '/api/agents/:id/files',
    {
      ...auth,
      schema: {
        params: idParams,
        querystring: z.object({ reveal: z.enum(['0', '1']).optional() }),
      },
    },
    async (request, reply) => {
      const files = await renderAgentWorkspace(app, request.params.id);
      if (!files) return notFound(reply);
      if (request.query.reveal === '1') reply.header('Cache-Control', 'no-store');
      return files;
    },
  );

  app.get(
    '/api/agents/:id/versions',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const current = await repo.getAgent(app.db, request.params.id);
      if (!current) return notFound(reply);
      return allRepo.agentVersions.listAgentVersions(app.db, current.id);
    },
  );

  app.get(
    '/api/agents/:id/versions/:version',
    { ...auth, schema: { params: versionParams } },
    async (request, reply) => {
      const current = await repo.getAgent(app.db, request.params.id);
      if (!current) return notFound(reply);
      const row = await allRepo.agentVersions.getAgentVersion(
        app.db,
        current.id,
        request.params.version,
      );
      if (!row) {
        return reject(reply, 'NOT_FOUND', '该版本不存在，可能已被清理；请刷新版本列表');
      }
      return {
        version: row.version,
        snapshot: row.snapshot,
        createdAt: row.createdAt.toISOString(),
      };
    },
  );

  app.post(
    '/api/agents/:id/rollback',
    { ...auth, schema: { params: idParams, body: rollbackBody } },
    async (request, reply) => {
      const current = await repo.getAgent(app.db, request.params.id);
      if (!current) return notFound(reply);
      const target = await allRepo.agentVersions.getAgentVersion(
        app.db,
        current.id,
        request.body.version,
      );
      if (!target) {
        return reject(reply, 'NOT_FOUND', '该版本不存在，可能已被清理；请刷新版本列表');
      }

      const snapshot = target.snapshot;
      const toolError = unsupportedAllowedTool(snapshot.allowedTools);
      if (toolError) return invalid(reply, toolError);
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
    },
  );
}
