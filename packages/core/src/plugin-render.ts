import type { WorkspacePlugin } from './workspace.js';

export interface PluginRenderFile {
  path: string;
  content: string;
  executable: boolean;
}

const MANIFEST_PATH = '.claude-plugin/plugin.json';
const MCP_PATH = '.mcp.json';

function isHookFile(path: string): boolean {
  return path === 'hooks' || path.startsWith('hooks/');
}
function parseObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** MCP server 名可写在 manifest 内联对象里，也可写在 `.mcp.json`；两处都算。 */
function mcpServerNamesOf(
  mcpContent: string | undefined,
  manifest: Record<string, unknown> | null,
): string[] {
  const names = new Set<string>();
  if (manifest !== null && isObject(manifest.mcpServers)) {
    for (const name of Object.keys(manifest.mcpServers)) names.add(name);
  }
  if (mcpContent !== undefined) {
    const parsed = parseObject(mcpContent);
    const servers = parsed === null ? null : (parsed.mcpServers ?? parsed);
    if (isObject(servers)) {
      for (const name of Object.keys(servers)) names.add(name);
    }
  }
  return [...names];
}

/**
 * 把插件目录树裁剪成运行时形态：未授权的 hooks / MCP 从文件树和 manifest 里一并移除，
 * 否则 SDK 只按 manifest 加载，删文件不够。
 */
export function renderPlugin(params: {
  slug: string;
  runtimeName: string;
  allowHooks: boolean;
  allowMcp: boolean;
  files: PluginRenderFile[];
}): WorkspacePlugin {
  const kept = params.files.filter(
    (file) =>
      (params.allowHooks || !isHookFile(file.path)) && (params.allowMcp || file.path !== MCP_PATH),
  );

  const manifestFile = kept.find((file) => file.path === MANIFEST_PATH);
  const manifest = manifestFile === undefined ? null : parseObject(manifestFile.content);
  // SDK 以 manifest 的 name 作插件命名空间，必须与任务里传的名字一致。
  const rewrite =
    manifest !== null &&
    (manifest.name !== params.runtimeName ||
      (!params.allowHooks && manifest.hooks !== undefined) ||
      (!params.allowMcp && manifest.mcpServers !== undefined));
  if (manifest !== null) {
    if (!params.allowHooks) delete manifest.hooks;
    if (!params.allowMcp) delete manifest.mcpServers;
    manifest.name = params.runtimeName;
  }

  const files = kept.map((file) =>
    file.path === MANIFEST_PATH && rewrite && manifest !== null
      ? { ...file, content: `${JSON.stringify(manifest, null, 2)}\n` }
      : file,
  );

  const skillNames = files.flatMap((file) => {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  const mcpServerNames = params.allowMcp
    ? mcpServerNamesOf(files.find((file) => file.path === MCP_PATH)?.content, manifest)
    : [];

  return {
    slug: params.slug,
    runtimeName: params.runtimeName,
    skillNames,
    mcpServerNames,
    hasAgents: files.some((file) => /^agents\/.+\.md$/.test(file.path)),
    files,
  };
}
