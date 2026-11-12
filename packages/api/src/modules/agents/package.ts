import { randomBytes } from 'node:crypto';
import type { McpJsonEntry, WorkspaceSkill } from '@agentport/core';
import {
  AppError,
  decryptSecrets,
  fail,
  parseChildAgentMd,
  parseClaudeMd,
  parseOutputStyleMd,
  parseRuleMd,
  parseSkillMd,
  parseWorkflowMeta,
  renderOutputStyleMd,
  renderRuleMd,
  renderSkillMd,
  renderSubAgentMd,
  renderWorkspace,
  toWorkspaceAgent,
  toWorkspaceInput,
  unionById,
} from '@agentport/core';
import type { Database, Transaction } from '@agentport/db';
import {
  agentHookFiles,
  agentOutputStyles,
  agentRules,
  agentServers,
  agentSkills,
  agents,
  agentWorkflows,
  apiTools,
  newId,
  repo,
  servers,
  skillFiles,
  skills,
} from '@agentport/db';
import type {
  Agent,
  AgentInput,
  AgentPackageSidecar,
  ApiToolInput,
  PackageServer,
  PackageSubAgent,
  ServerInput,
} from '@agentport/shared';
import {
  AGENT_PACKAGE_LIMITS,
  AGENT_PACKAGE_MAX_BYTES,
  AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES,
  AGENT_PACKAGE_PATHS,
  AGENT_PACKAGE_SIDECAR,
  AGENT_PACKAGE_SIDECAR_VERSION,
  agentHookFileInputSchema,
  agentHookFilePathSchema,
  agentHooksConfigSchema,
  agentPackageSidecarSchema,
  findSkillResourcePathConflict,
  knowledgeTokenEnv,
  PORTABLE_TODO_ENV,
  skillFileInputSchema,
  slugSchema,
} from '@agentport/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { isPgCode } from '../../http/errors.js';
import { assertSafeUrl, assertServerEndpoint } from '../servers/ssrf.js';
import { decodePackage, encodePackageEntries } from './package-zip.js';
import { unsupportedAllowedTool } from './validation.js';
import { toAgentConfigValues } from './write.js';

type ServerRow = typeof servers.$inferSelect;
type SkillRow = typeof skills.$inferSelect;
type ToolRow = typeof apiTools.$inferSelect;
type RuleRow = typeof agentRules.$inferSelect;
type StyleRow = typeof agentOutputStyles.$inferSelect;
export interface AgentPackageImportResult {
  agent: Agent;
  createdServers: string[];
  reusedServers: string[];
  createdSkills: string[];
  createdSubAgents: string[];
  warnings: string[];
}
function exportUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value;
  }
}
function knowledgePackageEntries(
  row: Pick<ServerRow, 'id' | 'name' | 'description'>,
  selfUrl: string,
) {
  const url = `${selfUrl.replace(/\/$/, '')}/mcp/${row.id}`;
  const tokenEnv = knowledgeTokenEnv(row.name);
  return {
    server: {
      name: row.name,
      description: row.description,
      kind: 'http' as const,
      url,
      secretKeys: [tokenEnv],
    },
    mcpEntry: {
      type: 'http' as const,
      url,
      headers: { Authorization: `Bearer \${${tokenEnv}}` },
    },
  };
}
function toExportedServer(
  row: ServerRow,
  key: string,
  tools: ToolRow[] | undefined,
  selfUrl: string,
): PackageServer {
  if (row.kind === 'knowledge') return knowledgePackageEntries(row, selfUrl).server;
  const base = {
    name: row.name,
    description: row.description,
    secretKeys: row.secretsEncrypted
      ? Object.keys(decryptSecrets(row.secretsEncrypted, key)).sort()
      : [],
  };
  if (row.kind === 'stdio') {
    const args = row.config.args;
    return {
      ...base,
      kind: 'stdio',
      command: typeof row.config.command === 'string' ? row.config.command : '',
      args: Array.isArray(args)
        ? args.filter((value): value is string => typeof value === 'string')
        : [],
    };
  }
  const raw = row.kind === 'generated' ? row.config.baseUrl : row.config.url;
  const url = exportUrl(typeof raw === 'string' ? raw : '');
  if (row.kind === 'http') return { ...base, kind: 'http', url };
  return {
    ...base,
    kind: 'generated',
    baseUrl: url,
    ...(tools === undefined
      ? {}
      : {
          tools: tools.map(
            (
              tool,
            ): ApiToolInput & {
              enabled: boolean;
            } => ({
              name: tool.name,
              description: tool.description,
              method: tool.method as ApiToolInput['method'],
              pathTemplate: tool.pathTemplate,
              inputSchema: tool.inputSchema,
              paramsIn: tool.paramsIn,
              enabled: tool.enabled,
              requiresApproval: tool.requiresApproval,
            }),
          ),
        }),
  };
}
function toPreviewEntry(row: ServerRow, selfUrl: string): McpJsonEntry {
  if (row.kind === 'knowledge') return knowledgePackageEntries(row, selfUrl).mcpEntry;
  if (row.kind === 'stdio') {
    const args = row.config.args;
    return {
      command: typeof row.config.command === 'string' ? row.config.command : '',
      args: Array.isArray(args)
        ? args.filter((value): value is string => typeof value === 'string')
        : [],
      env: {},
    };
  }
  if (row.kind === 'generated') {
    return { type: 'http', url: `${selfUrl.replace(/\/$/, '')}/mcp/${row.id}`, headers: {} };
  }
  const raw = row.config.url;
  return {
    type: 'http',
    url: exportUrl(typeof raw === 'string' ? raw : ''),
    headers: {},
  };
}
async function rulesByAgent(db: Database, agentIds: string[]): Promise<Map<string, RuleRow[]>> {
  const rows = await db
    .select()
    .from(agentRules)
    .where(inArray(agentRules.agentId, agentIds))
    .orderBy(asc(agentRules.agentId), asc(agentRules.slug));
  const out = new Map<string, RuleRow[]>();
  for (const row of rows) {
    const list = out.get(row.agentId);
    if (list) list.push(row);
    else out.set(row.agentId, [row]);
  }
  return out;
}
async function stylesByAgent(db: Database, agentIds: string[]): Promise<Map<string, StyleRow[]>> {
  const rows = await db
    .select()
    .from(agentOutputStyles)
    .where(inArray(agentOutputStyles.agentId, agentIds))
    .orderBy(asc(agentOutputStyles.agentId), asc(agentOutputStyles.slug));
  const out = new Map<string, StyleRow[]>();
  for (const row of rows) {
    const list = out.get(row.agentId);
    if (list) list.push(row);
    else out.set(row.agentId, [row]);
  }
  return out;
}
function toPortableRules(rows: RuleRow[]) {
  return rows.map((row) => ({ slug: row.slug, content: row.content, globs: row.globs }));
}
function toPortableStyles(rows: StyleRow[]) {
  return rows.map((row) => ({
    slug: row.slug,
    description: row.description,
    keepCodingInstructions: row.keepCodingInstructions,
    body: row.body,
    isSelected: row.isSelected,
  }));
}
function checkLimit(count: number, max: number, message: string): void {
  if (count > max) fail('INVALID_INPUT', message);
}
function checkAllowedTools(tools: string[], path: string): string[] {
  const reason = unsupportedAllowedTool(tools);
  if (reason !== undefined) fail('INVALID_INPUT', reason, { path: `${path}/allowedTools` });
  return tools;
}
function checkExportLimit(count: number, max: number, message: string): void {
  if (count > max) fail('CONFLICT', message);
}
function assertDefinitionLimits(
  rules: RuleRow[],
  styles: StyleRow[],
  owner: string,
  path: string,
): void {
  checkExportLimit(
    rules.length,
    AGENT_PACKAGE_LIMITS.rules,
    `「${owner}」的规则超过 ${AGENT_PACKAGE_LIMITS.rules} 条，请减少后重试`,
  );
  checkExportLimit(
    styles.length,
    AGENT_PACKAGE_LIMITS.outputStyles,
    `「${owner}」的输出风格超过 ${AGENT_PACKAGE_LIMITS.outputStyles} 个，请减少后重试`,
  );
  for (const [label, entries] of [
    ['规则', rules],
    ['输出风格', styles],
  ] as const) {
    const slugs = new Set<string>();
    for (const entry of entries) {
      if (!slugSchema.safeParse(entry.slug).success || slugs.has(entry.slug)) {
        fail('INVALID_INPUT', `${owner} 的${label}必须使用合法、唯一的 slug`, {
          path: `${path}/${entry.slug}`,
        });
      }
      slugs.add(entry.slug);
    }
  }
}
function assertSkillResourcePaths(
  skill: string,
  files: Array<{
    path: string;
    content: string;
  }>,
  mode: 'import' | 'export' = 'import',
): Array<{
  path: string;
  content: string;
}> {
  (mode === 'export' ? checkExportLimit : checkLimit)(
    files.length,
    AGENT_PACKAGE_LIMITS.skillFiles,
    `技能「${skill}」的资源文件超过 ${AGENT_PACKAGE_LIMITS.skillFiles} 个，请减少后重试`,
  );
  for (const file of files) {
    const parsed = skillFileInputSchema.shape.path.safeParse(file.path);
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? '路径格式不合法';
      fail('INVALID_INPUT', `技能「${skill}」的资源路径「${file.path}」不合法：${reason}`, {
        path: `.claude/skills/${skill}/${file.path}`,
      });
    }
  }
  const conflict = findSkillResourcePathConflict(files.map((file) => file.path));
  if (conflict !== undefined) {
    fail('INVALID_INPUT', `技能「${skill}」的资源路径「${conflict.path}」冲突或占用了 SKILL.md`, {
      path: `.claude/skills/${skill}/${conflict.path}`,
    });
  }
  return files;
}
export interface AgentPackageFiles {
  files: Record<string, string>;
  slug: string;
  warnings: string[];
  executablePaths?: readonly string[];
}
export async function buildAgentPackage(
  db: Database,
  key: string,
  selfUrl: string,
  row: repo.agents.AgentRow,
): Promise<AgentPackageFiles> {
  const children = await repo.agents.listSubAgents(db, row.id);
  checkExportLimit(
    children.length,
    AGENT_PACKAGE_LIMITS.subAgents,
    `该智能体有 ${children.length} 个子智能体，超过导出上限 ${AGENT_PACKAGE_LIMITS.subAgents} 个；请先减少子智能体`,
  );
  const agentIds = [row.id, ...children.map((child) => child.id)];
  const [serversByAgent, skillsByAgent, rulesMap, stylesMap, workflows] = await Promise.all([
    repo.agents.getBoundServersByAgentIds(db, agentIds),
    repo.agents.getBoundSkillsByAgentIds(db, agentIds),
    rulesByAgent(db, agentIds),
    stylesByAgent(db, agentIds),
    row.parentId === null ? repo.workflows.listWorkflows(db, row.id) : Promise.resolve([]),
  ]);
  const rootServers = serversByAgent.get(row.id) ?? [];
  const rootSkills = skillsByAgent.get(row.id) ?? [];
  const allServers = unionById([
    rootServers,
    ...children.map((child) => serversByAgent.get(child.id) ?? []),
  ]);
  const allSkills = unionById([
    rootSkills,
    ...children.map((child) => skillsByAgent.get(child.id) ?? []),
  ]);
  checkExportLimit(
    allServers.length,
    AGENT_PACKAGE_LIMITS.resources,
    `导出包含 ${allServers.length} 个 Server，超过上限 ${AGENT_PACKAGE_LIMITS.resources}；请先减少绑定`,
  );
  checkExportLimit(
    allSkills.length,
    AGENT_PACKAGE_LIMITS.resources,
    `导出包含 ${allSkills.length} 个技能，超过上限 ${AGENT_PACKAGE_LIMITS.resources}；请先减少绑定`,
  );
  const skillFiles = await repo.skillFiles.getSkillFilesBySkillIds(
    db,
    allSkills.map((skill) => skill.id),
  );
  const withFiles = (skill: SkillRow): WorkspaceSkill => ({
    ...repo.skills.toSkillDefinition(skill),
    files: skillFiles.get(skill.id) ?? [],
  });
  checkExportLimit(
    workflows.length,
    AGENT_PACKAGE_LIMITS.workflows,
    `该智能体有 ${workflows.length} 个工作流，超过导出上限 ${AGENT_PACKAGE_LIMITS.workflows} 个；请先减少工作流`,
  );
  const rootRules = rulesMap.get(row.id) ?? [];
  const rootStyles = stylesMap.get(row.id) ?? [];
  assertDefinitionLimits(rootRules, rootStyles, row.slug, '');
  for (const child of children) {
    assertDefinitionLimits(
      rulesMap.get(child.id) ?? [],
      stylesMap.get(child.id) ?? [],
      child.slug,
      `${AGENT_PACKAGE_PATHS.agentsDir}${child.slug}.md`,
    );
  }
  for (const skill of allSkills) {
    assertSkillResourcePaths(skill.slug, skillFiles.get(skill.id) ?? [], 'export');
  }
  const files: Record<string, string> = {};
  const allServerEntries = allServers.map((server) => ({
    name: server.name,
    entry: toPreviewEntry(server, selfUrl),
  }));
  const selectedOutputStyle = rootStyles.find((style) => style.isSelected)?.slug ?? null;
  const hookFiles = await repo.hooks.listHookFiles(db, row.id);
  checkExportLimit(
    hookFiles.length,
    AGENT_PACKAGE_LIMITS.hookFiles,
    `该智能体有 ${hookFiles.length} 个 hook 脚本，超过导出上限 ${AGENT_PACKAGE_LIMITS.hookFiles} 个；请先减少脚本`,
  );
  const workspace = renderWorkspace(
    toWorkspaceInput({
      agent: { ...row, serverNames: rootServers.map((server) => server.name) },
      servers: allServerEntries,
      skills: rootSkills.map(withFiles),
      subAgents: children.map((child) => ({
        ...child,
        serverNames: (serversByAgent.get(child.id) ?? []).map((server) => server.name),
        skills: (skillsByAgent.get(child.id) ?? []).map(withFiles),
      })),
      rules: toPortableRules(rootRules),
      outputStyles: toPortableStyles(rootStyles),
      selectedOutputStyle,
    }),
  );
  files[AGENT_PACKAGE_PATHS.claudeMd] = workspace.claudeMd;
  files[AGENT_PACKAGE_PATHS.mcpJson] = workspace.mcpJson;
  for (const rule of rootRules) {
    files[`${AGENT_PACKAGE_PATHS.rulesDir}${rule.slug}.md`] = renderRuleMd(rule);
  }
  for (const style of rootStyles) {
    files[`${AGENT_PACKAGE_PATHS.outputStylesDir}${style.slug}.md`] = renderOutputStyleMd(style);
  }
  for (const workflow of workflows) {
    files[`${AGENT_PACKAGE_PATHS.workflowsDir}${workflow.slug}.js`] = workflow.content;
  }
  const executablePaths: string[] = [];
  for (const file of hookFiles) {
    const path = `${AGENT_PACKAGE_PATHS.hooksDir}${file.path}`;
    files[path] = file.content;
    if (file.executable) executablePaths.push(path);
  }
  files[AGENT_PACKAGE_PATHS.settings] = `${JSON.stringify(
    {
      env: PORTABLE_TODO_ENV,
      ...(selectedOutputStyle === null ? {} : { outputStyle: selectedOutputStyle }),
      ...(row.hooksEnabled && row.hooksConfig ? { hooks: row.hooksConfig } : {}),
    },
    null,
    2,
  )}\n`;
  for (const skill of allSkills) {
    const base = `${AGENT_PACKAGE_PATHS.skillsDir}${skill.slug}/`;
    files[`${base}SKILL.md`] = renderSkillMd(withFiles(skill));
    for (const file of skillFiles.get(skill.id) ?? []) files[`${base}${file.path}`] = file.content;
  }
  for (const child of children) {
    files[`${AGENT_PACKAGE_PATHS.agentsDir}${child.slug}.md`] = renderSubAgentMd({
      agent: toWorkspaceAgent({
        ...child,
        serverNames: (serversByAgent.get(child.id) ?? []).map((server) => server.name),
      }),
      servers: allServerEntries,
      skills: (skillsByAgent.get(child.id) ?? []).map(withFiles),
    });
  }
  const generatedIds = allServers
    .filter((server) => server.kind === 'generated')
    .map((server) => server.id);
  const toolRows =
    generatedIds.length === 0
      ? []
      : await db
          .select()
          .from(apiTools)
          .where(inArray(apiTools.serverId, generatedIds))
          .orderBy(asc(apiTools.createdAt), asc(apiTools.id));
  const toolsByServerId = new Map<string, ToolRow[]>();
  for (const tool of toolRows) {
    const list = toolsByServerId.get(tool.serverId);
    if (list) list.push(tool);
    else toolsByServerId.set(tool.serverId, [tool]);
  }
  const runtimeEnvironment =
    row.runtimeEnvironmentId === null
      ? null
      : await repo.runtimeEnvironments.getRuntimeEnvironment(db, row.runtimeEnvironmentId);
  if (row.runtimeEnvironmentId !== null && runtimeEnvironment === null) {
    fail('CONFLICT', '该专家绑定的运行环境已不存在，无法导出；请重新选择运行环境');
  }
  const sidecar = {
    version: AGENT_PACKAGE_SIDECAR_VERSION,
    agent: {
      slug: row.slug,
      name: row.name,
      role: row.role,
      description: row.description,
      model: row.model,
      permissionMode: row.permissionMode,
      uiFormat: row.uiFormat,
      maxTurns: row.maxTurns,
      maxBudgetUsd: Number(row.maxBudgetUsd),
      timeoutMs: row.timeoutMs,
      ...(row.effort === null ? {} : { effort: row.effort }),
      enabled: row.enabled,
      allowedTools: row.allowedTools,
      disallowedTools: row.disallowedTools,
      serverNames: rootServers.map((server) => server.name),
      skillSlugs: rootSkills.map((skill) => skill.slug),
      ...(runtimeEnvironment === null ? {} : { runtimeEnvironmentName: runtimeEnvironment.name }),
    },
    servers: allServers.map((server) =>
      toExportedServer(
        server,
        key,
        server.kind === 'generated' ? (toolsByServerId.get(server.id) ?? []) : undefined,
        selfUrl,
      ),
    ),
    subAgents: children.map((child) => ({
      slug: child.slug,
      permissionMode: child.permissionMode,
      maxBudgetUsd: Number(child.maxBudgetUsd),
      timeoutMs: child.timeoutMs,
      enabled: child.enabled,
      allowedTools: child.allowedTools,
      disallowedTools: child.disallowedTools,
      rules: toPortableRules(rulesMap.get(child.id) ?? []),
      outputStyles: toPortableStyles(stylesMap.get(child.id) ?? []),
    })),
  };
  const parsed = agentPackageSidecarSchema.safeParse(sidecar);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = `智能体定义无法导出：${issue?.message ?? '字段不合法'}`;
    const path = issue?.path.map(String).join('/');
    fail('INVALID_INPUT', message, path === undefined ? undefined : { path });
  }
  files[AGENT_PACKAGE_SIDECAR] = `${JSON.stringify(parsed.data, null, 2)}\n`;
  const pluginBindings = await repo.plugins.listAgentPluginBindingInputs(db, [row.id]);
  const boundPlugins = pluginBindings.get(row.id) ?? [];
  const warnings =
    boundPlugins.length === 0
      ? []
      : [
          `该专家绑定了 ${boundPlugins.length} 个插件，插件代码不随专家包导出；导入后需要在本机插件库重新绑定`,
        ];
  return { files, slug: row.slug, warnings, executablePaths };
}
export function packAgentPackage(pkg: AgentPackageFiles): Buffer {
  const uncompressedBytes = Object.values(pkg.files).reduce(
    (total, content) => total + Buffer.byteLength(content, 'utf8'),
    0,
  );
  checkExportLimit(
    uncompressedBytes,
    AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES,
    '专家包解压后超过 4 MiB，请减少提示词、技能或工具定义后重试',
  );
  const executablePaths = new Set(pkg.executablePaths);
  const body = encodePackageEntries(
    Object.entries(pkg.files).map(([path, content]) => ({
      path,
      content,
      executable: executablePaths.has(path),
    })),
  );
  if (body.byteLength > AGENT_PACKAGE_MAX_BYTES) {
    fail('CONFLICT', '专家包超过 1 MiB，请减少提示词、技能或工具定义后重试');
  }
  try {
    decodePackage(body);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    fail('CONFLICT', `专家包无法通过导入校验：${error.message}`, { cause: error });
  }
  return body;
}
interface ParsedPackage {
  agent: PackageInput;
  servers: PackageServer[];
  children: PackageChildInput[];
  skills: PackageSkillInput[];
  workflows: PackageWorkflowInput[];
  rules: PackageRuleInput[];
  styles: PackageStyleInput[];
  hooks: {
    config: Record<string, unknown> | null;
    files: Array<{ path: string; content: string; executable: boolean }>;
  };
  runtimeEnvironmentName?: string;
}
interface PackageInput {
  input: Omit<AgentInput, 'serverIds' | 'skillIds' | 'subAgentIds' | 'runtimeEnvironmentId'>;
  serverNames: string[];
  skillSlugs: string[];
}
interface PackageChildInput extends PackageInput {
  rules: PackageRuleInput[];
  outputStyles: PackageStyleInput[];
}
interface PackageSkillInput {
  slug: string;
  name: string;
  description: string;
  body: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  files: Array<{
    path: string;
    content: string;
  }>;
}
interface PackageWorkflowInput {
  slug: string;
  name: string;
  description: string;
  content: string;
}
interface PackageRuleInput {
  slug: string;
  content: string;
  globs: string;
}
interface PackageStyleInput {
  slug: string;
  description: string;
  keepCodingInstructions: boolean;
  body: string;
  isSelected: boolean;
}
function isKnownPath(path: string): boolean {
  if (
    path === AGENT_PACKAGE_PATHS.claudeMd ||
    path === AGENT_PACKAGE_PATHS.mcpJson ||
    path === AGENT_PACKAGE_PATHS.settings ||
    path === AGENT_PACKAGE_SIDECAR
  ) {
    return true;
  }
  if (path.startsWith(AGENT_PACKAGE_PATHS.agentsDir)) {
    return /^[^/]+\.md$/.test(path.slice(AGENT_PACKAGE_PATHS.agentsDir.length));
  }
  if (path.startsWith(AGENT_PACKAGE_PATHS.rulesDir)) {
    return /^[^/]+\.md$/.test(path.slice(AGENT_PACKAGE_PATHS.rulesDir.length));
  }
  if (path.startsWith(AGENT_PACKAGE_PATHS.outputStylesDir)) {
    return /^[^/]+\.md$/.test(path.slice(AGENT_PACKAGE_PATHS.outputStylesDir.length));
  }
  if (path.startsWith(AGENT_PACKAGE_PATHS.skillsDir)) {
    const rest = path.slice(AGENT_PACKAGE_PATHS.skillsDir.length).split('/');
    return rest.length >= 2 && (rest[0] ?? '').length > 0;
  }
  if (path.startsWith(AGENT_PACKAGE_PATHS.workflowsDir)) {
    return /^[^/]+\.js$/.test(path.slice(AGENT_PACKAGE_PATHS.workflowsDir.length));
  }
  if (path.startsWith(AGENT_PACKAGE_PATHS.hooksDir)) {
    return agentHookFilePathSchema.safeParse(path.slice(AGENT_PACKAGE_PATHS.hooksDir.length))
      .success;
  }
  return false;
}
function listMarkdown(files: Map<string, string>, prefix: string) {
  const out: Array<{
    slug: string;
    path: string;
    content: string;
  }> = [];
  for (const [path, content] of files) {
    if (!path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length);
    if (!name.endsWith('.md') || name.includes('/')) continue;
    out.push({ slug: name.slice(0, -3), path, content });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}
function duplicateSlugs(
  entries: Array<{
    slug: string;
  }>,
  label: string,
  path: string,
): void {
  const seen = new Set<string>();
  for (const { slug } of entries) {
    if (seen.has(slug)) fail('INVALID_INPUT', `${label}「${slug}」重复`, { path });
    seen.add(slug);
  }
}
function checkRefs(refs: string[], known: Set<string>, label: string, path: string): void {
  const seen = new Set<string>();
  for (const value of refs) {
    if (seen.has(value)) fail('INVALID_INPUT', `「${value}」被重复引用`, { path });
    seen.add(value);
    if (!known.has(value)) {
      fail('INVALID_INPUT', `引用的「${value}」不在包内的 ${label} 中`, { path });
    }
  }
}
function declaresMcpServers(mcpJson: string | undefined): boolean {
  if (mcpJson === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(mcpJson);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const servers = (
      parsed as {
        mcpServers?: unknown;
      }
    ).mcpServers;
    return typeof servers === 'object' && servers !== null && Object.keys(servers).length > 0;
  } catch {
    fail('INVALID_INPUT', '.mcp.json 不是合法 JSON', { path: AGENT_PACKAGE_PATHS.mcpJson });
  }
}
function parseSidecar(raw: unknown): AgentPackageSidecar {
  const parsed = agentPackageSidecarSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = `${AGENT_PACKAGE_SIDECAR}/${(issue?.path ?? []).map(String).join('/')}`;
    fail('INVALID_INPUT', `${AGENT_PACKAGE_SIDECAR} 不合法：${issue?.message ?? '字段校验失败'}`, {
      path,
    });
  }
  return parsed.data;
}
export function parseAgentPackage(
  files: Map<string, string>,
  options: {
    slug?: string;
    name?: string;
    executables?: ReadonlyMap<string, boolean>;
  },
): ParsedPackage {
  for (const path of files.keys()) {
    if (!isKnownPath(path)) {
      fail('INVALID_INPUT', `包内包含平台不支持的路径「${path}」`, { path });
    }
  }
  const claudeMd = files.get(AGENT_PACKAGE_PATHS.claudeMd);
  if (claudeMd === undefined) {
    fail('INVALID_INPUT', '专家包缺少根 CLAUDE.md；它承载智能体的系统提示', {
      path: AGENT_PACKAGE_PATHS.claudeMd,
    });
  }
  const parsedClaude = parseClaudeMd(claudeMd);
  const sidecarText = files.get(AGENT_PACKAGE_SIDECAR);
  let sidecar: AgentPackageSidecar;
  if (sidecarText === undefined) {
    if (declaresMcpServers(files.get(AGENT_PACKAGE_PATHS.mcpJson))) {
      fail(
        'INVALID_INPUT',
        '目录包含 MCP 配置；连接器绑定与凭据属于平台元数据，请附带 agentport.json 或先在平台创建连接器',
        { path: AGENT_PACKAGE_PATHS.mcpJson },
      );
    }
    const rawSlug = options.slug ?? parsedClaude.name;
    if (!slugSchema.safeParse(rawSlug).success) {
      fail(
        'INVALID_INPUT',
        '没有 sidecar 时 slug 必须由 ?slug= 提供，或 CLAUDE.md 首行本身就是合法 slug',
        { path: 'slug' },
      );
    }
    sidecar = parseSidecar({
      version: AGENT_PACKAGE_SIDECAR_VERSION,
      agent: { slug: rawSlug, name: options.name ?? parsedClaude.name },
    });
  } else {
    let raw: unknown;
    try {
      raw = JSON.parse(sidecarText);
    } catch {
      fail('INVALID_INPUT', `${AGENT_PACKAGE_SIDECAR} 不是合法 JSON`, {
        path: AGENT_PACKAGE_SIDECAR,
      });
    }
    sidecar = parseSidecar(raw);
  }
  const rootInput = {
    slug: options.slug ?? sidecar.agent.slug,
    name: options.name ?? sidecar.agent.name,
    role: sidecar.agent.role,
    description: sidecar.agent.description,
    model: sidecar.agent.model,
    systemPrompt: parsedClaude.systemPrompt,
    allowedTools: checkAllowedTools(sidecar.agent.allowedTools, `${AGENT_PACKAGE_SIDECAR}/agent`),
    disallowedTools: sidecar.agent.disallowedTools,
    pluginBindings: [],
    permissionMode: sidecar.agent.permissionMode,
    uiFormat: sidecar.agent.uiFormat,
    maxTurns: sidecar.agent.maxTurns,
    maxBudgetUsd: sidecar.agent.maxBudgetUsd,
    timeoutMs: sidecar.agent.timeoutMs,
    ...(sidecar.agent.effort === undefined ? {} : { effort: sidecar.agent.effort }),
    enabled: sidecar.agent.enabled,
  };
  const rules = listMarkdown(files, AGENT_PACKAGE_PATHS.rulesDir).map((file) =>
    parseRuleMd(file.content, file.slug, file.path),
  );
  duplicateSlugs(rules, '规则', AGENT_PACKAGE_PATHS.rulesDir);
  checkLimit(
    rules.length,
    AGENT_PACKAGE_LIMITS.rules,
    `规则超过 ${AGENT_PACKAGE_LIMITS.rules} 条，请减少后重试`,
  );
  const portableSettings = readPortableSettings(files.get(AGENT_PACKAGE_PATHS.settings));
  const selectedStyle = portableSettings.outputStyle;
  const hookFiles = [...files]
    .filter(([path]) => path.startsWith(AGENT_PACKAGE_PATHS.hooksDir))
    .map(([path, content]) => {
      const parsed = agentHookFileInputSchema.safeParse({
        path: path.slice(AGENT_PACKAGE_PATHS.hooksDir.length),
        content,
        executable: options.executables?.get(path) ?? false,
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        fail('INVALID_INPUT', `hook 脚本不合法：${issue?.message ?? '字段校验失败'}`, { path });
      }
      return parsed.data;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  checkLimit(
    hookFiles.length,
    AGENT_PACKAGE_LIMITS.hookFiles,
    `hook 脚本超过 ${AGENT_PACKAGE_LIMITS.hookFiles} 个，请减少后重试`,
  );
  const styleBodies = listMarkdown(files, AGENT_PACKAGE_PATHS.outputStylesDir).map((file) =>
    parseOutputStyleMd(file.content, file.slug, file.path),
  );
  duplicateSlugs(styleBodies, '输出风格', AGENT_PACKAGE_PATHS.outputStylesDir);
  checkLimit(
    styleBodies.length,
    AGENT_PACKAGE_LIMITS.outputStyles,
    `输出风格超过 ${AGENT_PACKAGE_LIMITS.outputStyles} 个，请减少后重试`,
  );
  const styles = styleBodies.map((style) => ({
    ...style,
    isSelected: style.slug === selectedStyle,
  }));
  if (selectedStyle !== null && !styleBodies.some((style) => style.slug === selectedStyle)) {
    fail('INVALID_INPUT', `.claude/settings.json 引用的输出风格「${selectedStyle}」不存在`, {
      path: AGENT_PACKAGE_PATHS.settings,
    });
  }
  const workflowList: PackageWorkflowInput[] = [];
  for (const [path, content] of files) {
    if (!path.startsWith(AGENT_PACKAGE_PATHS.workflowsDir)) continue;
    const slug = path.slice(AGENT_PACKAGE_PATHS.workflowsDir.length).replace(/\.js$/, '');
    if (!slugSchema.safeParse(slug).success) {
      fail('INVALID_INPUT', `工作流文件名「${slug}」必须是合法 slug`, { path });
    }
    workflowList.push({ slug, ...parseWorkflowMeta(content), content });
  }
  workflowList.sort((a, b) => a.slug.localeCompare(b.slug));
  duplicateSlugs(workflowList, '工作流', AGENT_PACKAGE_PATHS.workflowsDir);
  checkLimit(
    workflowList.length,
    AGENT_PACKAGE_LIMITS.workflows,
    `工作流超过 ${AGENT_PACKAGE_LIMITS.workflows} 个，请减少后重试`,
  );
  const skillDirectories = new Map<string, Map<string, string>>();
  for (const [path, content] of files) {
    if (!path.startsWith(AGENT_PACKAGE_PATHS.skillsDir)) continue;
    const rest = path.slice(AGENT_PACKAGE_PATHS.skillsDir.length).split('/');
    const slug = rest[0] ?? '';
    const inner = rest.slice(1).join('/');
    const entries = skillDirectories.get(slug) ?? new Map<string, string>();
    entries.set(inner, content);
    skillDirectories.set(slug, entries);
  }
  const skillList: PackageSkillInput[] = [];
  for (const [slug, entries] of skillDirectories) {
    const skillMd = entries.get('SKILL.md');
    if (skillMd === undefined) {
      fail('INVALID_INPUT', `技能「${slug}」缺少 SKILL.md`, {
        path: `${AGENT_PACKAGE_PATHS.skillsDir}${slug}/SKILL.md`,
      });
    }
    const { skill } = parseSkillMd(skillMd, { slug });
    const resources = [...entries]
      .filter(([path]) => path !== 'SKILL.md')
      .map(([path, content]) => ({ path, content }))
      .sort((a, b) => a.path.localeCompare(b.path));
    skillList.push({
      ...skill,
      files: assertSkillResourcePaths(slug, resources),
    });
  }
  skillList.sort((a, b) => a.slug.localeCompare(b.slug));
  checkLimit(
    skillList.length,
    AGENT_PACKAGE_LIMITS.resources,
    `技能数量超过 ${AGENT_PACKAGE_LIMITS.resources} 个`,
  );
  const serverNames = new Set(sidecar.servers.map((server) => server.name));
  if (serverNames.size !== sidecar.servers.length) {
    fail('INVALID_INPUT', 'sidecar 中 Server 名称重复', {
      path: `${AGENT_PACKAGE_SIDECAR}/servers`,
    });
  }
  const skillSlugs = new Set(skillList.map((skill) => skill.slug));
  checkRefs(sidecar.agent.serverNames, serverNames, 'servers', `${AGENT_PACKAGE_SIDECAR}/agent`);
  checkRefs(sidecar.agent.skillSlugs, skillSlugs, 'skills', `${AGENT_PACKAGE_SIDECAR}/agent`);
  const childFiles = listMarkdown(files, AGENT_PACKAGE_PATHS.agentsDir);
  checkLimit(
    childFiles.length,
    AGENT_PACKAGE_LIMITS.subAgents,
    `子智能体超过 ${AGENT_PACKAGE_LIMITS.subAgents} 个`,
  );
  const sidecarChildren = new Map<string, PackageSubAgent>(
    sidecar.subAgents.map((child) => [child.slug, child]),
  );
  const children: PackageChildInput[] = childFiles.map((file) => {
    const parsed = parseChildAgentMd(file.content, file.path);
    if (parsed.slug !== file.slug) {
      fail('INVALID_INPUT', '子智能体文件名必须与 frontmatter 的 name 一致', { path: file.path });
    }
    checkRefs(parsed.skills, skillSlugs, 'skills', file.path);
    checkRefs(parsed.mcpServers, serverNames, 'servers', file.path);
    const meta = sidecarChildren.get(parsed.slug);
    duplicateSlugs(meta?.rules ?? [], '子定义规则', `${AGENT_PACKAGE_SIDECAR}/subAgents`);
    duplicateSlugs(
      meta?.outputStyles ?? [],
      '子定义输出风格',
      `${AGENT_PACKAGE_SIDECAR}/subAgents`,
    );
    if ((meta?.outputStyles ?? []).filter((style) => style.isSelected).length > 1) {
      fail('INVALID_INPUT', '子定义最多只能选中一个输出风格', {
        path: `${AGENT_PACKAGE_SIDECAR}/subAgents`,
      });
    }
    return {
      input: {
        slug: parsed.slug,
        name: parsed.name,
        role: '通用助手',
        description: parsed.description,
        model: parsed.model,
        systemPrompt: parsed.systemPrompt,
        allowedTools: checkAllowedTools(
          meta?.allowedTools ?? [],
          `${AGENT_PACKAGE_SIDECAR}/subAgents`,
        ),
        disallowedTools: parsed.disallowedTools,
        pluginBindings: [],
        permissionMode: meta?.permissionMode ?? 'default',
        uiFormat: 'markdown',
        maxTurns: parsed.maxTurns,
        maxBudgetUsd: meta?.maxBudgetUsd ?? 2,
        timeoutMs: meta?.timeoutMs ?? 600000,
        ...(parsed.effort === undefined ? {} : { effort: parsed.effort }),
        enabled: meta?.enabled ?? true,
      },
      serverNames: parsed.mcpServers,
      skillSlugs: parsed.skills,
      rules: meta?.rules ?? [],
      outputStyles: meta?.outputStyles ?? [],
    };
  });
  duplicateSlugs(
    children.map((child) => ({ slug: child.input.slug })),
    '子智能体',
    AGENT_PACKAGE_PATHS.agentsDir,
  );
  for (const child of sidecar.subAgents) {
    if (!childFiles.some((file) => file.slug === child.slug)) {
      fail('INVALID_INPUT', `sidecar 引用的子智能体「${child.slug}」缺少子定义文件`, {
        path: `${AGENT_PACKAGE_PATHS.agentsDir}${child.slug}.md`,
      });
    }
  }
  return {
    agent: {
      input: rootInput,
      serverNames: sidecar.agent.serverNames,
      skillSlugs: sidecar.agent.skillSlugs,
    },
    servers: sidecar.servers,
    children,
    skills: skillList,
    workflows: workflowList,
    rules,
    styles,
    hooks: { config: portableSettings.hooks, files: hookFiles },
    ...(sidecar.agent.runtimeEnvironmentName === undefined
      ? {}
      : { runtimeEnvironmentName: sidecar.agent.runtimeEnvironmentName }),
  };
}
function readPortableSettings(settings: string | undefined): {
  outputStyle: string | null;
  hooks: Record<string, unknown> | null;
} {
  if (settings === undefined) return { outputStyle: null, hooks: null };
  let raw: unknown;
  try {
    raw = JSON.parse(settings);
  } catch {
    fail('INVALID_INPUT', '.claude/settings.json 不是合法 JSON', {
      path: AGENT_PACKAGE_PATHS.settings,
    });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('INVALID_INPUT', '.claude/settings.json 顶层必须是对象', {
      path: AGENT_PACKAGE_PATHS.settings,
    });
  }
  const keys = Object.keys(raw);
  const unsupported = keys.filter(
    (key) => key !== 'outputStyle' && key !== 'env' && key !== 'hooks',
  );
  if (unsupported.length > 0) {
    fail('INVALID_INPUT', '.claude/settings.json 含平台不支持的配置项', {
      path: AGENT_PACKAGE_PATHS.settings,
    });
  }
  const record = raw as Record<string, unknown>;
  const outputStyle = record.outputStyle;
  if (outputStyle !== undefined && typeof outputStyle !== 'string') {
    fail('INVALID_INPUT', '.claude/settings.json 的 outputStyle 必须是字符串', {
      path: `${AGENT_PACKAGE_PATHS.settings}/outputStyle`,
    });
  }
  const parsedHooks = agentHooksConfigSchema.safeParse(record.hooks);
  if (!parsedHooks.success) {
    fail('INVALID_INPUT', '.claude/settings.json 的 hooks 配置无效或超过大小上限', {
      path: `${AGENT_PACKAGE_PATHS.settings}/hooks`,
    });
  }
  return {
    outputStyle: typeof outputStyle === 'string' ? outputStyle : null,
    hooks: parsedHooks.data,
  };
}
function serverConfig(input: ServerInput): Record<string, unknown> {
  switch (input.kind) {
    case 'stdio':
      return { command: input.command, args: input.args };
    case 'http':
      return { url: input.url };
    case 'generated':
      return { baseUrl: input.baseUrl, mcpToken: randomBytes(32).toString('base64url') };
  }
}
function nonSecretConfig(input: ServerInput): Record<string, unknown> {
  const { mcpToken: _mcpToken, ...config } = serverConfig(input);
  return config;
}
function configDiffers(input: ServerInput, existing: Record<string, unknown>): boolean {
  return Object.entries(nonSecretConfig(input)).some(
    ([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value),
  );
}
function metadataKey(metadata: Record<string, unknown> | undefined): string {
  if (metadata === undefined || Object.keys(metadata).length === 0) return '';
  return JSON.stringify(metadata, (_key, value: unknown) =>
    value === null || typeof value !== 'object' || Array.isArray(value)
      ? value
      : Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}
function toServerInput(entry: PackageServer): ServerInput {
  const base = { name: entry.name, description: entry.description };
  switch (entry.kind) {
    case 'stdio':
      return { ...base, kind: 'stdio', command: entry.command, args: entry.args, env: {} };
    case 'http':
      return { ...base, kind: 'http', url: entry.url, headers: {} };
    case 'generated':
      return { ...base, kind: 'generated', baseUrl: entry.baseUrl, headers: {} };
  }
}
function toAgentValues(
  input: Omit<AgentInput, 'serverIds' | 'skillIds' | 'subAgentIds' | 'runtimeEnvironmentId'>,
  runtimeEnvironmentId: string | null = null,
) {
  return toAgentConfigValues({ ...input, runtimeEnvironmentId });
}
async function uniqueSlug(tx: Transaction, base: string): Promise<string> {
  const taken = async (candidate: string): Promise<boolean> => {
    const rows = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.slug, candidate))
      .limit(1);
    return rows.length > 0;
  };
  if (!(await taken(base))) return base;
  const prefix = base.slice(0, 60);
  let n = 2;
  while (await taken(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}
async function insertAgentFiles(
  tx: Transaction,
  agentId: string,
  rules: PackageRuleInput[],
  styles: PackageStyleInput[],
  workflows: PackageWorkflowInput[],
): Promise<void> {
  if (rules.length > 0) {
    await tx
      .insert(agentRules)
      .values(rules.map((rule) => ({ id: newId('rule'), agentId, ...rule })));
  }
  if (styles.length > 0) {
    await tx
      .insert(agentOutputStyles)
      .values(styles.map((style) => ({ id: newId('outputStyle'), agentId, ...style })));
  }
  if (workflows.length > 0) {
    await tx
      .insert(agentWorkflows)
      .values(workflows.map((workflow) => ({ id: newId('agentWorkflow'), agentId, ...workflow })));
  }
}
async function resolveRuntimeEnvironmentId(
  db: Database,
  explicitId: string | undefined,
  packageName: string | undefined,
): Promise<string | null> {
  const environment =
    explicitId !== undefined
      ? await repo.runtimeEnvironments.getRuntimeEnvironment(db, explicitId)
      : packageName === undefined
        ? null
        : await repo.runtimeEnvironments.getRuntimeEnvironmentByName(db, packageName);
  if (explicitId === undefined && packageName === undefined) return null;
  if (environment === null) {
    fail(
      'INVALID_REFERENCE',
      explicitId !== undefined
        ? '导入时选择的运行环境不存在，请刷新后重新选择'
        : `导入包绑定的运行环境「${packageName}」在本机不存在；请先创建同名环境，或选择目标环境后重试`,
    );
  }
  if (
    (await repo.runtimeEnvironments.resolveOnlineRuntimeEnvironment(db, environment.id)) === null
  ) {
    fail(
      'INVALID_REFERENCE',
      `运行环境「${environment.name}」还没有可用的线上版本；请先完成构建并发布后再导入`,
    );
  }
  return environment.id;
}
export async function importAgentPackage(
  db: Database,
  parsed: ParsedPackage,
  options: {
    nodeEnv: string;
    selfUrl: string;
    businessId: string;
    privateHostAllowlist?: string | undefined;
    runtimeEnvironmentId?: string | undefined;
  },
): Promise<
  AgentPackageImportResult & {
    counts: ImportCounts;
  }
> {
  const runtimeEnvironmentId = await resolveRuntimeEnvironmentId(
    db,
    options.runtimeEnvironmentId,
    parsed.runtimeEnvironmentName,
  );
  const serverEntries = parsed.servers.map((entry) => ({
    input: toServerInput(entry),
    tools: entry.kind === 'generated' ? entry.tools : undefined,
    secretKeys: entry.secretKeys,
    knowledge: entry.kind === 'http' && entry.secretKeys.includes(knowledgeTokenEnv(entry.name)),
  }));
  const knownKnowledge = new Map<string, string>();
  const knowledgeNames = serverEntries.filter((entry) => entry.knowledge).map((e) => e.input.name);
  if (knowledgeNames.length > 0) {
    const rows = await db
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .where(and(inArray(servers.name, knowledgeNames), eq(servers.kind, 'knowledge')));
    for (const row of rows) {
      knownKnowledge.set(row.name, `${options.selfUrl.replace(/\/$/, '')}/mcp/${row.id}`);
    }
  }
  for (const { input, knowledge } of serverEntries) {
    if (knowledge && input.kind === 'http' && knownKnowledge.get(input.name) === input.url)
      continue;
    if (input.kind === 'http') await assertSafeUrl(input.url, options.nodeEnv);
    else if (input.kind === 'generated')
      await assertServerEndpoint(input.baseUrl, {
        nodeEnv: options.nodeEnv,
        allowlist: options.privateHostAllowlist ?? '',
      });
  }
  const warnings: string[] = [];
  const created = await db
    .transaction(async (tx) => {
      const createdServers: string[] = [];
      const reusedServers: string[] = [];
      const createdSkills: string[] = [];
      const existingServers =
        serverEntries.length === 0
          ? []
          : await tx
              .select()
              .from(servers)
              .where(
                inArray(
                  servers.name,
                  serverEntries.map((entry) => entry.input.name),
                ),
              );
      const existingByName = new Map(existingServers.map((row) => [row.name, row]));
      const serverIdsByName = new Map(existingServers.map((row) => [row.name, row.id]));
      for (const { input, tools, secretKeys, knowledge } of serverEntries) {
        const existing = existingByName.get(input.name);
        if (existing !== undefined) {
          if (existing.kind === 'knowledge' && input.kind === 'http') {
            reusedServers.push(input.name);
            warnings.push(
              `「${input.name}」是知识库连接，已复用对应的知识库；凭据由运行时注入，不需要重新填写`,
            );
            continue;
          }
          if (existing.kind !== input.kind) {
            fail(
              'INVALID_INPUT',
              `已存在同名 Server「${input.name}」，但类型不同（${existing.kind} / ${input.kind}），无法复用；请先在包内改名`,
            );
          }
          reusedServers.push(input.name);
          if (configDiffers(input, existing.config)) {
            warnings.push(`已存在同名 Server「${input.name}」，其配置与导入包不同，已保留原配置`);
          }
          if (tools !== undefined && tools.length > 0) {
            warnings.push(
              `已存在同名 Server「${input.name}」，其 ${tools.length} 个工具保留原配置，未按导入包覆盖`,
            );
          }
          continue;
        }
        const [row] = await tx
          .insert(servers)
          .values({
            id: newId('server'),
            name: input.name,
            kind: input.kind,
            description: input.description,
            config: serverConfig(input),
            secretsEncrypted: null,
          })
          .returning();
        if (!row) throw new Error('server insert returned no row');
        if (secretKeys.length > 0) {
          warnings.push(
            knowledge
              ? `「${input.name}」是知识库连接：请在本实例的专家配置里绑定对应知识库，导出的地址与凭据不会生效`
              : `「${input.name}」的密钥需要重新填写：${secretKeys.join(', ')}`,
          );
        }
        serverIdsByName.set(row.name, row.id);
        createdServers.push(row.name);
        if (tools && tools.length > 0) {
          await tx
            .insert(apiTools)
            .values(tools.map((tool) => ({ id: newId('tool'), serverId: row.id, ...tool })));
        }
      }
      const existingSkills =
        parsed.skills.length === 0
          ? []
          : await tx
              .select()
              .from(skills)
              .where(
                inArray(
                  skills.slug,
                  parsed.skills.map((skill) => skill.slug),
                ),
              );
      const existingSkillBySlug = new Map(existingSkills.map((row) => [row.slug, row]));
      const skillIdsBySlug = new Map(existingSkills.map((row) => [row.slug, row.id]));
      const existingFiles =
        existingSkills.length === 0
          ? []
          : await tx
              .select()
              .from(skillFiles)
              .where(
                inArray(
                  skillFiles.skillId,
                  existingSkills.map((skill) => skill.id),
                ),
              );
      const existingFilesBySkillId = new Map<string, typeof existingFiles>();
      for (const file of existingFiles) {
        const files = existingFilesBySkillId.get(file.skillId) ?? [];
        files.push(file);
        existingFilesBySkillId.set(file.skillId, files);
      }
      for (const skillInput of parsed.skills) {
        const existing = existingSkillBySlug.get(skillInput.slug);
        if (existing) {
          if (
            existing.name !== skillInput.name ||
            existing.description !== skillInput.description ||
            existing.body !== skillInput.body
          ) {
            warnings.push(`已存在同名技能「${skillInput.slug}」，其内容与导入包不同，已保留原配置`);
          }
          if (
            (existing.license ?? null) !== (skillInput.license ?? null) ||
            (existing.compatibility ?? null) !== (skillInput.compatibility ?? null) ||
            metadataKey(existing.metadata) !== metadataKey(skillInput.metadata)
          ) {
            warnings.push(
              `已存在同名技能「${skillInput.slug}」，其来源信息与导入包不同，已保留原配置`,
            );
          }
          const files = existingFilesBySkillId.get(existing.id) ?? [];
          const contents = new Map(files.map((file) => [file.path, file.content]));
          if (
            files.length !== skillInput.files.length ||
            skillInput.files.some((file) => contents.get(file.path) !== file.content)
          ) {
            warnings.push(
              `已存在同名技能「${skillInput.slug}」，其资源文件与导入包不同，已保留原文件`,
            );
          }
          continue;
        }
        const { files, ...skillValues } = skillInput;
        const [row] = await tx
          .insert(skills)
          .values({ id: newId('skill'), ...skillValues })
          .returning();
        if (!row) throw new Error('skill insert returned no row');
        if (files.length > 0) {
          await tx
            .insert(skillFiles)
            .values(files.map((file) => ({ id: newId('skillFile'), skillId: row.id, ...file })));
        }
        skillIdsBySlug.set(row.slug, row.id);
        createdSkills.push(row.slug);
      }
      const slug = await uniqueSlug(tx, parsed.agent.input.slug);
      if (slug !== parsed.agent.input.slug) {
        warnings.push(`slug "${parsed.agent.input.slug}" 已存在，导入为 "${slug}"`);
      }
      const resolve = (names: string[], ids: Map<string, string>): string[] =>
        names.map((name) => ids.get(name)).filter((id): id is string => id !== undefined);
      const serverIds = resolve(parsed.agent.serverNames, serverIdsByName);
      const skillIds = resolve(parsed.agent.skillSlugs, skillIdsBySlug);
      const [row] = await tx
        .insert(agents)
        .values({
          id: newId('agent'),
          slug,
          createdBy: options.businessId,
          ownerBusinessId: options.businessId,
          ...toAgentValues(parsed.agent.input, runtimeEnvironmentId),
          hooksEnabled: false,
          hooksConfig: parsed.hooks.config,
        })
        .returning();
      if (!row) throw new Error('agent insert returned no row');
      if (serverIds.length > 0) {
        await tx
          .insert(agentServers)
          .values(serverIds.map((serverId) => ({ agentId: row.id, serverId })));
      }
      if (skillIds.length > 0) {
        await tx
          .insert(agentSkills)
          .values(skillIds.map((skillId) => ({ agentId: row.id, skillId })));
      }
      await insertAgentFiles(tx, row.id, parsed.rules, parsed.styles, parsed.workflows);
      if (parsed.hooks.files.length > 0) {
        await tx.insert(agentHookFiles).values(
          parsed.hooks.files.map((file) => ({
            id: newId('agentHookFile'),
            agentId: row.id,
            ...file,
          })),
        );
      }
      const createdSubAgents: string[] = [];
      const childIds: string[] = [];
      const childSnapshots: ReturnType<typeof repo.agents.toAgent>[] = [];
      for (const child of parsed.children) {
        const childSlug = await uniqueSlug(tx, child.input.slug);
        if (childSlug !== child.input.slug) {
          warnings.push(`子智能体 slug "${child.input.slug}" 已存在，导入为 "${childSlug}"`);
        }
        const childServerIds = resolve(child.serverNames, serverIdsByName);
        const childSkillIds = resolve(child.skillSlugs, skillIdsBySlug);
        const [childRow] = await tx
          .insert(agents)
          .values({
            id: newId('agent'),
            slug: childSlug,
            parentId: row.id,
            createdBy: options.businessId,
            ownerBusinessId: options.businessId,
            ...toAgentValues(child.input),
          })
          .returning();
        if (!childRow) throw new Error('sub-agent insert returned no row');
        if (childServerIds.length > 0) {
          await tx
            .insert(agentServers)
            .values(childServerIds.map((serverId) => ({ agentId: childRow.id, serverId })));
        }
        if (childSkillIds.length > 0) {
          await tx
            .insert(agentSkills)
            .values(childSkillIds.map((skillId) => ({ agentId: childRow.id, skillId })));
        }
        await insertAgentFiles(tx, childRow.id, child.rules, child.outputStyles, []);
        childSnapshots.push(repo.agents.toAgent(childRow, childServerIds, childSkillIds));
        childIds.push(childRow.id);
        createdSubAgents.push(childRow.slug);
      }
      await repo.agentVersions.insertAgentVersion(
        tx,
        row.id,
        repo.agents.toAgent(row, serverIds, skillIds, childIds),
      );
      for (const snapshot of childSnapshots) {
        await repo.agentVersions.insertAgentVersion(tx, snapshot.id, snapshot);
      }
      return {
        agent: repo.agents.toAgent(row, serverIds, skillIds, childIds),
        createdServers,
        reusedServers,
        createdSkills,
        createdSubAgents,
        counts: {
          servers: serverEntries.length,
          skills: parsed.skills.length,
          files: parsed.skills.reduce((count, skill) => count + skill.files.length, 0),
          workflows: parsed.workflows.length,
          rules:
            parsed.rules.length +
            parsed.children.reduce((count, child) => count + child.rules.length, 0),
          outputStyles:
            parsed.styles.length +
            parsed.children.reduce((count, child) => count + child.outputStyles.length, 0),
          hookFiles: parsed.hooks.files.length,
          subAgents: createdSubAgents.length,
        },
      };
    })
    .catch((err: unknown): never => {
      if (isPgCode(err, '23505')) {
        fail('CONFLICT', '导入期间同名 Server、技能或智能体被其他请求占用，请重试');
      }
      throw err;
    });
  return { ...created, warnings };
}
export interface ImportCounts {
  servers: number;
  skills: number;
  files: number;
  workflows: number;
  rules: number;
  outputStyles: number;
  hookFiles: number;
  subAgents: number;
}
