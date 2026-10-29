import { spawn } from 'node:child_process';
import { RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT } from '@agentport/db';
import type { SpawnFn } from './build.js';

/**
 * 运行环境镜像的启动冒烟校验。build.ts 只负责构建与用户检查，这里独占
 * 「镜像声明卷」与「入口真的能启动」两件事，供构建成功前调用。
 *
 * 容器条件与 DockerSandboxProvider 保持一致：uid 1000:1000、/app、只读根、
 * 无 capability、no-new-privileges、无网络，tmpfs 只给 /tmp 与 SDK 配置目录。
 */
const VERIFY_SCRIPT = `
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

function fail(message) {
  process.stderr.write('verify: ' + message + '\\n');
  process.exit(1);
}
function tail(text) {
  // 子进程输出可能多行；压成一行，宿主才能按最后一行取到完整原因。
  const value = String(text || '').replace(/\\s+/g, ' ').trim();
  return value.length > 600 ? '…' + value.slice(-600) : value;
}
// 入口必须读到空 stdin 后按各自协议收尾；这里不调用模型，也不需要网络。
function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', input: '', timeout: 20000 });
}

if (process.getuid() !== 1000) fail('expected uid 1000, got ' + process.getuid());

const entries = ['runner', 'session-supervisor', 'probe', 'native-plugins'];
for (const name of entries) {
  const path = '/app/dist/' + name + '.js';
  if (!fs.existsSync(path)) fail('missing artifact: ' + path);
  const checked = run(process.execPath, ['--check', path]);
  if (checked.status !== 0) fail('syntax error in ' + path + ': ' + tail(checked.stderr));
}

let writable = false;
try {
  fs.writeFileSync('/app/.runtime-env-check', '');
  writable = true;
} catch {}
if (writable) fail('/app is writable');

const bash = run('sh', ['-c', 'command -v bash']);
if (bash.status !== 0 || bash.stdout.trim() === '') {
  const reason = tail(bash.stderr);
  fail('bash is not available on PATH' + (reason === '' ? '' : ': ' + reason));
}

const supervisor = run(process.execPath, ['/app/dist/session-supervisor.js']);
if (supervisor.status !== 0) {
  fail('session-supervisor exited ' + supervisor.status + ': ' + tail(supervisor.stderr));
}
if (supervisor.stdout.indexOf('"type":"ready"') === -1) {
  fail('session-supervisor did not emit ready: ' + tail(supervisor.stdout + supervisor.stderr));
}

const probe = run(process.execPath, ['/app/dist/probe.js']);
if (
  probe.status !== 0 ||
  probe.stdout.indexOf('"ok":false') === -1 ||
  probe.stdout.indexOf('stdin closed before the probe task arrived') === -1
) {
  fail('probe entry failed before reaching its protocol: ' + tail(probe.stdout + probe.stderr));
}

const native = run(process.execPath, ['/app/dist/native-plugins.js']);
if (
  native.status !== 0 ||
  native.stdout.indexOf('"ok":false') === -1 ||
  native.stdout.indexOf('stdin closed before the native plugin task arrived') === -1
) {
  fail('native-plugins entry failed before reaching its protocol: ' + tail(native.stdout + native.stderr));
}

// runner 的 SDK 依赖在静态 import 阶段加载；空 stdin 能走到任务解析就证明依赖完整。
const runner = run(process.execPath, ['/app/dist/runner.js']);
const runnerOutput = runner.stdout + runner.stderr;
if (runnerOutput.indexOf('stdin closed before task JSON arrived') === -1) {
  fail('runner failed to load: ' + tail(runnerOutput));
}

const base = require('node:module').createRequire('/app/package.json');
const sdk = require('node:module').createRequire(base.resolve('@anthropic-ai/claude-agent-sdk'));
const cli = sdk.resolve('@anthropic-ai/claude-agent-sdk-linux-' + process.arch + '-musl/claude');
if (!(fs.statSync(cli).mode & 0o111)) fail('SDK native CLI is not executable: ' + cli);
const cliVersion = spawnSync(cli, ['--version'], {
  encoding: 'utf8',
  input: '',
  timeout: 20000,
  env: Object.assign({}, process.env, { HOME: '/tmp' }),
});
if (cliVersion.status !== 0 || cliVersion.stdout.trim() === '') {
  fail('SDK native CLI --version failed: ' + tail(cliVersion.stdout + cliVersion.stderr));
}

process.stdout.write('verify: ok\\n');
`;

export interface RuntimeEnvironmentImageVerifyInput {
  imageId: string;
  spawn?: SpawnFn | undefined;
  signal?: AbortSignal | undefined;
  onOutput?: (chunk: string) => void;
}

export type RuntimeEnvironmentImageVerifyResult =
  | { ok: true }
  | { ok: false; aborted: boolean; error: string };

interface CommandResult {
  code: number | null;
  aborted: boolean;
  stdout: string;
  stderr: string;
}

/** 错误摘要只保留单行尾部，超长输出不进 DB / 界面。 */
const ERROR_DETAIL_LIMIT = 1_000;

function keepTail(text: string): string {
  return text.length > RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT
    ? text.slice(text.length - RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT)
    : text;
}

function runDocker(
  spawnFn: SpawnFn,
  args: string[],
  signal: AbortSignal | undefined,
  onOutput: ((chunk: string) => void) | undefined,
): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    let stdout = '';
    let stderr = '';
    let aborted = false;
    const child = spawnFn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      // 只留尾部，超长输出不会在 worker 进程里无限累计。
      stdout = keepTail(stdout + chunk);
      onOutput?.(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = keepTail(stderr + chunk);
      onOutput?.(chunk);
    });
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (): void => signal?.removeEventListener('abort', onAbort);
    child.once('error', (err) => {
      finish();
      reject(err);
    });
    child.once('close', (code) => {
      finish();
      resolveCommand({ code, aborted, stdout, stderr });
    });
    if (signal?.aborted) onAbort();
  });
}

function lastLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((value) => value.trim())
      .filter((value) => value !== '')
      .at(-1) ?? '';
  return line.length > ERROR_DETAIL_LIMIT ? `…${line.slice(-ERROR_DETAIL_LIMIT)}` : line;
}

function detail(stderr: string): string {
  const line = lastLine(stderr);
  return line === '' ? '' : `: ${line}`;
}

/**
 * 拒绝镜像声明的任何容器卷：`VOLUME /app/dist` 会让只读根文件系统下的 /app/dist
 * 变成可写匿名卷，绕过「/app 不可写」的隔离前提。平台的可写目录由 provider 挂载。
 */
async function verifyNoVolumes(
  spawnFn: SpawnFn,
  imageId: string,
  signal: AbortSignal | undefined,
  onOutput: ((chunk: string) => void) | undefined,
): Promise<RuntimeEnvironmentImageVerifyResult | null> {
  const inspected = await runDocker(
    spawnFn,
    ['image', 'inspect', imageId, '--format', '{{json .Config.Volumes}}'],
    signal,
    onOutput,
  );
  if (inspected.aborted) return { ok: false, aborted: true, error: '校验已中断' };
  if (inspected.code !== 0) {
    return {
      ok: false,
      aborted: false,
      error: `无法检查镜像卷声明${detail(inspected.stderr)}`,
    };
  }
  // 没有声明卷时 Docker 输出 null；任何 JSON 对象都代表至少一个卷。
  const volumes = inspected.stdout.trim();
  if (volumes !== '' && volumes !== 'null' && volumes !== '{}') {
    return {
      ok: false,
      aborted: false,
      error: `镜像声明了容器卷 ${volumes}；可写挂载必须由平台提供，镜像不能自带卷`,
    };
  }
  return null;
}

export async function verifyRuntimeEnvironmentImage(
  input: RuntimeEnvironmentImageVerifyInput,
): Promise<RuntimeEnvironmentImageVerifyResult> {
  const spawnFn = input.spawn ?? spawn;
  const { signal } = input;
  if (signal?.aborted) return { ok: false, aborted: true, error: '校验已中断' };

  try {
    const volumeFailure = await verifyNoVolumes(spawnFn, input.imageId, signal, input.onOutput);
    if (volumeFailure !== null) return volumeFailure;

    const verified = await runDocker(
      spawnFn,
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=64m',
        '--tmpfs',
        '/home/node/.claude:rw,noexec,nosuid,size=64m,uid=1000,gid=1000',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        '1000:1000',
        '--workdir',
        '/app',
        '--entrypoint',
        'node',
        input.imageId,
        '-e',
        VERIFY_SCRIPT,
      ],
      signal,
      input.onOutput,
    );
    if (verified.aborted) return { ok: false, aborted: true, error: '校验已中断' };
    if (verified.code !== 0) {
      return {
        ok: false,
        aborted: false,
        error: `产物验证失败${detail(verified.stderr) || detail(verified.stdout)}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      aborted: signal?.aborted === true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
