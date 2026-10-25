import { fail } from '@agentport/core';
import { pluginFilePathSchema, pluginInputSchema } from '@agentport/shared';
import { z } from 'zod';

/**
 * 插件根目录的解析：只接受官方布局里能被 SDK 加载的组件，其余（LSP、workflows、
 * monitors、bin、userConfig、channels、dependencies、settings）在导入阶段明确拒绝，
 * 而不是让运行时出现「加载了但一半不可用」，或出现「管理员以为关掉却仍生效」。
 */

/** 插件根内允许出现的顶层路径；`.claude-plugin/` 是 manifest 目录。 */
const ALLOWED_TOP_LEVEL = new Set([
  '.claude-plugin',
  'skills',
  'agents',
  'commands',
  'hooks',
  // hooks 的 command 通常是 `${CLAUDE_PLUGIN_ROOT}/scripts/x.sh`，拒了等于 hooks 不可用。
  'scripts',
  'output-styles',
  '.mcp.json',
  'README.md',
]);

const UNSUPPORTED_TOP_LEVEL: Record<string, string> = {
  '.lsp.json': 'LSP server 暂不支持',
  lsp: 'LSP server 暂不支持',
  workflows: 'workflows 暂不支持',
  monitors: 'monitors 暂不支持',
  bin: 'bin/ 可执行目录暂不支持',
  themes: '主题暂不支持',
  'settings.json': '插件根 settings.json（可用 agent 接管主会话）暂不支持',
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
};

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
  skills?: unknown;
  commands?: unknown;
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
  const reason = UNSUPPORTED_TOP_LEVEL[topLevelOf(path)];
  if (reason !== undefined) fail('INVALID_INPUT', `插件包含不支持的组件：${reason}`, { path });
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
 * 把插件目录文件整理成可入库的形态：校验路径与组件白名单、解析 manifest、
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
    if (!ALLOWED_TOP_LEVEL.has(topLevelOf(file.path))) {
      fail(
        'INVALID_INPUT',
        `插件包含未知的顶层路径：${topLevelOf(file.path)}；请把插件根目录的内容打平到 ZIP 顶层`,
        { path: file.path },
      );
    }
  }

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
  // 官方语义：skills 追加默认目录，commands 替换默认目录；两者都不按默认处理。
  if (manifest.skills !== undefined)
    warnings.push('manifest 的 skills 额外目录按默认 skills/ 处理');
  if (manifest.commands !== undefined) warnings.push('manifest 的 commands 按默认 commands/ 处理');

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
