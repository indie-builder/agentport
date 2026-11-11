import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { agentsContract } from '@agentport/contract/agents';
import { fail, parseAgentMd } from '@agentport/core';
import { repo as allRepo, plugins as pluginsTable, schema } from '@agentport/db';
import { AGENT_HOOK_FILE_LIMIT } from '@agentport/shared';
import { implement } from '@orpc/server';
import { and, eq } from 'drizzle-orm';
import { accessFilter, agentAccess, authorize, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { AppError } from '../../http/errors.js';
import {
  readMemoryTarget,
  withMemoryTargetLock,
  writeMemoryTargetLocked,
} from '../memory/changes.js';
import { deleteAgentWithSandboxes } from '../runtime-deletion.js';
import { authorizeAgent, authorizedAgent } from './access.js';
import { listMemoryFiles, readMemoryFile } from './memory-files.js';
import {
  agentDetail,
  createAgent,
  restoreAgentVersion,
  rethrowConflict,
  toWrite,
  transferAgent,
  validateRuntimeEnvironment,
  validateSubAgents,
} from './use-cases.js';
import { unsupportedAllowedTool } from './validation.js';
import { renderAgentWorkspace } from './workspace.js';
import { toAgentPatch } from './write.js';

type HookFileRow = Awaited<ReturnType<typeof allRepo.hooks.listHookFiles>>[number];
function toHookFile(row: HookFileRow) {
  return {
    id: row.id,
    agentId: row.agentId,
    path: row.path,
    content: row.content,
    executable: row.executable,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
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
async function authorizeSubAgentBindings(
  context: RequestContext,
  subAgentIds: string[],
): Promise<void> {
  for (const id of subAgentIds) {
    const child = await repo.getAgent(context.db, id);
    if (!child) continue;
    await authorizeAgent(context, child, 'agents.bindings.manage');
  }
}

function invalid(message: string) {
  return fail('INVALID_INPUT', message);
}
function notFound() {
  return fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请返回列表刷新后重试');
}
function toSummary(row: allRepo.agents.AgentRow, serverIds?: string[]) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    createdBy: row.createdBy,
    ownerBusinessId: row.ownerBusinessId,
    slug: row.slug,
    role: row.role,
    model: row.model,
    uiFormat: row.uiFormat,
    parentId: row.parentId,
    createdAt: row.createdAt.toISOString(),
    ...(serverIds === undefined ? {} : { serverIds }),
  };
}
function assertSlugUnchanged(current: string, next: string | undefined): string | undefined {
  return next !== undefined && next !== current
    ? 'slug 是工作区目录名，创建后不能修改；需要新名称请另建智能体'
    : undefined;
}
const repo = allRepo.agents;

const os = implement(agentsContract).$context<RequestContext>();
export const agentsRouter = os.router({
  list: os.list.handler(async ({ context }) => {
    const principal = requireUser(context);
    const rows = await repo.listAgents(context.db, accessFilter(context, 'agents.read'), {
      businessId: principal.businessId,
      scopes: principal.grants
        .filter((grant) => grant.permissionId === 'agents.config.read')
        .map((grant) => grant.scope),
    });
    return rows.map((row) => toSummary(row, row.serverIds ?? undefined));
  }),
  create: os.create.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    await authorize(context, 'agents.create');
    const input = routeInput.body;
    const toolError = unsupportedAllowedTool(routeInput.body.allowedTools ?? []);
    if (toolError) return invalid(toolError);
    const { subAgentIds } = input;
    const subAgentError = await validateSubAgents(context.db, null, subAgentIds);
    if (subAgentError) return invalid(subAgentError);
    await authorizeSubAgentBindings(context, subAgentIds);
    const envError = await validateRuntimeEnvironment(context.db, input.runtimeEnvironmentId);
    if (envError) return invalid(envError);
    return createAgent(
      {
        db: context.db,
        log: context.log,
        actor: principal.businessId,
        requestId: context.requestId,
      },
      input,
    );
  }),
  duplicate: os.duplicate.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const source = await repo.getAgent(context.db, routeInput.params.id);
    if (!source) return notFound();
    await authorizeAgent(context, source, 'agents.clone');
    await authorize(context, 'agents.create');
    try {
      const row = await repo.duplicateAgent(
        context.db,
        source.id,
        routeInput.body,
        principal.businessId,
      );
      if (!row) return notFound();
      await allRepo.audit.writeAudit(context.db, context.log, {
        actor: principal.businessId,
        action: 'agent.duplicated',
        target: row.id,
        input: { sourceId: source.id },
        status: 'ok',
        requestId: context.requestId,
      });
      return row;
    } catch (err) {
      rethrowConflict(err);
    }
  }),
  importFile: os.importFile.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    await authorize(context, 'agents.create');
    const { agent: imported, warnings } = parseAgentMd(routeInput.body.agentMd);
    const { serverIds, skillIds, subAgentIds, pluginBindings, ...rest } = imported;
    await authorizeSubAgentBindings(context, subAgentIds);
    try {
      const row = await repo.createAgent(
        context.db,
        toWrite(rest, principal.businessId),
        serverIds,
        skillIds,
        subAgentIds,
        pluginBindings,
      );
      await allRepo.audit.writeAudit(context.db, context.log, {
        actor: principal.businessId,
        action: 'agent.imported',
        target: row.id,
        input: { slug: row.slug },
        status: 'ok',
        requestId: context.requestId,
      });
      return {
        agent: repo.toAgent(row, serverIds, skillIds, subAgentIds, pluginBindings),
        warnings,
      };
    } catch (err) {
      rethrowConflict(err);
    }
  }),
  options: os.options.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    if (!principal.grants.some((grant) => grant.permissionId === 'agents.bindings.manage')) {
      throw new AppError('FORBIDDEN', '没有管理专家资源绑定的权限');
    }
    const [servers, skills, plugins, environments] = await Promise.all([
      context.db
        .select({ id: schema.servers.id, name: schema.servers.name, kind: schema.servers.kind })
        .from(schema.servers)
        .orderBy(schema.servers.name),
      context.db
        .select({
          id: schema.skills.id,
          slug: schema.skills.slug,
          name: schema.skills.name,
          description: schema.skills.description,
        })
        .from(schema.skills)
        .orderBy(schema.skills.name),
      context.db
        .select({
          id: pluginsTable.id,
          slug: pluginsTable.slug,
          name: pluginsTable.name,
        })
        .from(pluginsTable)
        .orderBy(pluginsTable.name),
      context.db
        .select({
          id: schema.runtimeEnvironments.id,
          name: schema.runtimeEnvironments.name,
          onlineVersionId: schema.runtimeEnvironments.onlineVersionId,
        })
        .from(schema.runtimeEnvironments)
        .orderBy(schema.runtimeEnvironments.name),
    ]);
    return {
      servers,
      skills,
      plugins,
      runtimeEnvironments: environments.map((row) => ({
        id: row.id,
        name: row.name,
        hasOnlineVersion: row.onlineVersionId !== null,
      })),
    };
  }),
  get: os.get.handler(async ({ context, input: routeInput }) => {
    const row = await repo.getAgent(context.db, routeInput.params.id);
    if (!row) return notFound();
    await authorizeAgent(context, row, 'agents.config.read');
    return agentDetail(context.db, row);
  }),
  access: os.access.handler(async ({ context, input: routeInput }) => {
    const row = await repo.getAgent(context.db, routeInput.params.id);
    if (!row) return notFound();
    const result = await agentAccess(context, row.id);
    if (!result.permissionIds.includes('agents.read')) return notFound();
    return result;
  }),
  update: os.update.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const input = routeInput.body;
    const toolError = unsupportedAllowedTool(routeInput.body.allowedTools ?? []);
    if (toolError) return invalid(toolError);
    const envError =
      input.runtimeEnvironmentId === undefined
        ? undefined
        : await validateRuntimeEnvironment(context.db, input.runtimeEnvironmentId);
    if (envError) return invalid(envError);
    const current = await repo.getAgent(context.db, routeInput.params.id);
    if (!current) return notFound();
    const access = await agentAccess(context, current.id);
    if (!access.permissionIds.includes('agents.read')) return notFound();
    const canReadConfig = access.permissionIds.includes('agents.config.read');
    const configFields = [
      input.name,
      input.role,
      input.description,
      input.model,
      input.systemPrompt,
      input.allowedTools,
      input.disallowedTools,
      input.permissionMode,
      input.uiFormat,
      input.effort,
      input.maxTurns,
      input.maxBudgetUsd,
      input.timeoutMs,
      input.runtimeEnvironmentId,
    ];
    const bindingFields = [
      input.serverIds,
      input.skillIds,
      input.pluginBindings,
      input.subAgentIds,
    ];
    const updatesConfig = configFields.some((field) => field !== undefined);
    const updatesBindings = bindingFields.some((field) => field !== undefined);
    if (!updatesConfig && !updatesBindings && input.enabled === undefined) {
      return invalid('请至少提供一个可修改字段');
    }
    if (updatesConfig) {
      await authorizeAgent(context, current, 'agents.config.update');
    }
    if (updatesBindings) {
      await authorizeAgent(context, current, 'agents.bindings.manage');
    }
    if (input.enabled !== undefined) {
      await authorizeAgent(context, current, 'agents.enable');
    }
    const slugError = assertSlugUnchanged(current.slug, input.slug);
    if (slugError) return invalid(slugError);
    if (input.subAgentIds !== undefined) {
      if (current.parentId !== null && input.subAgentIds.length > 0) {
        return invalid('a sub-agent cannot have its own sub-agents');
      }
      const subAgentError = await validateSubAgents(context.db, current.id, input.subAgentIds);
      if (subAgentError) return invalid(subAgentError);
      await authorizeSubAgentBindings(context, input.subAgentIds);
    }
    if (current.parentId !== null && (input.pluginBindings?.length ?? 0) > 0) {
      return invalid('子智能体不能绑定插件；插件在会话级加载');
    }
    const patch = toAgentPatch(input);
    try {
      const row = await repo.updateAgent(
        context.db,
        routeInput.params.id,
        patch,
        input.serverIds,
        input.skillIds,
        null,
        input.subAgentIds,
        input.expectedUpdatedAt,
        input.pluginBindings,
      );
      if (!row) return notFound();
      await allRepo.audit.writeAudit(context.db, context.log, {
        actor: principal.businessId,
        action: 'agent.updated',
        target: row.id,
        input,
        status: 'ok',
        requestId: context.requestId,
      });
      return canReadConfig ? agentDetail(context.db, row) : toSummary(row);
    } catch (err) {
      rethrowConflict(err);
    }
  }),
  delete: os.delete.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const current = await repo.getAgent(context.db, routeInput.params.id);
    if (!current) return notFound();
    await authorizeAgent(context, current, 'agents.delete');
    const deleted = await deleteAgentWithSandboxes({
      client: context.client,
      redisUrl: context.config.REDIS_URL,
      deletion: {
        id: current.id,
        access: accessFilter(context, 'agents.delete'),
        readAccess: accessFilter(context, 'agents.read'),
      },
    });
    if (deleted === null) return notFound();
    const slug = deleted.slug;
    await rm(join(context.config.WORKSPACES_DIR, slug, 'sdk-sessions'), {
      recursive: true,
      force: true,
    }).catch((err: unknown) => {
      context.log.warn({ err, agentId: current.id }, 'sdk session cleanup failed');
    });
    await rm(join(context.config.WORKSPACES_DIR, slug, 'session-sandboxes'), {
      recursive: true,
      force: true,
    }).catch((err: unknown) => {
      context.log.warn({ err, agentId: current.id }, 'session sandbox cleanup failed');
    });
    await rm(join(context.config.WORKSPACES_DIR, slug, 'conversation-outputs'), {
      recursive: true,
      force: true,
    }).catch((err: unknown) => {
      context.log.warn({ err, agentId: current.id }, 'output cleanup failed');
    });
    await rm(join(context.config.WORKSPACES_DIR, slug, 'conversation-inputs'), {
      recursive: true,
      force: true,
    }).catch((err: unknown) => {
      context.log.warn({ err, agentId: current.id }, 'input cleanup failed');
    });
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.deleted',
      target: current.id,
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  files: os.files.handler(async ({ context, input: routeInput }) => {
    const current = await repo.getAgent(context.db, routeInput.params.id);
    if (!current) return notFound();
    await authorizeAgent(context, current, 'agents.files.read');
    if (
      current.hooksEnabled ||
      (await allRepo.hooks.listHookFiles(context.db, current.id)).length > 0
    ) {
      await authorizeAgent(context, current, 'agents.hooks.read');
    }
    const files = await renderAgentWorkspace(context, current.id);
    if (!files) return notFound();
    if (routeInput.query.reveal === '1') context.responseHeaders.set('Cache-Control', 'no-store');
    return files;
  }),
  versions: os.versions.handler(async ({ context, input: routeInput }) => {
    const current = await repo.getAgent(context.db, routeInput.params.id);
    if (!current) return notFound();
    await authorizeAgent(context, current, 'agents.versions.read');
    return allRepo.agentVersions.listAgentVersions(context.db, current.id);
  }),
  version: os.version.handler(async ({ context, input: routeInput }) => {
    const current = await repo.getAgent(context.db, routeInput.params.id);
    if (!current) return notFound();
    await authorizeAgent(context, current, 'agents.versions.read');
    const row = await allRepo.agentVersions.getAgentVersion(
      context.db,
      current.id,
      routeInput.params.version,
    );
    if (!row) {
      return fail('NOT_FOUND', '该版本不存在，可能已被清理；请刷新版本列表');
    }
    return {
      version: row.version,
      snapshot: row.snapshot,
      createdAt: row.createdAt.toISOString(),
    };
  }),
  rollback: os.rollback.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const current = await repo.getAgent(context.db, routeInput.params.id);
    if (!current) return notFound();
    await authorizeAgent(context, current, 'agents.versions.restore');
    const target = await allRepo.agentVersions.getAgentVersion(
      context.db,
      current.id,
      routeInput.body.version,
    );
    if (!target) {
      return fail('NOT_FOUND', '该版本不存在，可能已被清理；请刷新版本列表');
    }
    const snapshot = target.snapshot;
    const envError = await validateRuntimeEnvironment(
      context.db,
      snapshot.runtimeEnvironmentId ?? null,
    );
    if (envError) return invalid(envError);
    const toolError = unsupportedAllowedTool(snapshot.allowedTools);
    if (toolError) return invalid(toolError);
    const snapshotSubAgentIds = snapshot.subAgentIds as string[] | undefined;
    if (snapshotSubAgentIds !== undefined) {
      if (current.parentId !== null && snapshotSubAgentIds.length > 0) {
        return invalid('a sub-agent cannot have its own sub-agents');
      }
      const subAgentError = await validateSubAgents(context.db, current.id, snapshotSubAgentIds);
      if (subAgentError) return invalid(subAgentError);
      await authorizeSubAgentBindings(context, snapshotSubAgentIds);
    }
    return restoreAgentVersion(
      {
        db: context.db,
        log: context.log,
        actor: principal.businessId,
        requestId: context.requestId,
      },
      current,
      target,
    );
  }),
  memory: os.memory.handler(async ({ context, input: routeInput }) => {
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.memory.read');
    return listMemoryFiles(context.config.WORKSPACES_DIR, row.slug);
  }),
  memoryFile: os.memoryFile.handler(async ({ context, input: routeInput }) => {
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.memory.read');
    const file = await readMemoryFile(
      context.config.WORKSPACES_DIR,
      row.slug,
      routeInput.params.name,
    );
    if (!file) return notFound();
    return file;
  }),
  writeMemory: os.writeMemory.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.memory.write');
    const slug = row.slug;
    const target = {
      kind: 'agent_memory',
      agentId: row.id,
      name: routeInput.params.name,
    } as const;
    const file = await withMemoryTargetLock(
      context.client,
      target,
      principal.businessId,
      async () => {
        await writeMemoryTargetLocked(context.db, {
          workspacesDir: context.config.WORKSPACES_DIR,
          businessId: principal.businessId,
          target,
          manualContent: routeInput.body.content,
          logger: context.log,
        });
        const written = await readMemoryFile(
          context.config.WORKSPACES_DIR,
          slug,
          routeInput.params.name,
        );
        if (!written) throw new Error('memory file disappeared after write');
        return written;
      },
    );
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.memory.write',
      target: row.id,
      input: { name: routeInput.params.name },
      status: 'ok',
      requestId: context.requestId,
    });
    return file;
  }),
  deleteMemory: os.deleteMemory.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.memory.write');
    const target = {
      kind: 'agent_memory',
      agentId: row.id,
      name: routeInput.params.name,
    } as const;
    const removed = await withMemoryTargetLock(
      context.client,
      target,
      principal.businessId,
      async () => {
        const current = await readMemoryTarget(
          context.db,
          context.config.WORKSPACES_DIR,
          target,
          principal.businessId,
        );
        if (current.content === null) return false;
        await writeMemoryTargetLocked(context.db, {
          workspacesDir: context.config.WORKSPACES_DIR,
          businessId: principal.businessId,
          target,
          manualContent: null,
          logger: context.log,
        });
        return true;
      },
    );
    if (!removed) return notFound();
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.memory.delete',
      target: row.id,
      input: { name: routeInput.params.name },
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  rules: os.rules.handler(async ({ context, input: routeInput }) => {
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.rules.read');
    const rows = await allRepo.rules.listRules(context.db, row.id);
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      slug: r.slug,
      content: r.content,
      globs: r.globs,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }),
  writeRule: os.writeRule.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.rules.write');
    const target = {
      kind: 'agent_rule',
      agentId: agent.id,
      slug: routeInput.params.slug,
    } as const;
    const row = await withMemoryTargetLock(
      context.client,
      target,
      principal.businessId,
      async () => {
        await writeMemoryTargetLocked(context.db, {
          workspacesDir: context.config.WORKSPACES_DIR,
          businessId: principal.businessId,
          target,
          after: { content: routeInput.body.content, globs: routeInput.body.globs, index: null },
          logger: context.log,
        });
        const [rule] = await context.db
          .select()
          .from(schema.agentRules)
          .where(
            and(
              eq(schema.agentRules.agentId, agent.id),
              eq(schema.agentRules.slug, routeInput.params.slug),
            ),
          )
          .limit(1);
        if (!rule) throw new Error('rule disappeared after write');
        return rule;
      },
    );
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.rule.written',
      target: agent.id,
      input: { slug: row.slug },
      status: 'ok',
      requestId: context.requestId,
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
  }),
  deleteRule: os.deleteRule.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.rules.write');
    const target = {
      kind: 'agent_rule',
      agentId: agent.id,
      slug: routeInput.params.slug,
    } as const;
    const removed = await withMemoryTargetLock(
      context.client,
      target,
      principal.businessId,
      async () => {
        const [rule] = await context.db
          .select({ id: schema.agentRules.id })
          .from(schema.agentRules)
          .where(
            and(
              eq(schema.agentRules.agentId, agent.id),
              eq(schema.agentRules.slug, routeInput.params.slug),
            ),
          )
          .limit(1);
        if (!rule) return false;
        await writeMemoryTargetLocked(context.db, {
          workspacesDir: context.config.WORKSPACES_DIR,
          businessId: principal.businessId,
          target,
          after: { content: null, globs: '', index: null },
          logger: context.log,
        });
        return true;
      },
    );
    if (!removed) return notFound();
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.rule.deleted',
      target: agent.id,
      input: { slug: routeInput.params.slug },
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  outputStyles: os.outputStyles.handler(async ({ context, input: routeInput }) => {
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.styles.read');
    const rows = await allRepo.outputStyles.listOutputStyles(context.db, row.id);
    return rows.map(toOutputStyle);
  }),
  writeOutputStyle: os.writeOutputStyle.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.styles.write');
    const row = await allRepo.outputStyles.upsertOutputStyle(context.db, agent.id, {
      slug: routeInput.params.slug,
      ...routeInput.body,
    });
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.output_style.written',
      target: agent.id,
      input: { slug: row.slug },
      status: 'ok',
      requestId: context.requestId,
    });
    return toOutputStyle(row);
  }),
  unselectOutputStyle: os.unselectOutputStyle.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.styles.write');
    const ok = await allRepo.outputStyles.unselectOutputStyle(
      context.db,
      agent.id,
      routeInput.params.slug,
    );
    if (!ok) return fail('NOT_FOUND', '该输出风格不存在，可能已被删除');
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.output_style.unselected',
      target: agent.id,
      input: { slug: routeInput.params.slug },
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  deleteOutputStyle: os.deleteOutputStyle.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.styles.write');
    const removed = await allRepo.outputStyles.deleteOutputStyle(
      context.db,
      agent.id,
      routeInput.params.slug,
    );
    if (!removed) return fail('NOT_FOUND', '该输出风格不存在，可能已被删除');
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.output_style.deleted',
      target: agent.id,
      input: { slug: routeInput.params.slug },
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  hooks: os.hooks.handler(async ({ context, input: routeInput }) => {
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.hooks.read');
    const files = await allRepo.hooks.listHookFiles(context.db, agent.id);
    return {
      enabled: agent.hooksEnabled,
      config: agent.hooksConfig,
      files: files.map(toHookFile),
    };
  }),
  writeHooksSettings: os.writeHooksSettings.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.hooks.write');
    const updated = await allRepo.hooks.updateHooksSettings(context.db, agent.id, {
      enabled: routeInput.body.enabled,
      config: routeInput.body.config,
    });
    if (!updated) return notFound();
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.hooks.settings.updated',
      target: agent.id,
      input: { enabled: routeInput.body.enabled },
      status: 'ok',
      requestId: context.requestId,
    });
    const files = await allRepo.hooks.listHookFiles(context.db, agent.id);
    return {
      enabled: routeInput.body.enabled,
      config: routeInput.body.config,
      files: files.map(toHookFile),
    };
  }),
  writeHookFile: os.writeHookFile.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.hooks.write');
    const existing = await allRepo.hooks.listHookFiles(context.db, agent.id);
    if (
      existing.length >= AGENT_HOOK_FILE_LIMIT &&
      !existing.some((file) => file.path === routeInput.body.path)
    ) {
      fail('INVALID_INPUT', `hook 脚本最多 ${AGENT_HOOK_FILE_LIMIT} 个，请先删除不用的脚本`);
    }
    const row = await allRepo.hooks.upsertHookFile(context.db, agent.id, routeInput.body);
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.hook.file.updated',
      target: agent.id,
      input: { path: row.path },
      status: 'ok',
      requestId: context.requestId,
    });
    return toHookFile(row);
  }),
  deleteHookFile: os.deleteHookFile.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.hooks.write');
    const removed = await allRepo.hooks.deleteHookFile(context.db, agent.id, routeInput.body.path);
    if (!removed) {
      fail('NOT_FOUND', 'hook 脚本不存在，可能已被删除；请刷新后重试');
    }
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.hook.file.deleted',
      target: agent.id,
      input: { path: routeInput.body.path },
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  members: os.members.handler(async ({ context, input: routeInput }) => {
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.members.manage');
    const members = await allRepo.access.listAgentMembers(context.db, row.id);
    return { ownerBusinessId: row.ownerBusinessId, members };
  }),
  setMember: os.setMember.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.members.manage');
    if (!(await allRepo.accounts.hasBusinessHistory(context.db, routeInput.params.businessId))) {
      return invalid('该业务 ID 尚未登记为人员，无法授权；请先在账户中添加该人员');
    }
    const member = await allRepo.access.setAgentMember(context.db, row.id, {
      businessId: routeInput.params.businessId,
      canUse: routeInput.body.canUse,
      canMaintain: routeInput.body.canMaintain,
    });
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.member.updated',
      target: row.id,
      input: routeInput.params.businessId,
      status: 'ok',
      requestId: context.requestId,
    });
    return member;
  }),
  deleteMember: os.deleteMember.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.members.manage');
    if (routeInput.params.businessId === row.ownerBusinessId) {
      return invalid('负责人不是可删除的成员行；需要变更负责人请使用转交');
    }
    const removed = await allRepo.access.deleteAgentMember(
      context.db,
      row.id,
      routeInput.params.businessId,
    );
    if (!removed) return fail('NOT_FOUND', '该成员不存在，可能已被移除');
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'agent.member.deleted',
      target: row.id,
      input: routeInput.params.businessId,
      status: 'ok',
      requestId: context.requestId,
    });
    return { ok: true };
  }),
  transfer: os.transfer.handler(async ({ context, input: routeInput }) => {
    const principal = requireUser(context);
    const row = await authorizedAgent(context, routeInput.params.id, 'agents.transfer');
    return transferAgent(
      {
        db: context.db,
        log: context.log,
        actor: principal.businessId,
        requestId: context.requestId,
      },
      row,
      routeInput.body.ownerBusinessId,
    );
  }),
  identities: os.identities.handler(async ({ context, input: routeInput }) => {
    const row = await repo.getAgent(context.db, routeInput.query.agentId);
    if (!row) return notFound();
    await authorizeAgent(context, row, 'agents.members.manage');
    return allRepo.accounts.listIdentities(context.db, {
      limit: routeInput.query.limit,
      offset: routeInput.query.offset,
      ...(routeInput.query.q === undefined ? {} : { q: routeInput.query.q }),
    });
  }),
});
