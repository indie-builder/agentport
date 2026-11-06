import { memoryContract } from '@agentport/contract/memory';
import { fail } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import { memoryReviewTargetSchema } from '@agentport/shared';
import { implement } from '@orpc/server';
import { and, eq } from 'drizzle-orm';
import { authorizeObject, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { agentSlug, writeMemoryTarget } from './changes.js';
import { listPersonalMemoryVersions, readPersonalMemory, writePersonalMemory } from './personal.js';

const os = implement(memoryContract).$context<RequestContext>();

const INDEX_FILE = 'MEMORY.md';

function listVersions(
  context: RequestContext,
  options: Omit<repo.memoryChanges.ListMemoryChangesOptions, 'before'> & { before?: string },
) {
  const { before, ...rest } = options;
  return repo.memoryChanges.listFiltered(context.db, {
    ...rest,
    ...(before === undefined ? {} : { before: new Date(before) }),
  });
}

export const memoryRouter = os.router({
  readPersonal: os.readPersonal.handler(async ({ context }) => {
    return readPersonalMemory(context.db, requireUser(context).businessId);
  }),
  writePersonal: os.writePersonal.handler(async ({ input, context }) => {
    const saved = await writePersonalMemory({
      db: context.db,
      client: context.client,
      workspacesDir: context.config.WORKSPACES_DIR,
      businessId: requireUser(context).businessId,
      content: input.body.content,
      expectedRevision: input.body.expectedRevision,
      logger: context.log,
    });
    if (saved === null) fail('CONFLICT', '个人记忆已被其他编辑更新，请刷新后重试');
    return saved;
  }),
  personalVersions: os.personalVersions.handler(async ({ input, context }) => {
    const items = await listPersonalMemoryVersions(context.db, requireUser(context).businessId, {
      ...(input.query.before === undefined ? {} : { before: input.query.before }),
      limit: input.query.limit,
    });
    return { items };
  }),
  agentFileVersions: os.agentFileVersions.handler(async ({ input, context }) => {
    await authorizeObject(
      context,
      'agents.memory.read',
      { agentId: input.params.id },
      '智能体不存在，可能已被删除；请刷新后重新选择',
    );
    await agentSlug(context.db, input.params.id);
    const rows = await listVersions(context, {
      agentId: input.params.id,
      kind: 'agent_memory',
      name: input.params.name,
      includeIndexChanges: input.params.name === INDEX_FILE,
      limit: input.query.limit,
      ...(input.query.before === undefined ? {} : { before: input.query.before }),
    });
    return { items: rows.map((row) => repo.memoryChanges.toMemoryChange(row)) };
  }),
  agentRuleVersions: os.agentRuleVersions.handler(async ({ input, context }) => {
    await authorizeObject(
      context,
      'agents.rules.read',
      { agentId: input.params.id },
      '智能体不存在，可能已被删除；请刷新后重新选择',
    );
    await agentSlug(context.db, input.params.id);
    const rows = await listVersions(context, {
      agentId: input.params.id,
      kind: 'agent_rule',
      slug: input.params.slug,
      limit: input.query.limit,
      ...(input.query.before === undefined ? {} : { before: input.query.before }),
    });
    return { items: rows.map((row) => repo.memoryChanges.toMemoryChange(row)) };
  }),
  rollback: os.rollback.handler(async ({ input, context }) => {
    const businessId = requireUser(context).businessId;
    const [change] = await context.db
      .select()
      .from(schema.memoryChanges)
      .where(
        and(
          eq(schema.memoryChanges.id, input.params.id),
          eq(schema.memoryChanges.businessId, businessId),
        ),
      )
      .limit(1);
    if (!change) fail('NOT_FOUND', '记忆版本不存在，可能已被清理');
    const target = memoryReviewTargetSchema.safeParse(change.target);
    if (!target.success) fail('INVALID_INPUT', '记忆版本的目标非法，无法回滚');
    if (target.data.kind === 'personal') {
      await authorizeObject(
        context,
        'personal_memory.write',
        {
          objectId: change.id,
          createdBy: change.businessId,
          privateContent: true,
        },
        '记忆版本不存在，可能已被清理',
      );
    } else if (target.data.kind === 'agent_memory') {
      await authorizeObject(
        context,
        'agents.memory.write',
        { agentId: target.data.agentId },
        '智能体不存在，可能已被删除；请刷新后重新选择',
      );
    } else {
      await authorizeObject(
        context,
        'agents.rules.write',
        { agentId: target.data.agentId },
        '智能体不存在，可能已被删除；请刷新后重新选择',
      );
    }
    const reverse = await writeMemoryTarget(context.db, {
      client: context.client,
      workspacesDir: context.config.WORKSPACES_DIR,
      businessId: change.businessId,
      target: target.data,
      before: change.after,
      after: change.before,
      reversesChangeId: change.id,
    });
    if (!reverse) fail('CONFLICT', '目标内容已变化，无法回滚');
    return repo.memoryChanges.toMemoryChange(reverse);
  }),
});
