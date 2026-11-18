import type { McpJsonEntry, WorkspacePlugin, WorkspaceSkill } from '@agentport/core';
import { renderWorkspace, WORKSPACE_FILE_MODE } from '@agentport/core';
import { toWorkspaceInput } from '@agentport/core/workspace-input';
import { type createDb, repo, type schema } from '@agentport/db';
import {
  effortSchema,
  type MemoryPolicy,
  permissionModeSchema,
  uiFormatSchema,
} from '@agentport/shared';
import type { Logger } from 'pino';
import { runWorkspaceDir } from '../session-workspace.js';
import { materializeWorkspace } from '../workspace-files.js';

type Db = ReturnType<typeof createDb>['db'];
type AgentRow = typeof schema.agents.$inferSelect;
/** 子智能体行带上自己的技能；根智能体的技能单独传，避免混进根配置。 */
export type SubAgentRow = AgentRow & { skills?: WorkspaceSkill[] };

export type WorkspaceAssemblyInput = {
  agent: AgentRow & { serverNames: string[] };
  runId: string;
  servers: Array<{ name: string; entry: McpJsonEntry }>;
  skills: Array<{
    slug: string;
    name: string;
    description: string;
    body: string;
    files?: Array<{ path: string; content: string }>;
  }>;
  subAgents: SubAgentRow[];
  rules: Array<{ slug: string; content: string; globs: string }>;
  outputStyles: Array<{
    slug: string;
    description: string;
    keepCodingInstructions: boolean;
    body: string;
  }>;
  selectedOutputStyle: string | null;
  workflows: Array<{ slug: string; content: string }>;
  hooks: Record<string, unknown> | null;
  hookFiles: Array<{ path: string; content: string; executable: boolean }>;
  plugins: WorkspacePlugin[];
  /** 本轮已解析的专家记忆策略：CLAUDE.md 的记忆文案必须与记忆挂载权限同源。 */
  memoryPolicy: MemoryPolicy;
};

export function createWorkspaceAssembly(deps: { db: Db; workspacesDir: string; logger: Logger }) {
  return async function writeWorkspace(
    input: WorkspaceAssemblyInput,
  ): Promise<{ dir: string; hasSubAgents: boolean; hasWorkflows: boolean }> {
    const {
      agent,
      runId,
      servers,
      skills,
      subAgents,
      rules,
      outputStyles,
      selectedOutputStyle,
      workflows,
      hooks,
      hookFiles,
      plugins,
      memoryPolicy,
    } = input;
    // 生成式 UI 的工具目录与提示词、执行桥同源：这里查一次，渲染时写进 CLAUDE.md。
    const openuiTools =
      agent.uiFormat === 'openui' ? await repo.openui.listOpenUiTools(deps.db, agent.id) : [];
    const files = renderWorkspace(
      toWorkspaceInput({
        agent: {
          ...agent,
          permissionMode: permissionModeSchema.parse(agent.permissionMode),
          uiFormat: uiFormatSchema.parse(agent.uiFormat),
          effort: effortSchema.nullable().parse(agent.effort),
        },
        servers,
        skills,
        subAgents: subAgents.map((row) => ({
          ...row,
          permissionMode: permissionModeSchema.parse(row.permissionMode),
          uiFormat: uiFormatSchema.parse(row.uiFormat),
          effort: effortSchema.nullable().parse(row.effort),
        })),
        rules,
        outputStyles,
        selectedOutputStyle,
        workflows,
        ...(hooks ? { hooks } : {}),
        hookFiles,
        openuiTools,
        plugins,
        memoryPolicy,
      }),
    );

    // 按 run 隔离：同一智能体并发运行时不能互相覆盖 .mcp.json / 技能 / 子智能体。
    const dir = runWorkspaceDir(deps.workspacesDir, agent.slug, runId);
    await materializeWorkspace(dir, files);
    deps.logger.debug(
      { runId, dir, mode: WORKSPACE_FILE_MODE.toString(8) },
      'workspace permissions applied',
    );
    return {
      dir,
      hasSubAgents: files.subAgents.length > 0,
      hasWorkflows: files.workflows.length > 0,
    };
  };
}
