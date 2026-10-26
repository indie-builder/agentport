import type { McpJsonEntry, WorkspaceFiles } from '@agentport/core';
import { renderPlugin, renderWorkspace, toWorkspaceInput, unionById } from '@agentport/core';
import { repo, type schema } from '@agentport/db';
import * as agentRepo from '@agentport/db/repo/agents.js';
import { knowledgeMcpEntry, maskUrlCredentials, SECRET_MASK } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { str, strArray } from '../servers/repo.js';
import { decryptSecrets } from '../servers/secrets.js';

type ServerRow = typeof schema.servers.$inferSelect;

/** 预览里密钥只保留键名；明文值只在 worker 写工作区时注入。 */
const PREVIEW_SECRET = SECRET_MASK;
const RUNTIME_AUTH_NOTE = 'Authorization 由运行时注入，不在此显示。';

// 沙盒视角的 API 地址；compose 内是 http://api:3000，本机 Docker 用 host.docker.internal。
function sandboxApiUrl(): string {
  return process.env.SANDBOX_API_URL ?? 'http://host.docker.internal:3000';
}

/** 保留键名、替换值：预览既能看到配置了哪些键，又拿不到任何密钥。 */
function maskValues(keys: string[], omitAuthorization = false): Record<string, string> {
  return Object.fromEntries(
    keys
      .filter((key) => !(omitAuthorization && key.toLowerCase() === 'authorization'))
      .map((key) => [key, PREVIEW_SECRET]),
  );
}

/**
 * DB 行 → 预览用 .mcp.json 条目。env/headers 只回键名；generated 的 Authorization
 * 由 worker 在运行时按 run 注入，因此这里完全省略并附一条说明。
 */
function toEntry(row: ServerRow, secretKeys: string[]): McpJsonEntry {
  const config = row.config;

  // 知识库连接器：地址与凭证都由平台按 run 生成，不能落到下方 generated 预览分支。
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
    // 与 worker 写入的地址保持一致，否则同一次运行里两个进程会渲染出不同的 .mcp.json。
    url: `${sandboxApiUrl()}/mcp/${row.id}`,
    headers: maskValues(secretKeys, true),
    _note: RUNTIME_AUTH_NOTE,
  };
}

/** 只渲染、不落盘：写工作区是 worker 的职责。 */
export async function renderAgentWorkspace(
  app: FastifyInstance,
  agentId: string,
): Promise<WorkspaceFiles | null> {
  const agent = await agentRepo.getAgent(app.db, agentId);
  if (!agent) return null;

  const [skills, subAgentRows] = await Promise.all([
    agentRepo.getBoundSkills(app.db, agent.id),
    agentRepo.listSubAgents(app.db, agent.id),
  ]);
  // 与 worker 落盘一致：.mcp.json 是父 + 启用子级绑定的并集，停用子级不参与运行时。
  const enabledChildren = subAgentRows.filter((row) => row.enabled);
  const enabledChildIds = enabledChildren.map((row) => row.id);
  const [serversByAgent, childSkills] = await Promise.all([
    agentRepo.getBoundServersByAgentIds(app.db, [agent.id, ...enabledChildIds]),
    agentRepo.getBoundSkillsByAgentIds(app.db, enabledChildIds),
  ]);
  const rootServers = serversByAgent.get(agent.id) ?? [];
  // 查询按 agent 分组返回；预览必须和 worker/导出一致按 id 排序，而不是继承分组顺序。
  const serverRows = unionById([
    rootServers,
    ...enabledChildren.map((row) => serversByAgent.get(row.id) ?? []),
  ]);
  const servers = serverRows.map((row) => {
    // 只传键名，值没有离开过加密列的解密结果，更不会进 API 响应。
    const secretKeys = row.secretsEncrypted
      ? Object.keys(decryptSecrets(row.secretsEncrypted, app.config.APP_SECRET_KEY))
      : [];
    return { name: row.name, entry: toEntry(row, secretKeys) };
  });

  // 技能的官方支持资源文件也纳入预览，保持与 worker 落盘一致。
  const skillFiles = await repo.skillFiles.getSkillFilesBySkillIds(app.db, [
    ...new Set([...skills, ...[...childSkills.values()].flat()].map((s) => s.id)),
  ]);
  const withFiles = (s: (typeof skills)[number]) => ({
    slug: s.slug,
    name: s.name,
    description: s.description,
    body: s.body,
    files: (skillFiles.get(s.id) ?? []).map((f) => ({ path: f.path, content: f.content })),
  });
  const skillsWithFiles = skills.map(withFiles);
  const subAgents = subAgentRows.map((row) => ({
    ...row,
    skills: (childSkills.get(row.id) ?? []).map(withFiles),
    // 子定义按名字引用根 .mcp.json 里自己的条目；父级在 agentMd 里禁用这些名字。
    serverNames: (serversByAgent.get(row.id) ?? []).map((server) => server.name),
  }));

  const ruleRows = await repo.rules.listRules(app.db, agent.id);
  const rules = ruleRows.map((r) => ({ slug: r.slug, content: r.content, globs: r.globs }));

  const styleRows = await repo.outputStyles.listOutputStyles(app.db, agent.id);
  const outputStyles = styleRows.map((r) => ({
    slug: r.slug,
    description: r.description,
    keepCodingInstructions: r.keepCodingInstructions,
    body: r.body,
  }));
  const selectedOutputStyle = styleRows.find((r) => r.isSelected)?.slug ?? null;
  // 预览与 worker 渲染同一份 CLAUDE.md：生成式 UI 的工具目录也要一致。
  const openuiTools =
    agent.uiFormat === 'openui' ? await repo.openui.listOpenUiTools(app.db, agent.id) : [];

  // 预览必须与运行同源：同一份 renderPlugin 裁剪规则，否则用户看到的文件和实际加载的不一致。
  // 子智能体不加载插件（worker 侧同样忽略），预览也按 parentId 过滤。
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
      rules,
      outputStyles,
      selectedOutputStyle,
      openuiTools,
      plugins,
    }),
  );
}
