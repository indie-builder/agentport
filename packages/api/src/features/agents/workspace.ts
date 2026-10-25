import type { McpJsonEntry, WorkspaceFiles } from '@agentport/core';
import { renderPlugin, renderWorkspace, toWorkspaceInput } from '@agentport/core';
import { repo } from '@agentport/db';
import * as agentRepo from '@agentport/db/repo/agents.js';
import { maskUrlCredentials, SECRET_MASK } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { str, strArray } from '../servers/repo.js';
import { decryptSecrets } from '../servers/secrets.js';

type ServerRow = Awaited<ReturnType<typeof agentRepo.getBoundServers>>[number];

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

  const [rows, skills, subAgentRows] = await Promise.all([
    agentRepo.getBoundServers(app.db, agent.id),
    agentRepo.getBoundSkills(app.db, agent.id),
    agentRepo.listSubAgents(app.db, agent.id),
  ]);
  // 停用的子智能体不渲染，也不查它们的技能。
  const enabledChildIds = subAgentRows.filter((row) => row.enabled).map((row) => row.id);
  const childSkills = await agentRepo.getBoundSkillsByAgentIds(app.db, enabledChildIds);
  const servers = rows.map((row) => {
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
      agent,
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
