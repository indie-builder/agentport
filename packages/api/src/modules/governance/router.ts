import { governanceContract } from '@agentport/contract/governance';
import { repo } from '@agentport/db';
import { implement } from '@orpc/server';
import { requireUser } from '../../http/access.js';
import { domainAudit } from '../../http/audit.js';
import type { RequestContext } from '../../http/context.js';
import { cursorOption, requireCursorPage } from '../../http/pagination.js';

const os = implement(governanceContract).$context<RequestContext>();
const governance = repo.governance;

const audit = domainAudit('governance');

export const governanceRouter = os.router({
  departments: {
    list: os.departments.list.handler(async ({ context, input }) =>
      requireCursorPage(await governance.listDepartments(context.db, input.query)),
    ),
    create: os.departments.create.handler(async ({ context, input }) => {
      const result = await governance.createDepartment(context.db, input.body);
      await audit(context, 'department.create', result.id, input.body);
      return result;
    }),
    update: os.departments.update.handler(async ({ context, input }) => {
      const result = await governance.updateDepartment(context.db, input.params.id, input.body);
      await audit(context, 'department.update', input.params.id, input.body);
      return result;
    }),
    remove: os.departments.remove.handler(async ({ context, input }) => {
      await governance.deleteDepartment(context.db, input.params.id);
      await audit(context, 'department.delete', input.params.id);
    }),
    members: os.departments.members.handler(async ({ context, input }) => {
      const result = await governance.setDepartmentMembers(context.db, input.params.id, input.body);
      await audit(context, 'department.members', input.params.id, input.body);
      return result;
    }),
  },
  budgets: {
    list: os.budgets.list.handler(async ({ context, input }) =>
      requireCursorPage(await governance.listBudgetStatuses(context.db, input.query)),
    ),
    upsert: os.budgets.upsert.handler(async ({ context, input }) => {
      const result = await governance.upsertBudget(context.db, input.body);
      await audit(context, 'budget.upsert', result.id, input.body);
      return result;
    }),
    remove: os.budgets.remove.handler(async ({ context, input }) => {
      await governance.deleteBudget(context.db, input.params.id);
      await audit(context, 'budget.delete', input.params.id);
    }),
  },
  resourceGrants: {
    list: os.resourceGrants.list.handler(({ context, input }) =>
      governance.listResourceGrants(context.db, input.query.resourceKind, input.query.resourceId),
    ),
    upsert: os.resourceGrants.upsert.handler(async ({ context, input }) => {
      const result = await governance.upsertResourceGrant(context.db, input.body);
      await audit(
        context,
        'resource_grant.upsert',
        `${input.body.resourceKind}:${input.body.resourceId}:${input.body.businessId}`,
        input.body,
      );
      return result;
    }),
    remove: os.resourceGrants.remove.handler(async ({ context, input }) => {
      const query = input.query;
      await governance.deleteResourceGrant(
        context.db,
        query.resourceKind,
        query.resourceId,
        query.businessId,
      );
      await audit(
        context,
        'resource_grant.delete',
        `${query.resourceKind}:${query.resourceId}:${query.businessId}`,
      );
    }),
  },
  resources: os.resources.handler(async ({ context, input }) =>
    requireCursorPage(
      await governance.listGovernanceResources(context.db, input.query.resourceKind, {
        ...(input.query.q === undefined ? {} : { q: input.query.q }),
        ...cursorOption(input.query.cursor),
        limit: input.query.limit,
      }),
    ),
  ),
  identities: os.identities.handler(async ({ context, input }) =>
    requireCursorPage(
      await repo.accounts.listIdentityPage(context.db, {
        ...(input.query.q === undefined ? {} : { q: input.query.q }),
        ...cursorOption(input.query.cursor),
        limit: input.query.limit,
      }),
    ),
  ),
  handover: {
    checklist: os.handover.checklist.handler(({ context, input }) =>
      governance.handoverChecklist(context.db, input.params.businessId),
    ),
    transfer: os.handover.transfer.handler(async ({ context, input }) => {
      const result = await governance.transferAll(
        context.db,
        input.params.businessId,
        input.body.toBusinessId,
      );
      await audit(
        context,
        'handover.transfer',
        `${input.params.businessId}->${input.body.toBusinessId}`,
        result.transferred,
      );
      return result;
    }),
  },
  costSummary: os.costSummary.handler(({ context, input }) =>
    governance.costSummary(context.db, input.query),
  ),
  alerts: {
    get: os.alerts.get.handler(({ context }) => governance.getAlertSettings(context.db)),
    update: os.alerts.update.handler(async ({ context, input }) => {
      const result = await governance.updateAlertSettings(
        context.db,
        input.body,
        requireUser(context).businessId,
      );
      await audit(context, 'alerts.update', 'platform', input.body);
      return result;
    }),
  },
});
