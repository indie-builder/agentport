import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, isAppError, parseAgentMd } from '@agentport/core';
import { repo as allRepo, schema } from '@agentport/db';
import * as repo from '@agentport/db/repo/agents.js';
import type { Agent, AgentInput } from '@agentport/shared';
import {
  AGENT_ROLES,
  agentDuplicateInputSchema,
  agentInputSchema,
  agentRoleSchema,
  agentSchema,
  idParams,
  outputStyleInputSchema,
  permissionModeSchema,
  slugSchema,
  uiFormatSchema,
} from '@agentport/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isPgCode, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import {
  deleteMemoryFile,
  listMemoryFiles,
  memoryFileNamePattern,
  readMemoryFile,
  writeMemoryFile,
} from './memory-files.js';
import { allowedToolsSchema, unsupportedAllowedTool } from './validation.js';
import { renderAgentWorkspace } from './workspace.js';

const versionParams = z.object({
  id: z.string().min(1),
  version: z.coerce.number().int().positive(),
});
const rollbackBody = z.object({ version: z.number().int().positive() });
const subAgentFileParams = z.object({
  id: z.string().min(1),
  childId: z.string().min(1),
});
const memoryParams = z.object({ id: z.string().min(1) });
const memoryFileParams = z.object({
  id: z.string().min(1),
  name: z.string().regex(memoryFileNamePattern, '记忆文件名非法：只允许 <name>.md'),
});
const memoryWriteBody = z.object({ content: z.string() });
const ruleParams = z.object({ id: z.string().min(1), slug: slugSchema });
const outputStyleParams = z.object({ id: z.string().min(1), slug: slugSchema });
const ruleBody = z.object({
  content: z.string().max(100_000),
  globs: z.string().max(1000).default(''),
});
const outputStyleWriteBody = outputStyleInputSchema.pick({
  description: true,
  keepCodingInstructions: true,
  body: true,
});

type OutputStyleRow = Awaited<ReturnType<typeof allRepo.outputStyles.listOutputStyles>>[number];

function toOutputStyle(row: OutputStyleRow) {
  return {
    id: row.id,
    agentId: row.agentId,
    slug: row.slug,
    description: row.description,
    keepCodingInstructions: row.keepCodingInstructions,
    body: row.body,
    isSelected: row.isSelected,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** default/acceptEdits 直接透传 SDK；auto 依赖无法审计的模型分类器，暂不开放。 */
const unsupportedPermissionModes = new Set(['auto']);

function unsupportedPermissionMode(mode: string | undefined): string | undefined {
  return mode !== undefined && unsupportedPermissionModes.has(mode)
    ? `permissionMode "${mode}" 依赖模型分类器，平台暂不开放；可用 dontAsk、plan、default、acceptEdits`
    : undefined;
}

const createSchema = agentInputSchema.extend({ allowedTools: allowedToolsSchema.default([]) });

// 解析（含 frontmatter / 字段校验）放在 schema 里：handler 只拿解析结果，不再 safeParse。
const importFileSchema = z
  .object({ agentMd: z.string().max(131072) })
  .transform(({ agentMd }, ctx) => {
    try {
      return parseAgentMd(agentMd);
    } catch (err) {
      if (!isAppError(err)) throw err;
      ctx.addIssue({ code: 'custom', path: ['agentMd'], message: err.message });
      return z.NEVER;
    }
  });

// 字段与 agentInputSchema 保持一致；PATCH 用显式可选字段，才能区分「没传」与「传了默认值」。
const patchSchema = z.object({
  slug: slugSchema.optional(),
  name: z.string().min(1).max(128).optional(),
  role: agentRoleSchema.removeDefault().optional(),
  description: z.string().max(300).optional(),
  model: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  serverIds: z.array(z.string()).optional(),
  skillIds: z.array(z.string()).optional(),
  pluginBindings: z
    .array(
      z.object({
        pluginId: z.string(),
        allowHooks: z.boolean().default(false),
        allowMcp: z.boolean().default(false),
      }),
    )
    .optional(),
  subAgentIds: z.array(z.string()).optional(),
  allowedTools: allowedToolsSchema.optional(),
  disallowedTools: z.array(z.string()).optional(),
  permissionMode: permissionModeSchema.optional(),
  uiFormat: uiFormatSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  // null 表示清除回「未配置」；undefined 保持不动，两者语义不同。
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
  maxThinkingTokens: z.number().int().positive().nullable().optional(),
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
    fail('INVALID_REFERENCE', '引用的 MCP Server、技能或插件不存在，请刷新后重新选择');
  throw err;
}

function toWrite(
  input: Omit<AgentInput, 'serverIds' | 'skillIds' | 'subAgentIds' | 'pluginBindings'>,
): repo.AgentWrite {
  return {
    slug: input.slug,
    name: input.name,
    role: input.role,
    description: input.description,
    model: input.model,
    systemPromptMd: input.systemPrompt,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    permissionMode: input.permissionMode,
    uiFormat: input.uiFormat,
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
  // 子智能体不绑插件：带插件绑定的候选必须先解绑，否则运行时会静默忽略而预览仍显示。
  const bindings = await repo.listAgentPluginBindings(
    app.db,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    if ((bindings.get(row.id) ?? []).length > 0) {
      return `「${row.name}」绑定了插件；插件只在会话级加载，请先解除它的插件绑定`;
    }
  }
  return undefined;
}

/** 快照是共享 Agent（camelCase）；回滚时先转回 DB 写入形状，slug 保持不变。 */
function snapshotToWrite(snapshot: Agent, slug: string, currentRole: string): repo.AgentWrite {
  return {
    slug,
    name: snapshot.name,
    // 旧快照缺失或未使用标准角色时保留当前值，避免回滚丢失岗位信息。
    role: AGENT_ROLES.some((role) => role === snapshot.role) ? snapshot.role : currentRole,
    description: snapshot.description,
    model: snapshot.model,
    systemPromptMd: snapshot.systemPrompt,
    allowedTools: snapshot.allowedTools,
    disallowedTools: snapshot.disallowedTools,
    permissionMode: snapshot.permissionMode,
    // 旧快照没有 uiFormat，回滚按默认 markdown。
    uiFormat: snapshot.uiFormat ?? 'markdown',
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
      const [servers, skills, subAgents, plugins] = await Promise.all([
        repo.listAgentServerIds(app.db, ids),
        repo.listAgentSkillIds(app.db, ids),
        repo.listAgentSubAgentIds(app.db, ids),
        repo.listAgentPluginBindings(app.db, ids),
      ]);
      return rows.map((row) =>
        repo.toAgent(
          row,
          servers.get(row.id) ?? [],
          skills.get(row.id) ?? [],
          subAgents.get(row.id) ?? [],
          plugins.get(row.id) ?? [],
        ),
      );
    },
  );

  app.post('/api/agents', { ...auth, schema: { body: createSchema } }, async (request, reply) => {
    const input = request.body;
    const modeError = unsupportedPermissionMode(input.permissionMode);
    if (modeError) return invalid(reply, modeError);
    const { serverIds, skillIds, subAgentIds, pluginBindings, ...rest } = input;
    const subAgentError = await validateSubAgents(app, null, subAgentIds);
    if (subAgentError) return invalid(reply, subAgentError);
    try {
      const row = await repo.createAgent(
        app.db,
        toWrite(rest),
        serverIds,
        skillIds,
        subAgentIds,
        pluginBindings,
      );
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.created',
        target: row.id,
        input,
        status: 'ok',
        requestId: request.id,
      });
      return reply
        .status(201)
        .send(repo.toAgent(row, serverIds, skillIds, subAgentIds, pluginBindings));
    } catch (err) {
      rethrowConflict(err);
    }
  });

  // 克隆：配置、绑定、规则、输出风格一起复制；子智能体不复制，从 v1 重新计版本。
  app.post(
    '/api/agents/:id/duplicate',
    {
      ...auth,
      schema: {
        params: idParams,
        body: agentDuplicateInputSchema,
        response: { 201: agentSchema },
      },
    },
    async (request, reply) => {
      try {
        const row = await repo.duplicateAgent(app.db, request.params.id, request.body);
        if (!row) return notFound(reply);
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'agent.duplicated',
          target: row.id,
          input: { sourceId: request.params.id },
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(201).send(row);
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  // 导入只接受官方 .claude/agents/*.md；slug 即 frontmatter 的 name，冲突与手动创建一样返回 409。
  app.post(
    '/api/agents/import-file',
    { ...auth, schema: { body: importFileSchema } },
    async (request, reply) => {
      const { agent: input, warnings } = request.body;
      const { serverIds, skillIds, subAgentIds, pluginBindings, ...rest } = input;
      try {
        const row = await repo.createAgent(
          app.db,
          toWrite(rest),
          serverIds,
          skillIds,
          subAgentIds,
          pluginBindings,
        );
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'agent.imported',
          target: row.id,
          input: { slug: row.slug },
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(201).send({
          agent: repo.toAgent(row, serverIds, skillIds, subAgentIds, pluginBindings),
          warnings,
        });
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  app.get('/api/agents/:id', { ...auth, schema: { params: idParams } }, async (request, reply) => {
    const row = await repo.getAgent(app.db, request.params.id);
    if (!row) return notFound(reply);
    const [serverIds, skillIds, subAgentIds, pluginBindings] = await Promise.all([
      repo.getAgentServerIds(app.db, row.id),
      repo.getAgentSkillIds(app.db, row.id),
      repo.getAgentSubAgentIds(app.db, row.id),
      repo.listAgentPluginBindings(app.db, [row.id]),
    ]);
    return repo.toAgent(row, serverIds, skillIds, subAgentIds, pluginBindings.get(row.id) ?? []);
  });

  app.patch(
    '/api/agents/:id',
    { ...auth, schema: { params: idParams, body: patchSchema } },
    async (request, reply) => {
      const input = request.body;
      const modeError = unsupportedPermissionMode(input.permissionMode);
      if (modeError) return invalid(reply, modeError);

      // 只有需要旧行做校验的字段才查一次；普通字段更新直接 UPDATE。
      if (
        input.slug !== undefined ||
        input.subAgentIds !== undefined ||
        input.pluginBindings !== undefined
      ) {
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
        // 插件是会话级能力：子智能体不能绑定，避免出现「配了但实际不隔离」的假能力。
        if (current.parentId !== null && (input.pluginBindings?.length ?? 0) > 0) {
          return invalid(reply, '子智能体不能绑定插件；插件在会话级加载');
        }
      }

      // 请求未提交的列必须留给数据库保留，避免并发的不同字段更新互相覆盖。
      const patch: Partial<repo.AgentWrite> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.role !== undefined) patch.role = input.role;
      if (input.description !== undefined) patch.description = input.description;
      if (input.model !== undefined) patch.model = input.model;
      if (input.systemPrompt !== undefined) patch.systemPromptMd = input.systemPrompt;
      if (input.allowedTools !== undefined) patch.allowedTools = input.allowedTools;
      if (input.disallowedTools !== undefined) patch.disallowedTools = input.disallowedTools;
      if (input.permissionMode !== undefined) patch.permissionMode = input.permissionMode;
      if (input.uiFormat !== undefined) patch.uiFormat = input.uiFormat;
      if (input.effort !== undefined) patch.effort = input.effort;
      if (input.maxThinkingTokens !== undefined) {
        patch.maxThinkingTokens = input.maxThinkingTokens;
      }
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.maxTurns !== undefined) patch.maxTurns = input.maxTurns;
      if (input.maxBudgetUsd !== undefined) patch.maxBudgetUsd = String(input.maxBudgetUsd);
      if (input.timeoutMs !== undefined) patch.timeoutMs = input.timeoutMs;

      try {
        const row = await repo.updateAgent(
          app.db,
          request.params.id,
          patch,
          input.serverIds,
          input.skillIds,
          null,
          input.subAgentIds,
          input.expectedUpdatedAt,
          input.pluginBindings,
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
        const [serverIds, skillIds, subAgentIds, pluginBindings] = await Promise.all([
          input.serverIds ?? repo.getAgentServerIds(app.db, row.id),
          input.skillIds ?? repo.getAgentSkillIds(app.db, row.id),
          input.subAgentIds ?? repo.getAgentSubAgentIds(app.db, row.id),
          repo.listAgentPluginBindings(app.db, [row.id]),
        ]);
        return repo.toAgent(
          row,
          serverIds,
          skillIds,
          subAgentIds,
          pluginBindings.get(row.id) ?? [],
        );
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  app.delete(
    '/api/agents/:id',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      // 目录名依赖 slug，删除后无法再定位；先取出 slug 再删行。
      const [row] = await app.db
        .select({ slug: schema.agents.slug })
        .from(schema.agents)
        .where(eq(schema.agents.id, request.params.id))
        .limit(1);
      const ok = await repo.deleteAgent(app.db, request.params.id);
      if (!ok) return notFound(reply);
      if (row) {
        // 会话 transcript 是每次分支/续聊的运行时数据，删专家后不再需要；记忆按约定保留为持久资产。
        await rm(join(app.config.WORKSPACES_DIR, row.slug, 'sdk-sessions'), {
          recursive: true,
          force: true,
        }).catch((err: unknown) => {
          request.log.warn({ err, agentId: request.params.id }, 'sdk session cleanup failed');
        });
        // 会话行已级联删除，成果目录失去所有索引；整个专家目录一起回收。
        await rm(join(app.config.WORKSPACES_DIR, row.slug, 'conversation-outputs'), {
          recursive: true,
          force: true,
        }).catch((err: unknown) => {
          request.log.warn({ err, agentId: request.params.id }, 'output cleanup failed');
        });
        // 附件同样是会话行产生的运行数据：专家删除后没有任何索引可再引用。
        await rm(join(app.config.WORKSPACES_DIR, row.slug, 'conversation-inputs'), {
          recursive: true,
          force: true,
        }).catch((err: unknown) => {
          request.log.warn({ err, agentId: request.params.id }, 'input cleanup failed');
        });
      }
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

  // 下载内容必须与 worker 落盘的 .claude/agents/<slug>.md 一致：先渲染父级工作区再取文件。
  app.get(
    '/api/agents/:id/subagents/:childId/file',
    { ...auth, schema: { params: subAgentFileParams } },
    async (request, reply) => {
      const [parent, child] = await Promise.all([
        repo.getAgent(app.db, request.params.id),
        repo.getAgent(app.db, request.params.childId),
      ]);
      if (!parent || !child || child.parentId !== parent.id || child.id === parent.id) {
        return notFound(reply);
      }
      const files = await renderAgentWorkspace(app, parent.id);
      const rendered = files?.subAgents.find((subAgent) => subAgent.slug === child.slug);
      if (!rendered) return notFound(reply);
      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${child.slug}.md"`)
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(rendered.content);
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
          snapshotToWrite(snapshot, current.slug, current.role),
          snapshot.serverIds,
          snapshot.skillIds,
          `rollback to v${target.version}`,
          snapshotSubAgentIds,
          undefined,
          // 旧快照没有 pluginBindings；缺失时保持现有绑定不动。
          (snapshot as { pluginBindings?: Agent['pluginBindings'] }).pluginBindings,
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
        const restoredPlugins = await repo.listAgentPluginBindings(app.db, [current.id]);
        return repo.toAgent(
          row,
          snapshot.serverIds,
          snapshot.skillIds,
          snapshotSubAgentIds ?? [],
          restoredPlugins.get(current.id) ?? [],
        );
      } catch (err) {
        rethrowConflict(err);
      }
    },
  );

  // 长期记忆：Claude Code 原生 auto-memory（MEMORY.md + 主题文件），平台只浏览/编辑。
  // 目录是 WORKSPACES_DIR/<slug>/agent-memory/，worker 每次运行只读挂载进容器。
  const memorySlug = async (agentId: string): Promise<string | null> => {
    const [row] = await app.db
      .select({ slug: schema.agents.slug })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .limit(1);
    return row?.slug ?? null;
  };

  app.get(
    '/api/agents/:id/memory',
    { ...auth, schema: { params: memoryParams } },
    async (request, reply) => {
      const slug = await memorySlug(request.params.id);
      if (!slug) return notFound(reply);
      return listMemoryFiles(app.config.WORKSPACES_DIR, slug);
    },
  );

  app.get(
    '/api/agents/:id/memory/:name',
    { ...auth, schema: { params: memoryFileParams } },
    async (request, reply) => {
      const slug = await memorySlug(request.params.id);
      if (!slug) return notFound(reply);
      const file = await readMemoryFile(app.config.WORKSPACES_DIR, slug, request.params.name);
      if (!file) return notFound(reply);
      return file;
    },
  );

  app.put(
    '/api/agents/:id/memory/:name',
    { ...auth, schema: { params: memoryFileParams, body: memoryWriteBody } },
    async (request, reply) => {
      const slug = await memorySlug(request.params.id);
      if (!slug) return notFound(reply);
      const file = await writeMemoryFile(
        app.config.WORKSPACES_DIR,
        slug,
        request.params.name,
        request.body.content,
      );
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.memory.write',
        target: request.params.id,
        input: { name: request.params.name },
        status: 'ok',
        requestId: request.id,
      });
      return file;
    },
  );

  app.delete(
    '/api/agents/:id/memory/:name',
    { ...auth, schema: { params: memoryFileParams } },
    async (request, reply) => {
      const slug = await memorySlug(request.params.id);
      if (!slug) return notFound(reply);
      const removed = await deleteMemoryFile(app.config.WORKSPACES_DIR, slug, request.params.name);
      if (!removed) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.memory.delete',
        target: request.params.id,
        input: { name: request.params.name },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  // 项目规则：渲染到 .claude/rules/<slug>.md（官方 project source 加载）。
  app.get(
    '/api/agents/:id/rules',
    { ...auth, schema: { params: memoryParams } },
    async (request, reply) => {
      const exists = await memorySlug(request.params.id);
      if (!exists) return notFound(reply);
      const rows = await allRepo.rules.listRules(app.db, request.params.id);
      return rows.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        slug: r.slug,
        content: r.content,
        globs: r.globs,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));
    },
  );

  app.put(
    '/api/agents/:id/rules/:slug',
    { ...auth, schema: { params: ruleParams, body: ruleBody } },
    async (request, reply) => {
      const exists = await memorySlug(request.params.id);
      if (!exists) return notFound(reply);
      const row = await allRepo.rules.upsertRule(app.db, request.params.id, {
        slug: request.params.slug,
        content: request.body.content,
        globs: request.body.globs,
      });
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.rule.written',
        target: request.params.id,
        input: { slug: row.slug },
        status: 'ok',
        requestId: request.id,
      });
      return {
        id: row.id,
        agentId: row.agentId,
        slug: row.slug,
        content: row.content,
        globs: row.globs,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  );

  app.delete(
    '/api/agents/:id/rules/:slug',
    { ...auth, schema: { params: ruleParams } },
    async (request, reply) => {
      const exists = await memorySlug(request.params.id);
      if (!exists) return notFound(reply);
      const removed = await allRepo.rules.deleteRule(
        app.db,
        request.params.id,
        request.params.slug,
      );
      if (!removed) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.rule.deleted',
        target: request.params.id,
        input: { slug: request.params.slug },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  // 输出风格：渲染到 .claude/output-styles/<slug>.md，选中者经 settings.outputStyle 激活。
  app.get(
    '/api/agents/:id/output-styles',
    { ...auth, schema: { params: memoryParams } },
    async (request, reply) => {
      const exists = await memorySlug(request.params.id);
      if (!exists) return notFound(reply);
      const rows = await allRepo.outputStyles.listOutputStyles(app.db, request.params.id);
      return rows.map(toOutputStyle);
    },
  );

  app.put(
    '/api/agents/:id/output-styles/:slug',
    { ...auth, schema: { params: outputStyleParams, body: outputStyleWriteBody } },
    async (request, reply) => {
      const exists = await memorySlug(request.params.id);
      if (!exists) return notFound(reply);
      const row = await allRepo.outputStyles.upsertOutputStyle(app.db, request.params.id, {
        slug: request.params.slug,
        ...request.body,
      });
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.output_style.written',
        target: request.params.id,
        input: { slug: row.slug },
        status: 'ok',
        requestId: request.id,
      });
      return toOutputStyle(row);
    },
  );

  app.post(
    '/api/agents/:id/output-styles/:slug/unselect',
    { ...auth, schema: { params: outputStyleParams } },
    async (request, reply) => {
      const exists = await memorySlug(request.params.id);
      if (!exists) return notFound(reply);
      const ok = await allRepo.outputStyles.unselectOutputStyle(
        app.db,
        request.params.id,
        request.params.slug,
      );
      if (!ok) return reject(reply, 'NOT_FOUND', '该输出风格不存在，可能已被删除');
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.output_style.unselected',
        target: request.params.id,
        input: { slug: request.params.slug },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  app.delete(
    '/api/agents/:id/output-styles/:slug',
    { ...auth, schema: { params: outputStyleParams } },
    async (request, reply) => {
      const exists = await memorySlug(request.params.id);
      if (!exists) return notFound(reply);
      const removed = await allRepo.outputStyles.deleteOutputStyle(
        app.db,
        request.params.id,
        request.params.slug,
      );
      if (!removed) return reject(reply, 'NOT_FOUND', '该输出风格不存在，可能已被删除');
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.output_style.deleted',
        target: request.params.id,
        input: { slug: request.params.slug },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );
}
