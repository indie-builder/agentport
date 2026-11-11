import type { McpJsonEntry, WorkspaceFiles } from '@agentport/core';
import { renderPlugin, renderWorkspace, toWorkspaceInput, unionById } from '@agentport/core';
import { repo, type schema } from '@agentport/db';
import { knowledgeMcpEntry, maskUrlCredentials, PREVIEW_SECRET } from '@agentport/shared';
import type { AppContext } from '../../http/context.js';
import { str, strArray } from '../servers/repo.js';
import { decryptSecrets } from '../servers/secrets.js';

type ServerRow = typeof schema.servers.$inferSelect;
const RUNTIME_AUTH_NOTE = 'Authorization 由运行时注入，不在此显示。';
function sandboxApiUrl(): string {
  return process.env.SANDBOX_API_URL ?? 'http://host.docker.internal:3000';
}
function maskValues(keys: string[], omitAuthorization = false): Record<string, string> {
  return Object.fromEntries(
    keys
      .filter((key) => !(omitAuthorization && key.toLowerCase() === 'authorization'))
      .map((key) => [key, PREVIEW_SECRET]),
  );
}
function toEntry(row: ServerRow, secretKeys: string[]): McpJsonEntry {
  const config = row.config;
  if (row.kind === 'knowledge') {
    return {
      ...knowledgeMcpEntry({
        apiUrl: sandboxApiUrl(),
        serverId: row.id,
        runId: '<run-id>',
        runToken: '<run-token>',
      }),
      _note: RUNTIME_AUTH_NOTE,
    };
  }
  if (row.kind === 'stdio') {
    return {
      command: str(config.command),
      args: strArray(config.args),
      env: maskValues(secretKeys),
    };
  }
  if (row.kind === 'http') {
    return {
      type: 'http',
      url: maskUrlCredentials(str(config.url)),
      headers: maskValues(secretKeys),
    };
  }
  return {
    type: 'http' as const,
    url: `${sandboxApiUrl()}/mcp/${row.id}`,
    headers: maskValues(secretKeys, true),
    _note: RUNTIME_AUTH_NOTE,
  };
}
export async function renderAgentWorkspace(
  app: Pick<AppContext, 'db' | 'config'>,
  agentId: string,
): Promise<WorkspaceFiles | null> {
  const agent = await repo.agents.getAgent(app.db, agentId);
  if (!agent) return null;
  const [skills, subAgentRows] = await Promise.all([
    repo.agents.getBoundSkills(app.db, agent.id),
    repo.agents.listSubAgents(app.db, agent.id),
  ]);
  const enabledChildren = subAgentRows.filter((row) => row.enabled);
  const enabledChildIds = enabledChildren.map((row) => row.id);
  const [serversByAgent, childSkills] = await Promise.all([
    repo.agents.getBoundServersByAgentIds(app.db, [agent.id, ...enabledChildIds]),
    repo.agents.getBoundSkillsByAgentIds(app.db, enabledChildIds),
  ]);
  const rootServers = serversByAgent.get(agent.id) ?? [];
  const serverRows = unionById([
    rootServers,
    ...enabledChildren.map((row) => serversByAgent.get(row.id) ?? []),
  ]);
  const servers = serverRows.map((row) => {
    const secretKeys = row.secretsEncrypted
      ? Object.keys(decryptSecrets(row.secretsEncrypted, app.config.APP_SECRET_KEY))
      : [];
    return { name: row.name, entry: toEntry(row, secretKeys) };
  });
  const skillFiles = await repo.skillFiles.getSkillFilesBySkillIds(app.db, [
    ...new Set([...skills, ...[...childSkills.values()].flat()].map((s) => s.id)),
  ]);
  const withFiles = (s: (typeof skills)[number]) => ({
    ...repo.skills.toSkillDefinition(s),
    files: (skillFiles.get(s.id) ?? []).map((f) => ({ path: f.path, content: f.content })),
  });
  const skillsWithFiles = skills.map(withFiles);
  const subAgents = subAgentRows.map((row) => ({
    ...row,
    skills: (childSkills.get(row.id) ?? []).map(withFiles),
    serverNames: (serversByAgent.get(row.id) ?? []).map((server) => server.name),
  }));
  const ruleRows = await repo.rules.listRules(app.db, agent.id);
  const rules = ruleRows.map((r) => ({ slug: r.slug, content: r.content, globs: r.globs }));
  const workflows =
    agent.parentId === null
      ? (await repo.workflows.listWorkflows(app.db, agent.id)).map((row) => ({
          slug: row.slug,
          content: row.content,
        }))
      : [];
  const hookFiles = agent.hooksEnabled
    ? (await repo.hooks.listHookFiles(app.db, agent.id)).map((file) => ({
        path: file.path,
        content: file.content,
        executable: file.executable,
      }))
    : [];
  const styleRows = await repo.outputStyles.listOutputStyles(app.db, agent.id);
  const outputStyles = styleRows.map((r) => ({
    slug: r.slug,
    description: r.description,
    keepCodingInstructions: r.keepCodingInstructions,
    body: r.body,
  }));
  const selectedOutputStyle = styleRows.find((r) => r.isSelected)?.slug ?? null;
  const openuiTools =
    agent.uiFormat === 'openui' ? await repo.openui.listOpenUiTools(app.db, agent.id) : [];
  const pluginBindings =
    agent.parentId === null ? await repo.plugins.listAgentPluginBindings(app.db, agent.id) : [];
  const pluginFiles = await repo.plugins.getPluginFilesByPluginIds(
    app.db,
    pluginBindings.map(({ plugin }) => plugin.id),
  );
  const plugins = pluginBindings.map(({ plugin, allowHooks, allowMcp }) =>
    renderPlugin({
      slug: plugin.slug,
      runtimeName: plugin.runtimeName,
      allowHooks,
      allowMcp,
      files: (pluginFiles.get(plugin.id) ?? []).map((file) => ({
        path: file.path,
        content: file.content,
        executable: file.executable,
      })),
    }),
  );
  return renderWorkspace(
    toWorkspaceInput({
      agent: { ...agent, serverNames: rootServers.map((server) => server.name) },
      servers,
      skills: skillsWithFiles,
      subAgents,
      workflows,
      rules,
      outputStyles,
      selectedOutputStyle,
      ...(agent.hooksEnabled && agent.hooksConfig ? { hooks: agent.hooksConfig } : {}),
      hookFiles,
      openuiTools,
      plugins,
    }),
  );
}
