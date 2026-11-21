import type {
  AlertSettings,
  BudgetInput,
  BudgetStatus,
  CostGroupBy,
  CostSummary,
  CursorPage,
  Department,
  DepartmentMembersInput,
  GovernanceIdentity,
  GovernanceResource,
  HandoverChecklist,
  HandoverTransferResult,
  ResourceGrant,
  ResourceGrantInput,
  ResourceKind,
} from '@agentport/shared';
import { rpc } from '../orpc.js';
import { clientOptions } from './shared.js';

export default {
  resourceGrants: (query: {
    resourceKind: ResourceKind;
    resourceId: string;
  }): Promise<ResourceGrant[]> => rpc.governance.resourceGrants.list({ query }),
  handoverChecklist: (businessId: string): Promise<HandoverChecklist> =>
    rpc.governance.handover.checklist({ params: { businessId } }),
  costSummary: (days: number, groupBy: CostGroupBy): Promise<CostSummary> =>
    rpc.governance.costSummary({ query: { days, groupBy } }),
  alertSettings: (): Promise<AlertSettings> => rpc.governance.alerts.get(),
  departments: (
    options: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<CursorPage<Department>> =>
    rpc.governance.departments.list({ query: options }, clientOptions(signal)),
  budgets: (
    options: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<CursorPage<BudgetStatus>> =>
    rpc.governance.budgets.list({ query: options }, clientOptions(signal)),
  governanceResources: (
    query: { resourceKind: ResourceKind; limit?: number; q?: string; cursor?: string },
    signal?: AbortSignal,
  ): Promise<CursorPage<GovernanceResource>> =>
    rpc.governance.resources({ query }, clientOptions(signal)),
  governanceIdentities: (
    query: { limit?: number; q?: string; cursor?: string },
    signal?: AbortSignal,
  ): Promise<CursorPage<GovernanceIdentity>> =>
    rpc.governance.identities({ query }, clientOptions(signal)),
  createDepartment: (name: string): Promise<Department> =>
    rpc.governance.departments.create({ body: { name } }),
  updateDepartment: (id: string, name: string): Promise<Department> =>
    rpc.governance.departments.update({ params: { id }, body: { name } }),
  deleteDepartment: (id: string): Promise<void> =>
    rpc.governance.departments.remove({ params: { id } }),
  setDepartmentMembers: (
    id: string,
    members: DepartmentMembersInput['members'],
  ): Promise<Department> =>
    rpc.governance.departments.members({ params: { id }, body: { members } }),
  upsertBudget: (input: BudgetInput): Promise<BudgetStatus> =>
    rpc.governance.budgets.upsert({ body: input }),
  deleteBudget: (id: string): Promise<void> => rpc.governance.budgets.remove({ params: { id } }),
  upsertResourceGrant: (input: ResourceGrantInput): Promise<ResourceGrant> =>
    rpc.governance.resourceGrants.upsert({ body: input }),
  deleteResourceGrant: (query: {
    resourceKind: ResourceKind;
    resourceId: string;
    businessId: string;
  }): Promise<void> => rpc.governance.resourceGrants.remove({ query }),
  transferHandover: (businessId: string, toBusinessId: string): Promise<HandoverTransferResult> =>
    rpc.governance.handover.transfer({ params: { businessId }, body: { toBusinessId } }),
  updateAlertSettings: (input: AlertSettings): Promise<AlertSettings> =>
    rpc.governance.alerts.update({ body: input }),
};
