import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  AGENT_PACKAGE_MAX_ENTRIES,
  AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES,
  errorText,
  type NativeInstalledPlugin,
  type NativePluginAction,
  type NativePluginOutput,
  nativeInstalledPluginSchema,
  nativePluginActionSchema,
  type PluginFileInput,
  pluginFileInputSchema,
} from '@agentport/shared';

/**
 * 容器内入口：在一次性沙盒里调用官方 Claude Code CLI 安装/枚举/读取市场插件，
 * 结果只以文本快照回传。stdout 只写一行结果 JSON，日志一律进 stderr。
 *
 * 安装与下载由官方 CLI 独占管理：缓存挂载在 /mnt/plugin-cache，CLI 配置与下载目录
 * 都独立于宿主 ~/.claude；读取以 `plugin list --json` 的 installPath 为准。
 */

const CACHE_ROOT = '/mnt/plugin-cache';
/** CLI 单次输出上限；文本快照另有 shared 的条目与字节上限。 */
const CLI_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_FILE_CHARS = 200_000;

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/** 带阶段名的失败：回传给宿主的是「哪一步失败」，不是堆栈。 */
class ActionFailure extends Error {
  constructor(
    readonly phase: string,
    message: string,
  ) {
    super(sanitize(message));
  }
}

function sanitize(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function fail(phase: string, message: string): never {
  throw new ActionFailure(phase, message);
}

/**
 * SDK 自己按 platform/arch 从可选依赖里找原生 CLI，并按 libc 选变体：沙盒镜像是
 * Alpine，必须优先 musl；glibc 二进制在 musl 上会因为缺动态加载器直接启动失败。
 * 这里复用同一套包名解析：不依赖全局 `claude`，也不从第三方目录执行脚本。
 */
export function resolveNativeCli(): string {
  const fromSdk = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'));
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const musl =
    process.platform === 'linux' &&
    (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)
      ?.header?.glibcVersionRuntime === undefined;
  const names =
    process.platform !== 'linux' ? [base] : musl ? [`${base}-musl`, base] : [base, `${base}-musl`];
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const name of names) {
    try {
      return fromSdk.resolve(`${name}/claude${exe}`);
    } catch {
      // 换下一个 libc 变体。
    }
  }
  return fail('启动', `沙盒缺少 ${process.platform}-${process.arch} 的官方 CLI 依赖`);
}

export interface NativePluginRunnerOptions {
  /** 测试注入本地 fixture CLI；生产从 SDK 可选依赖解析。 */
  cliPath?: string;
  /** 测试用临时缓存根；容器内固定 /mnt/plugin-cache。 */
  cacheRoot?: string;
}

interface CliPaths {
  cliPath: string;
  configDir: string;
  pluginCacheDir: string;
}

function paths(options: NativePluginRunnerOptions): CliPaths {
  const cacheRoot = options.cacheRoot ?? CACHE_ROOT;
  return {
    cliPath: options.cliPath ?? resolveNativeCli(),
    configDir: join(cacheRoot, 'config'),
    pluginCacheDir: join(cacheRoot, 'plugins'),
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 只给 CLI 最小环境：没有任何模型/业务凭据，HOME 与 TMPDIR 都在容器临时目录。 */
function cliEnv(configDir: string, pluginCacheDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginCacheDir,
    CLAUDE_CODE_PLUGIN_PREFER_HTTPS: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

/** stderr 只留最后一行：CLI 把原因写在里面，整段会超出错误上限。 */
function stderrTail(stderr: string): string {
  return stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? '';
}

/**
 * cwd 用独立空目录：CLI 不会把临时目录里的 marketplace 文件当成项目插件加载。
 * argv 直传、不经 shell；不传 -y，市场声明的命令必须由人确认。
 */
async function runCli(
  cliPath: string,
  configDir: string,
  pluginCacheDir: string,
  args: string[],
): Promise<CliResult> {
  const cwd = await mkdtemp(join(tmpdir(), 'native-plugin-run-'));
  try {
    return await execFileAsync(cliPath, args, {
      cwd,
      env: cliEnv(configDir, pluginCacheDir),
      encoding: 'utf8',
      maxBuffer: CLI_MAX_BUFFER,
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (err: unknown) => {
        const shape = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
        if (typeof shape.stdout !== 'string' || typeof shape.stderr !== 'string') {
          fail('执行 CLI', errorText(err));
        }
        return {
          code: typeof shape.code === 'number' ? shape.code : 1,
          stdout: shape.stdout,
          stderr: shape.stderr,
        };
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** 官方目录里的一行 `plugin list --json`；installPath 只在本沙盒内使用。 */
interface ListedPlugin extends NativeInstalledPlugin {
  installPath: string;
}

function parseList(stdout: string): ListedPlugin[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return fail('列表', 'CLI 返回的插件目录不是合法 JSON');
  }
  if (!Array.isArray(raw)) return fail('列表', 'CLI 插件目录格式无效');
  return raw.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return fail('列表', '插件条目格式无效');
    const { id, version, installPath } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || typeof installPath !== 'string') {
      return fail('列表', '插件条目缺少 id 或 installPath');
    }
    const parsed = nativeInstalledPluginSchema.safeParse({
      pluginId: id,
      version: typeof version === 'string' ? version : '',
    });
    if (!parsed.success) return fail('列表', `插件标识无效：${id}`);
    return { ...parsed.data, installPath };
  });
}

async function listRaw(cliPath: string, configDir: string, pluginCacheDir: string) {
  const result = await runCli(cliPath, configDir, pluginCacheDir, ['plugin', 'list', '--json']);
  if (result.code !== 0) {
    fail('列表', `CLI 退出码 ${result.code}：${stderrTail(result.stderr) || '没有更多信息'}`);
  }
  return parseList(result.stdout);
}

/** install 的 stdout 只有最后一行是结果；严格解析，不猜其他行。 */
function parseInstallLine(stdout: string, code: number): string {
  const line = stdout
    .trim()
    .split('\n')
    .filter((value) => value.trim().length > 0)
    .at(-1);
  let raw: unknown;
  try {
    raw = line === undefined ? null : JSON.parse(line);
  } catch {
    return fail('安装', 'CLI 安装结果不是合法 JSON');
  }
  if (typeof raw !== 'object' || raw === null) return fail('安装', 'CLI 安装结果格式无效');
  const { outcome, pluginId, message, failureCode, shownCommand } = raw as Record<string, unknown>;
  if (outcome !== 'ok' || code !== 0) {
    const detail = typeof message === 'string' && message.length > 0 ? message : 'CLI 未说明原因';
    const reason = typeof failureCode === 'string' ? `（${failureCode}）` : '';
    const command =
      shownCommand === undefined ? '' : '；市场要求执行的命令需要人工确认，未自动执行';
    return fail('安装', `${detail}${reason}${command}`);
  }
  if (typeof pluginId !== 'string') return fail('安装', 'CLI 安装结果缺少 pluginId');
  return pluginId;
}

/** 插件目录必须真实位于缓存根内：既挡符号链接，也挡 CLI 返回的任意宿主路径。 */
async function resolveInsideCache(pluginCacheDir: string, installPath: string): Promise<string> {
  let root: string;
  try {
    root = await realpath(pluginCacheDir);
  } catch {
    return fail('读取', '插件缓存目录不存在');
  }
  let target: string;
  try {
    target = await realpath(installPath);
  } catch {
    return fail('读取', '插件目录不存在或无法访问');
  }
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    return fail('读取', '插件目录不在平台缓存内');
  }
  if (!(await lstat(target)).isDirectory()) return fail('读取', '插件 installPath 不是目录');
  return target;
}

/** 官方缓存里的内部标记可以忽略；其余文件一个都不丢。 */
function isInternalMarker(name: string): boolean {
  return name === '.git' || name === '.orphaned_at';
}

function decodeText(buffer: Buffer, path: string): string {
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (content.includes('\0')) return fail('读取', `插件文件是二进制：${path}`);
    return content;
  } catch (err) {
    if (err instanceof ActionFailure) throw err;
    return fail('读取', `插件文件不是有效 UTF-8 文本：${path}`);
  }
}

/**
 * 递归读取插件目录并保留可执行位。符号链接、特殊文件、node_modules、二进制
 * 都明确失败：静默跳过会让用户以为插件是完整的。
 */
async function snapshotPlugin(
  pluginCacheDir: string,
  installPath: string,
): Promise<PluginFileInput[]> {
  const root = await resolveInsideCache(pluginCacheDir, installPath);
  const files: PluginFileInput[] = [];
  let totalBytes = 0;

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (isInternalMarker(entry.name)) continue;
      const abs = join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const info = await lstat(abs);
      if (info.isSymbolicLink()) return fail('读取', `插件包含符号链接：${rel}`);
      if (entry.name === 'node_modules') {
        return fail('读取', `插件包含 node_modules，文本快照不支持：${rel}`);
      }
      if (info.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!info.isFile()) return fail('读取', `插件包含非普通文件：${rel}`);
      if (files.length >= AGENT_PACKAGE_MAX_ENTRIES) {
        return fail('读取', `插件文件数超过 ${AGENT_PACKAGE_MAX_ENTRIES} 个`);
      }
      const buffer = await readFile(abs);
      totalBytes += buffer.byteLength;
      if (totalBytes > AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES) {
        return fail('读取', `插件文件总大小超过 ${AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES} 字节`);
      }
      const content = decodeText(buffer, rel);
      if (content.length > MAX_FILE_CHARS) {
        return fail('读取', `插件文件超过 ${MAX_FILE_CHARS} 字符：${rel}`);
      }
      const file = pluginFileInputSchema.safeParse({
        path: rel,
        content,
        executable: (info.mode & 0o111) !== 0,
      });
      if (!file.success) return fail('读取', `插件路径或内容不合法：${rel}`);
      files.push(file.data);
    }
  }

  await walk(root, '');
  return files;
}

async function snapshotOf(paths: CliPaths, entry: ListedPlugin): Promise<NativePluginOutput> {
  const files = await snapshotPlugin(paths.pluginCacheDir, entry.installPath);
  return { ok: true, plugin: { pluginId: entry.pluginId, version: entry.version }, files };
}

export async function listNativePlugins(
  options: NativePluginRunnerOptions = {},
): Promise<NativePluginOutput> {
  return guard(async () => {
    const resolved = paths(options);
    const entries = await listRaw(resolved.cliPath, resolved.configDir, resolved.pluginCacheDir);
    const installed = [...new Map(entries.map((entry) => [entry.pluginId, entry])).values()].map(
      ({ pluginId, version }) => ({ pluginId, version }),
    );
    return { ok: true, installed };
  });
}

export async function readPlugin(
  pluginId: string,
  options: NativePluginRunnerOptions = {},
): Promise<NativePluginOutput> {
  return guard(async () => {
    const resolved = paths(options);
    const entries = await listRaw(resolved.cliPath, resolved.configDir, resolved.pluginCacheDir);
    const entry = entries.find((candidate) => candidate.pluginId === pluginId);
    if (entry === undefined) return fail('读取', `插件未安装：${pluginId}`);
    return snapshotOf(resolved, entry);
  });
}

/**
 * 安装 = 官方 CLI 安装，再列目录拿规范 pluginId 与 installPath。
 * 已安装时 CLI 只回报 already installed，不会重新下载；市场名只由 CLI 解析，
 * 避免同名插件跨市场误复用。
 */
export async function installPlugin(
  input: { marketplace: string; plugin: string },
  options: NativePluginRunnerOptions = {},
): Promise<NativePluginOutput> {
  return guard(async () => {
    const resolved = paths(options);
    const result = await runCli(resolved.cliPath, resolved.configDir, resolved.pluginCacheDir, [
      'plugin',
      'install',
      input.plugin,
      '--marketplace',
      input.marketplace,
      '--scope',
      'user',
      '--json',
    ]);
    const pluginId = parseInstallLine(result.stdout, result.code);
    const entry = (
      await listRaw(resolved.cliPath, resolved.configDir, resolved.pluginCacheDir)
    ).find((candidate) => candidate.pluginId === pluginId);
    if (entry === undefined) return fail('安装', `安装后未在目录中找到插件：${pluginId}`);
    return snapshotOf(resolved, entry);
  });
}

/** 所有动作统一把带阶段的失败折成结果行；宿主不需要区分异常与控制流。 */
async function guard(run: () => Promise<NativePluginOutput>): Promise<NativePluginOutput> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ActionFailure) {
      return { ok: false, error: `${err.phase}失败：${err.message}` };
    }
    return { ok: false, error: `执行失败：${sanitize(errorText(err))}` };
  }
}

export async function runNativePluginAction(
  action: NativePluginAction,
  options: NativePluginRunnerOptions = {},
): Promise<NativePluginOutput> {
  switch (action.action) {
    case 'list':
      return listNativePlugins(options);
    case 'install':
      return installPlugin({ marketplace: action.marketplace, plugin: action.plugin }, options);
    case 'read':
      return readPlugin(action.pluginId, options);
  }
}

/** 只取第一行，不读 EOF：宿主写完任务后保持 stdin 打开。 */
async function readTask(): Promise<unknown> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      return JSON.parse(trimmed);
    }
  } finally {
    rl.close();
  }
  throw new Error('stdin closed before the native plugin task arrived');
}

async function main(): Promise<void> {
  let output: NativePluginOutput;
  try {
    const parsed = nativePluginActionSchema.safeParse(await readTask());
    if (!parsed.success) throw new Error('原生插件任务格式无效');
    output = await runNativePluginAction(parsed.data);
  } catch (err) {
    output = { ok: false, error: `任务失败：${sanitize(errorText(err))}` };
  }
  // 父进程只看 stdout；进程退出码不携带原因。
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
