import { memoryContract } from '@agentport/contract/memory';
import { fail } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import { INDEX_FILE_NAME, memoryReviewTargetSchema } from '@agentport/shared';
import { implement } from '@orpc/server';
import { and, eq } from 'drizzle-orm';
import { authorizeObject, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { cursorOption, requireCursorPage } from '../../http/pagination.js';
import { requireAgentSlug } from '../../lib/outputs.js';
import { writeMemoryTarget } from './changes.js';
import { buildMemoryAssembly, buildMemoryOverview, countMemoryTopics } from './overview.js';
import { listPersonalMemoryVersions, readPersonalMemory, writePersonalMemory } from './personal.js';

const os = implement(memoryContract).$context<RequestContext>();

const MISSING_AGENT = '智能体不存在，可能已被删除；请刷新后重新选择';

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
    const { limit, cursor } = input.query;
    return listPersonalMemoryVersions(context.db, requireUser(context).businessId, {
      limit,
      ...cursorOption(cursor),
    });
  }),
  agentFileVersions: os.agentFileVersions.handler(async ({ input, context }) => {
    await authorizeObject(
      context,
      'agents.memory.read',
      { agentId: input.params.id },
      '智能体不存在，可能已被删除；请刷新后重新选择',
    );
    await requireAgentSlug(context.db, input.params.id);
    const limit = input.query.limit;
    const page = requireCursorPage(
      await repo.memoryChanges.listFilteredPage(context.db, {
        agentId: input.params.id,
        kind: 'agent_memory',
        name: input.params.name,
        includeIndexChanges: input.params.name === INDEX_FILE_NAME,
        limit,
        ...cursorOption(input.query.cursor),
      }),
    );
    return {
      items: page.items.map(repo.memoryChanges.toMemoryChange),
      nextCursor: page.nextCursor,
    };
  }),
  agentRuleVersions: os.agentRuleVersions.handler(async ({ input, context }) => {
    await authorizeObject(
      context,
      'agents.rules.read',
      { agentId: input.params.id },
      '智能体不存在，可能已被删除；请刷新后重新选择',
    );
    await requireAgentSlug(context.db, input.params.id);
    const limit = input.query.limit;
    const page = requireCursorPage(
      await repo.memoryChanges.listFilteredPage(context.db, {
        agentId: input.params.id,
        kind: 'agent_rule',
        slug: input.params.slug,
        limit,
        ...cursorOption(input.query.cursor),
      }),
    );
    return {
      items: page.items.map(repo.memoryChanges.toMemoryChange),
      nextCursor: page.nextCursor,
    };
  }),
  agentMemoryOverview: os.agentMemoryOverview.handler(async ({ input, context }) => {
    await authorizeObject(
      context,
      'agents.memory.read',
      { agentId: input.params.id },
      MISSING_AGENT,
    );
    return buildMemoryOverview({
      db: context.db,
      workspacesDir: context.config.WORKSPACES_DIR,
      agentId: input.params.id,
      slug: await requireAgentSlug(context.db, input.params.id),
      businessId: requireUser(context).businessId,
    });
  }),
  agentMemoryAssembly: os.agentMemoryAssembly.handler(async ({ input, context }) => {
    await authorizeObject(
      context,
      'agents.memory.read',
      { agentId: input.params.id },
      MISSING_AGENT,
    );
    return buildMemoryAssembly({
      db: context.db,
      workspacesDir: context.config.WORKSPACES_DIR,
      agentId: input.params.id,
      slug: await requireAgentSlug(context.db, input.params.id),
      businessId: requireUser(context).businessId,
    });
  }),
  updateAgentMemoryPolicy: os.updateAgentMemoryPolicy.handler(async ({ input, context }) => {
    await authorizeObject(
      context,
      'agents.memory.write',
      { agentId: input.params.id },
      MISSING_AGENT,
    );
    const current = await repo.agents.getAgentMemoryPolicy(context.db, input.params.id);
    if (current === null) fail('NOT_FOUND', MISSING_AGENT);
    const slug = await requireAgentSlug(context.db, input.params.id);
    const topics = await countMemoryTopics(context.config.WORKSPACES_DIR, slug);
    if (input.body.policy.topicLimit < topics) {
      fail(
        'CONFLICT',
        `现有 ${topics} 个主题超过上限 ${input.body.policy.topicLimit}，请先合并或删除`,
      );
    }
    const updated = await repo.agentVersions.retryOnVersionConflict(() =>
      context.db.transaction(async (tx) => {
        const ok = await repo.agents.updateAgentMemoryPolicy(
          tx,
          input.params.id,
          input.body.policy,
        );
        if (!ok) return false;
        await repo.agentDefinitions.recordDraftVersionTx(tx, input.params.id, null);
        return true;
      }),
    );
    if (!updated) fail('NOT_FOUND', MISSING_AGENT);
    await repo.audit.writeAudit(context.db, context.log, {
      actor: requireUser(context).businessId,
      action: 'agent.memory.policy.updated',
      target: input.params.id,
      input: {
        agentId: input.params.id,
        before: current,
        after: input.body.policy,
      },
      status: 'ok',
      requestId: context.requestId,
    });
    return { policy: input.body.policy };
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
