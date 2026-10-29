import { fail } from '@agentport/core';
import { pluginFilePathSchema, pluginInputSchema } from '@agentport/shared';
import { z } from 'zod';

/**
 * 插件根目录的解析：普通支持文件（LICENSE、CHANGELOG、references/、assets/ 等）
 * 原样保存；已知无法在运行时生效的组件（LSP、workflows、monitors、bin、settings 等）
 * 在导入阶段明确拒绝，而不是让运行时出现「加载了但一半不可用」，
 * 或出现「管理员以为关掉却仍生效」。
 */

/** 官方组件里平台尚未支持的顶层目录/文件；其余合法相对路径按支持文件保存。 */
const UNSUPPORTED_TOP_LEVEL: Record<string, string> = {
  '.lsp.json': 'LSP server 暂不支持',
  lsp: 'LSP server 暂不支持',
  workflows: 'workflows 暂不支持',
  monitors: 'monitors 暂不支持',
  bin: 'bin/ 可执行目录暂不支持',
  themes: '主题暂不支持',
  'settings.json': '插件根 settings.json（可用 agent 接管主会话）暂不支持',
  // 插件根里的 `.claude/` 不是官方组件，settings 却可能接管会话；沿用原来的明确拒绝。
  '.claude': '插件内的 .claude/ 配置暂不支持',
};

const UNSUPPORTED_MANIFEST_KEYS: Record<string, string> = {
  userConfig: '需要交互式配置的插件暂不支持',
  channels: 'channel 插件暂不支持',
  dependencies: '插件依赖暂不支持',
  lspServers: 'LSP server 暂不支持',
  workflows: 'workflows 暂不支持',
  experimental: '实验性组件暂不支持',
  // 官方 manifest 的 settings 里 `agent` 会接管主会话，与拒绝根 settings.json 同理。
  settings: '插件的 settings 暂不支持（可用 agent 接管主会话）',
  // 自定义 skills/commands 目录需要加载器理解 manifest 里的路径，平台只按默认目录渲染。
  skills: 'manifest 自定义 skills 目录暂不支持，请使用默认 skills/',
  commands: 'manifest 自定义 commands 目录暂不支持，请使用默认 commands/',
};

/** package.json 的运行时依赖无法只靠文本快照搬运；有依赖就必须明确拒绝。 */
const RUNTIME_DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies'] as const;

const UNSUPPORTED_MCP_PLACEHOLDERS = /\$\{user_config\./;

const pluginImportFileSchema = z.object({
  path: pluginFilePathSchema,
  content: z.string().max(200_000),
  executable: z.boolean().default(false),
});

export type PluginImportFile = z.infer<typeof pluginImportFileSchema>;

export interface ParsedPlugin {
  input: z.infer<typeof pluginInputSchema>;
  warnings: string[];
}

interface ManifestShape {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  hooks?: unknown;
  mcpServers?: unknown;
}

function topLevelOf(path: string): string {
  const [first] = path.split('/');
  return first ?? path;
}

/** 空段与 `.` 会让 join 指向目录（或原目录），写入时整次运行失败；导入阶段就拒。 */
function assertCleanPath(path: string): void {
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('INVALID_INPUT', '插件路径不能包含空段、. 或 ..', { path });
  }
}

function rejectUnsupported(path: string): void {
  if (path.split('/').includes('node_modules')) {
    fail('INVALID_INPUT', '插件不能包含 node_modules；运行时依赖暂不支持', { path });
  }
  const reason = UNSUPPORTED_TOP_LEVEL[topLevelOf(path)];
  if (reason !== undefined) fail('INVALID_INPUT', `插件包含不支持的组件：${reason}`, { path });
}

/** 根 package.json 只作为支持文件保留；声明运行时依赖时无法只搬文本，明确拒绝。 */
function assertNoRuntimeDependencies(files: PluginImportFile[]): void {
  const pkg = files.find((file) => file.path === 'package.json');
  if (pkg === undefined) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(pkg.content);
  } catch {
    fail('INVALID_INPUT', 'package.json 不是合法 JSON', { path: pkg.path });
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    const value = (parsed as Record<string, unknown>)[field];
    if (typeof value === 'object' && value !== null && Object.keys(value).length > 0) {
      fail('INVALID_INPUT', `插件 package.json 声明了 ${field}，运行依赖暂不支持`, {
        path: pkg.path,
      });
    }
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function parseManifest(files: PluginImportFile[], warnings: string[]): ManifestShape {
  const manifest = files.find((file) => file.path === '.claude-plugin/plugin.json');
  if (manifest === undefined) {
    warnings.push('插件没有 .claude-plugin/plugin.json，按目录名作为插件名');
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.content);
  } catch {
    return fail('INVALID_INPUT', 'plugin.json 不是合法 JSON', { path: manifest.path });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('INVALID_INPUT', 'plugin.json 必须是 JSON 对象', { path: manifest.path });
  }
  for (const key of Object.keys(parsed)) {
    const reason = UNSUPPORTED_MANIFEST_KEYS[key];
    if (reason !== undefined) {
      fail('INVALID_INPUT', `插件声明了不支持的字段：${reason}`, { path: manifest.path });
    }
  }
  return parsed as ManifestShape;
}

/**
 * manifest 的 mcpServers 支持三种写法：内联对象、文件路径、或二者的数组。
 * 目前只支持内联对象；其余写法必须明确拒绝，否则插件「能导入但不生效」。
 */
function manifestMcpServers(manifest: ManifestShape): string[] {
  const declared = manifest.mcpServers;
  if (declared === undefined) return [];
  if (typeof declared === 'object' && declared !== null && !Array.isArray(declared)) {
    return Object.keys(declared);
  }
  return fail('INVALID_INPUT', 'manifest 的 mcpServers 只支持内联对象写法', {
    path: '.claude-plugin/plugin.json',
  });
}

function detectMcpServers(files: PluginImportFile[], manifest: ManifestShape): string[] {
  const names = new Set(manifestMcpServers(manifest));
  const mcpFile = files.find((file) => file.path === '.mcp.json');
  if (mcpFile === undefined) return [...names];
  if (UNSUPPORTED_MCP_PLACEHOLDERS.test(mcpFile.content)) {
    fail('INVALID_INPUT', '插件 MCP server 使用了 user_config 占位符，暂不支持', {
      path: mcpFile.path,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(mcpFile.content);
  } catch {
    return fail('INVALID_INPUT', '.mcp.json 不是合法 JSON', { path: mcpFile.path });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return fail('INVALID_INPUT', '.mcp.json 必须是 JSON 对象', { path: mcpFile.path });
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers ?? parsed;
  if (typeof servers === 'object' && servers !== null) {
    for (const name of Object.keys(servers)) names.add(name);
  }
  return [...names];
}

function skillNamesOf(files: PluginImportFile[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return [...names];
}

/** 官方允许 agents/ 下再分子目录，子目录名会成为 agent 名的一部分。 */
function agentNamesOf(files: PluginImportFile[]): string[] {
  return files
    .filter((file) => /^agents\/.+\.md$/.test(file.path))
    .map((file) => file.path.slice('agents/'.length, -'.md'.length));
}

/**
 * 把插件目录文件整理成可入库的形态：校验路径与不支持的组件、解析 manifest、
 * 汇总组件清单。调用方只负责落库，不执行任何插件内容。
 */
export function parsePluginFiles(params: {
  files: PluginImportFile[];
  slug: string;
  name?: string;
  runtimeName?: string;
}): ParsedPlugin {
  if (params.files.length === 0) fail('INVALID_INPUT', '插件目录为空');
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const file of params.files) {
    if (seen.has(file.path)) fail('INVALID_INPUT', '插件目录存在重复路径', { path: file.path });
    seen.add(file.path);
    assertCleanPath(file.path);
    rejectUnsupported(file.path);
  }
  // 同一路径不能既是文件又是另一个文件的祖先目录；否则渲染落盘时二者无法共存。
  for (const file of params.files) {
    const segments = file.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join('/');
      if (seen.has(ancestor)) {
        fail('INVALID_INPUT', `插件路径「${ancestor}」是文件，不能同时作为「${file.path}」的目录`, {
          path: ancestor,
        });
      }
    }
  }
  assertNoRuntimeDependencies(params.files);

  const manifest = parseManifest(params.files, warnings);
  const manifestName = typeof manifest.name === 'string' ? manifest.name : undefined;
  if (manifest.name !== undefined && manifestName === undefined) {
    fail('INVALID_INPUT', 'plugin.json 的 name 必须是字符串', {
      path: '.claude-plugin/plugin.json',
    });
  }
  const runtimeName = params.runtimeName ?? manifestName ?? params.slug;
  if (slugify(runtimeName) !== runtimeName) {
    fail('INVALID_INPUT', `插件名 "${runtimeName}" 不能作为 SDK 插件命名空间`);
  }

  const mcpServers = detectMcpServers(params.files, manifest);
  const agents = agentNamesOf(params.files);
  const hasHooks =
    params.files.some((file) => file.path === 'hooks/hooks.json') || manifest.hooks !== undefined;

  const description =
    params.name ?? (typeof manifest.description === 'string' ? manifest.description : '');

  const input = pluginInputSchema.safeParse({
    slug: params.slug,
    runtimeName,
    name: manifestName ?? params.name ?? params.slug,
    description,
    version: typeof manifest.version === 'string' ? manifest.version : '',
    capabilities: {
      skills: skillNamesOf(params.files),
      agents,
      hasHooks,
      mcpServers,
    },
    files: params.files,
  });
  if (!input.success) {
    // 非 Fastify schema 校验抛出的 ZodError 只会变成 500，这里转成可读的 400。
    const issue = input.error.issues[0];
    const path = issue?.path.join('.');
    fail('INVALID_INPUT', `插件内容不合法：${issue?.message ?? '字段校验失败'}`, {
      ...(path === undefined ? {} : { path }),
    });
  }

  return { input: input.data, warnings };
}
