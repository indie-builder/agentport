import type {
  Agent,
  AgentAccess,
  AgentBudgetStatus,
  AgentHookFile,
  AgentHooks,
  AgentInput,
  AgentMember,
  AgentPatch,
  CursorPage,
  OutputStyle,
  Rule,
  WorkspaceFiles,
} from '@agentport/shared';
import type { ApiClient } from '../orpc.js';
import { rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';
import { clientOptions, nativeRequest } from './shared.js';

export type { AgentAccess } from '@agentport/shared';

export type AgentFiles = WorkspaceFiles;

interface AgentImportResult {
  agent: Agent;
  createdServers: string[];
  reusedServers: string[];
  createdSkills: string[];
  createdSubAgents: string[];
  warnings: string[];
}

type AgentOptions = ApiOutput<ApiClient['agents']['options']>;

export type AgentListParams = Parameters<ApiClient['agents']['list']>[0]['query'];

export type AgentSummary = ApiOutput<ApiClient['agents']['list']>['items'][number];

export type AgentWriteResult = ApiOutput<ApiClient['agents']['update']>;

export type AgentMemberList = ApiOutput<ApiClient['agents']['members']>;

export type AgentVersionSummary = ApiOutput<ApiClient['agents']['versions']>[number];

export type AgentVersionDetail = ApiOutput<ApiClient['agents']['version']>;

export default {
  agents: (params: AgentListParams, signal?: AbortSignal): Promise<CursorPage<AgentSummary>> =>
    rpc.agents.list({ query: params }, clientOptions(signal)),
  agentReference: (signal?: AbortSignal) => rpc.agents.reference({}, clientOptions(signal)),
  agentTags: (): Promise<{ items: string[] }> => rpc.agents.tags({}),
  setAgentFavorite: (id: string, favorite: boolean): Promise<{ favorite: boolean }> =>
    rpc.agents.favorite({ params: { id }, body: { favorite } }),
  archiveAgent: (id: string): Promise<AgentSummary> => rpc.agents.archive({ params: { id } }),
  restoreAgent: (id: string): Promise<AgentSummary> => rpc.agents.restore({ params: { id } }),
  agent: (id: string, signal?: AbortSignal): Promise<Agent> =>
    rpc.agents.get({ params: { id } }, clientOptions(signal)),
  agentBudget: (id: string): Promise<AgentBudgetStatus> => rpc.agents.budget({ params: { id } }),
  createAgent: (input: AgentInput): Promise<Agent> => rpc.agents.create({ body: input }),
  agentAccess: (id: string): Promise<AgentAccess> => rpc.agents.access({ params: { id } }),
  agentOptions: (): Promise<AgentOptions> => rpc.agents.options({}),
  agentMembers: (id: string): Promise<AgentMemberList> => rpc.agents.members({ params: { id } }),
  setAgentMember: (
    id: string,
    businessId: string,
    input: { canUse: boolean; canMaintain: boolean },
  ): Promise<AgentMember> => rpc.agents.setMember({ params: { id, businessId }, body: input }),
  deleteAgentMember: (id: string, businessId: string): Promise<void> =>
    rpc.agents.deleteMember({ params: { id, businessId } }),
  transferAgent: (id: string, ownerBusinessId: string): Promise<Agent> =>
    rpc.agents.transfer({ params: { id }, body: { ownerBusinessId } }),
  updateAgent: (
    id: string,
    input: AgentPatch,
    expectedUpdatedAt?: string,
  ): Promise<AgentWriteResult> =>
    rpc.agents.update({
      params: { id },
      body: {
        ...input,
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      },
    }),
  duplicateAgent: (id: string, input: { slug: string; name: string }): Promise<Agent> =>
    rpc.agents.duplicate({ params: { id }, body: input }),
  deleteAgent: (id: string): Promise<void> => rpc.agents.delete({ params: { id } }),
  agentFiles: (id: string): Promise<AgentFiles> => rpc.agents.files({ params: { id }, query: {} }),
  agentVersions: (id: string): Promise<AgentVersionSummary[]> =>
    rpc.agents.versions({ params: { id } }),
  agentRules: (id: string): Promise<Rule[]> => rpc.agents.rules({ params: { id } }),
  writeAgentRule: (
    id: string,
    slug: string,
    input: { content: string; globs: string },
  ): Promise<Rule> => rpc.agents.writeRule({ params: { id, slug }, body: input }),
  deleteAgentRule: (id: string, slug: string): Promise<void> =>
    rpc.agents.deleteRule({ params: { id, slug } }),
  agentOutputStyles: (id: string): Promise<OutputStyle[]> =>
    rpc.agents.outputStyles({ params: { id } }),
  writeAgentOutputStyle: (
    id: string,
    slug: string,
    input: { description: string; keepCodingInstructions: boolean; body: string },
  ): Promise<OutputStyle> => rpc.agents.writeOutputStyle({ params: { id, slug }, body: input }),
  unselectAgentOutputStyle: (id: string, slug: string): Promise<void> =>
    rpc.agents.unselectOutputStyle({ params: { id, slug } }),
  deleteAgentOutputStyle: (id: string, slug: string): Promise<void> =>
    rpc.agents.deleteOutputStyle({ params: { id, slug } }),
  agentHooks: (id: string): Promise<AgentHooks> => rpc.agents.hooks({ params: { id } }),
  writeAgentHooksSettings: (
    id: string,
    input: { enabled: boolean; config: Record<string, unknown> | null },
  ): Promise<AgentHooks> => rpc.agents.writeHooksSettings({ params: { id }, body: input }),
  writeAgentHookFile: (
    id: string,
    input: { path: string; content: string; executable: boolean },
  ): Promise<AgentHookFile> => rpc.agents.writeHookFile({ params: { id }, body: input }),
  deleteAgentHookFile: (id: string, path: string): Promise<void> =>
    rpc.agents.deleteHookFile({ params: { id }, query: { path } }),
  agentVersion: (id: string, version: number): Promise<AgentVersionDetail> =>
    rpc.agents.version({ params: { id, version } }),
  rollbackAgent: (id: string, version: number): Promise<AgentWriteResult> =>
    rpc.agents.rollback({ params: { id }, body: { version } }),
  publishAgent: (id: string, note?: string): Promise<AgentWriteResult> =>
    rpc.agents.publish({
      params: { id },
      body: note === undefined || note === '' ? {} : { note },
    }),
  offlineAgent: (id: string): Promise<AgentWriteResult> => rpc.agents.offline({ params: { id } }),
  trialAgent: (id: string, prompt: string): Promise<{ runId: string; conversationId: string }> =>
    rpc.agents.trial({ params: { id }, body: { prompt } }),
  exportAgent: (
    id: string,
    signal?: AbortSignal,
    onWarnings?: (warnings: string[]) => void,
  ): Promise<Blob> =>
    nativeRequest(`/export/agents/${id}`, {
      signal,
      responseType: 'blob',
      onResponse: (response) => {
        if (onWarnings === undefined) return;
        const raw = response.headers.get('x-package-warnings');
        if (raw === null) return;
        try {
          const parsed: unknown = JSON.parse(decodeURIComponent(raw));
          if (Array.isArray(parsed)) onWarnings(parsed.filter((item) => typeof item === 'string'));
        } catch (error) {
          console.warn('Invalid x-package-warnings header', error);
        }
      },
    }),
  importAgent: (
    file: Blob,
    signal?: AbortSignal,
    runtimeEnvironmentId?: string,
  ): Promise<AgentImportResult> =>
    nativeRequest(
      `/import/agents${
        runtimeEnvironmentId === undefined
          ? ''
          : `?runtimeEnvironmentId=${encodeURIComponent(runtimeEnvironmentId)}`
      }`,
      { method: 'POST', body: file, signal },
    ),
  importAgentFile: (agentMd: string): Promise<Pick<AgentImportResult, 'agent' | 'warnings'>> =>
    rpc.agents.importFile({ body: { agentMd } }),
};
