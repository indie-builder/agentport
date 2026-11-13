import type {
  Agent,
  AgentAccess,
  AgentHookFile,
  AgentHooks,
  AgentInput,
  AgentMember,
  AgentPatch,
  OutputStyle,
  Rule,
  WorkspaceFiles,
} from '@agentport/shared';
import type { ApiClient } from '../orpc.js';
import { rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';
import { clientOptions, nativeRequest } from './shared.js';

export type { AgentAccess, AgentMember } from '@agentport/shared';

export type AgentFiles = WorkspaceFiles;

/** 导入官方目录包后新建/复用的资源；正文在文件里，这里只回名称供提示。 */
export interface AgentImportResult {
  agent: Agent;
  createdServers: string[];
  reusedServers: string[];
  createdSkills: string[];
  createdSubAgents: string[];
  warnings: string[];
}

export type AgentOptions = ApiOutput<ApiClient['agents']['options']>;

export type AgentSummary = ApiOutput<ApiClient['agents']['list']>[number];

export interface AgentMemberList {
  ownerBusinessId: string;
  members: AgentMember[];
}

export interface AgentVersionSummary {
  id: string;
  version: number;
  note: string | null;
  createdAt: string;
}

export interface AgentVersionDetail {
  version: number;
  snapshot: Agent;
  createdAt: string;
}

export default {
  agents: (): Promise<AgentSummary[]> => rpc.agents.list({}),
  agent: (id: string, signal?: AbortSignal): Promise<Agent> =>
    rpc.agents.get({ params: { id } }, clientOptions(signal)),
  createAgent: (input: AgentInput): Promise<Agent> => rpc.agents.create({ body: input }),
  agentAccess: (id: string): Promise<AgentAccess> => rpc.agents.access({ params: { id } }),
  agentOptions: (): Promise<AgentOptions> => rpc.agents.options({}),
  agentMembers: (id: string): Promise<AgentMemberList> => rpc.agents.members({ params: { id } }),
  setAgentMember: (
    id: string,
    businessId: string,
    input: { canUse: boolean; canMaintain: boolean },
  ): Promise<AgentMember> => rpc.agents.setMember({ params: { id, businessId }, body: input }),
  deleteAgentMember: (id: string, businessId: string): Promise<{ ok: boolean }> =>
    rpc.agents.deleteMember({ params: { id, businessId } }),
  transferAgent: (id: string, ownerBusinessId: string): Promise<Agent> =>
    rpc.agents.transfer({ params: { id }, body: { ownerBusinessId } }),
  updateAgent: (
    id: string,
    input: AgentPatch,
    expectedUpdatedAt?: string,
  ): Promise<Agent | AgentSummary> =>
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
    rpc.agents.deleteHookFile({ params: { id }, body: { path } }),
  agentVersion: (id: string, version: number): Promise<AgentVersionDetail> =>
    rpc.agents.version({ params: { id, version } }),
  rollbackAgent: (id: string, version: number): Promise<Agent> =>
    rpc.agents.rollback({ params: { id }, body: { version } }),
  /** 官方目录包的 ZIP；错误仍是 Problem JSON。 */
  exportAgent: (
    id: string,
    signal?: AbortSignal,
    onWarnings?: (warnings: string[]) => void,
  ): Promise<Blob> =>
    nativeRequest(`/export/agents/${id}`, 'GET', undefined, signal, 'blob', (response) => {
      if (onWarnings === undefined) return;
      const raw = response.headers.get('x-package-warnings');
      if (raw === null) return;
      try {
        const parsed: unknown = JSON.parse(decodeURIComponent(raw));
        if (Array.isArray(parsed)) onWarnings(parsed.filter((item) => typeof item === 'string'));
      } catch {
        // 头部损坏不影响下载本身，忽略即可。
      }
    }),
  /** 显式传环境 id 时覆盖包内名称映射；省略则按包中名称匹配。 */
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
      'POST',
      file,
      signal,
    ),
  importAgentFile: (agentMd: string): Promise<Pick<AgentImportResult, 'agent' | 'warnings'>> =>
    rpc.agents.importFile({ body: { agentMd } }),
};
