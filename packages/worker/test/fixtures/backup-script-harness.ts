import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// 这些用例只用临时目录 + stub 的 pg_dump/pg_restore/bun，不触真实数据库或工作区卷。
// 唯一例外是配置损坏的哨兵用例：它只在本轮隔离随机库里读写一张自建表，不碰开发库。
const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SCRIPTS = join(ROOT, 'scripts');

interface Env {
  dir: string;
  bin: string;
  workspaces: string;
  knowledge: string;
  backupDir: string;
  envFile: string;
  log: string;
}

const tools = [
  'bash',
  'sh',
  'tar',
  'gzip',
  'node',
  'shasum',
  'sha256sum',
  'find',
  'sort',
  'uniq',
  'sed',
  'wc',
  'mktemp',
  'head',
  'tail',
  'grep',
  'cut',
  'tr',
  'ls',
  'mv',
  'cp',
  'rm',
  'mkdir',
  'chmod',
  'install',
  'cat',
  'dirname',
  'basename',
  'date',
];

export function createBackupScriptSuite() {
  let env: Env;

  /** 只放行真实系统工具的白名单 PATH：compose/docker 看不到，脚本走宿主分支。 */
  async function makeEnv(): Promise<Env> {
    const dir = await mkdtemp(join(tmpdir(), 'backup-script-'));
    const bin = join(dir, 'bin');
    const workspaces = join(dir, 'workspaces');
    const knowledge = join(dir, 'knowledge');
    const backupDir = join(dir, 'backups');
    await mkdir(bin);
    await mkdir(join(workspaces, 'demo-agent', 'agent-memory'), { recursive: true });
    await mkdir(join(workspaces, 'demo-agent', 'run_01abc'), { recursive: true });
    await mkdir(join(workspaces, 'demo-agent', 'sessions'), { recursive: true });
    // 试连只用一个空目录当挂载点，不是持久数据。
    await mkdir(join(workspaces, 'sandbox-probes'), { recursive: true });
    await writeFile(join(workspaces, 'demo-agent', 'agent-memory', 'MEMORY.md'), '# memory\n');
    await writeFile(join(workspaces, 'demo-agent', 'run_01abc', 'workspace.txt'), 'derived\n');
    await writeFile(join(workspaces, 'demo-agent', 'sessions', 'transcript.jsonl'), '{"x":1}\n');
    const envFile = join(dir, '.env');
    await writeFile(
      envFile,
      [
        'APP_SECRET_KEY=super-secret-value',
        'DATABASE_URL=postgres://u:secret@db:5432/app',
        '',
      ].join('\n'),
      { mode: 0o644 },
    );
    for (const tool of tools) {
      const path = (
        await run('sh', ['-c', `command -v ${tool}`]).catch(() => ({ stdout: '' }))
      ).stdout.trim();
      if (path) await symlink(path, join(bin, tool));
    }
    return { dir, bin, workspaces, knowledge, backupDir, envFile, log: join(dir, 'calls.log') };
  }

  async function stub(name: string, body: string) {
    const path = join(env.bin, name);
    await writeFile(
      path,
      ['#!/bin/bash', `printf '%s\\n' "${name} $*" >>"${env.log}"`, body, ''].join('\n'),
      { mode: 0o755 },
    );
  }

  async function addPassThrough(name: string) {
    const path = (await run('sh', ['-c', `command -v ${name}`])).stdout.trim();
    const link = join(env.bin, name);
    const existing = await stat(link).catch(() => null);
    if (!existing) await symlink(path, link);
  }

  /**
   * docker/compose 替身：把容器内 /knowledge、/workspaces 与 -v 的 /in 映射到临时目录，
   * 模拟卷在宿主不可见时由容器 tar/sh 进出数据。STUB_DOCKER_FAIL=1 让知识卷读写失败。
   */
  async function stubDocker() {
    const code = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const log = (line) => fs.appendFileSync(process.env.STUB_LOG, line + '\\n');
const args = process.argv.slice(2);
log('docker ' + args.join(' '));
const kn = process.env.STUB_KN_DIR || '';
const ws = process.env.STUB_WS_DIR || '';
const fail = process.env.STUB_DOCKER_FAIL === '1';
const mapPath = (p) =>
  p.startsWith('/knowledge') ? kn + p.slice('/knowledge'.length)
  : p.startsWith('/workspaces') ? ws + p.slice('/workspaces'.length)
  : p;
if (args[0] === 'version') process.exit(0);
if (args[0] === 'volume') {
  if (process.env.STUB_VOLUME === '0') process.exit(1);
  if (args.includes('--format')) process.stdout.write(process.env.STUB_VOLUME_MOUNT || '/nonexistent/docker-volume');
  process.exit(0);
}
if (args[0] !== 'compose') process.exit(0);
let i = 1;
if (args[i] === '-f') i += 2;
const sub = args[i++];
if (sub === 'version') process.exit(0);
if (sub === 'config') {
  if (args.slice(i).includes('--services')) process.stdout.write('api\\nworker\\npostgres\\nredis\\n');
  else process.stdout.write(JSON.stringify({ name: 'agentport', volumes: { knowledgedata: {}, workspaces: {} } }));
  process.exit(0);
}
if (sub === 'ps') {
  if (process.env.STUB_COMPOSE_RUNNING === '1') process.stdout.write('cid\\n');
  process.exit(0);
}
if (sub !== 'exec' && sub !== 'run') process.exit(0);
const envs = {};
let svc = null;
let entry = null;
let inHost = null;
const cmd = [];
for (; i < args.length; i++) {
  const a = args[i];
  if (a === '-T' || a === '--rm' || a === '--no-deps') continue;
  if (a === '--entrypoint') { entry = args[++i]; continue; }
  if (a === '-e') { const kv = args[++i]; const eq = kv.indexOf('='); envs[kv.slice(0, eq)] = kv.slice(eq + 1); continue; }
  if (a === '-v') {
    const [host, container] = args[++i].split(':');
    if (container === '/in') inHost = host;
    continue;
  }
  if (svc === null) { svc = a; continue; }
  cmd.push(a);
}
if (envs.SRC === '/in') envs.SRC = inHost;
const argv = entry ? [entry, ...cmd] : cmd;
if (svc === 'postgres') { process.stdout.write('postgres (PostgreSQL) 18.0\\n'); process.exit(0); }
if (fail && (argv[0] === 'tar' || argv[0] === 'sh')) process.exit(1);
if (argv[0] === 'tar') process.exit(spawnSync('tar', argv.slice(1).map(mapPath), { stdio: 'inherit' }).status ?? 1);
if (argv[0] === 'sh') {
  const env = { ...process.env, ...envs };
  if (env.SRC) env.SRC = mapPath(env.SRC);
  if (env.ROOT) env.ROOT = mapPath(env.ROOT);
  const script = String(argv[2] ?? '').replaceAll('/knowledge', kn);
  process.exit(spawnSync('sh', ['-c', script], { stdio: 'inherit', env }).status ?? 1);
}
process.exit(0);
`;
    await writeFile(join(env.bin, 'docker'), code, { mode: 0o755 });
  }

  function scriptEnv(extra: Record<string, string> = {}) {
    return {
      PATH: env.bin,
      HOME: env.dir,
      TMPDIR: env.dir,
      STUB_LOG: env.log,
      DATABASE_URL: '',
      BACKUP_WORKSPACES_DIR: env.workspaces,
      KNOWLEDGE_DIR: env.knowledge,
      BACKUP_DIR: env.backupDir,
      BACKUP_ENV_FILE: env.envFile,
      ...extra,
    };
  }

  async function backup(extra: Record<string, string> = {}) {
    return run('bash', [join(SCRIPTS, 'backup.sh')], { env: scriptEnv(extra) });
  }
  async function backupError(extra: Record<string, string> = {}) {
    try {
      await backup(extra);
    } catch (error) {
      const failure = error as { stdout: string; stderr: string };
      return { stdout: failure.stdout, stderr: failure.stderr };
    }
    throw new Error('expected backup.sh to fail');
  }

  async function restore(args: string[], extra: Record<string, string> = {}) {
    return run('bash', [join(SCRIPTS, 'restore.sh'), ...args], { env: scriptEnv(extra) });
  }

  async function restoreError(args: string[], extra: Record<string, string> = {}) {
    try {
      await restore(args, extra);
    } catch (error) {
      const failure = error as { stdout: string; stderr: string };
      return { stdout: failure.stdout, stderr: failure.stderr };
    }
    throw new Error('expected restore.sh to fail');
  }

  async function archiveEntries(file: string): Promise<string[]> {
    return (await run('tar', ['-tzf', file])).stdout.split('\n').filter(Boolean);
  }

  async function readArchiveFile(file: string, member: string): Promise<Buffer> {
    const { stdout } = await run('bash', ['-c', `tar -xzOf "${file}" "${member}"`], {
      encoding: 'buffer',
    } as never);
    return stdout as unknown as Buffer;
  }

  async function defaultStubs() {
    await stub('psql', 'cat </dev/null; printf 0');
    // pg_dump / pg_restore 只记录自己收到的连接串，不读归档内容。
    await stub(
      'pg_dump',
      'printf "PGDUMP %s\\n" "$*" >>"$STUB_LOG"; for a in "$@"; do case "$a" in postgres*) printf "dump-of:%s" "$a";; esac; done',
    );
    await stub(
      'pg_restore',
      `printf "PGRESTORE %s\\n" "$*" >>"$STUB_LOG"; cat </dev/null; for a in "$@"; do case "$a" in --dbname=*) printf "%s" "\${a#--dbname=}";; esac; done`,
    );
    await stub(
      'bun',
      `printf "BUN %s DATABASE_URL=%s\\n" "$*" "$DATABASE_URL" >>"$STUB_LOG"\nif [ "$1" = "-e" ]; then exec "${process.execPath}" "$@"; fi`,
    );
    await addPassThrough('gzip');
    await addPassThrough('shasum');
  }

  async function stubLog(): Promise<string[]> {
    return (await readFile(env.log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  }

  /**
   * compose 部署场景：不设 KNOWLEDGE_DIR（那份宿主配置指向 ./data/knowledge），
   * 卷挂载点在宿主不可读，数据只在“容器”里可见。
   */
  function composeEnv(extra: Record<string, string> = {}) {
    const { KNOWLEDGE_DIR: _ignored, ...base } = scriptEnv(extra);
    return {
      ...base,
      STUB_KN_DIR: env.knowledge,
      STUB_WS_DIR: env.workspaces,
      ...extra,
    } as Record<string, string>;
  }

  async function composeBackup(extra: Record<string, string> = {}) {
    return run('bash', [join(SCRIPTS, 'backup.sh')], { env: composeEnv(extra) });
  }

  async function composeRestore(args: string[], extra: Record<string, string> = {}) {
    return run('bash', [join(SCRIPTS, 'restore.sh'), ...args], { env: composeEnv(extra) });
  }

  /** 知识库目录：原件 blob + 解析产物。 */
  async function seedKnowledge() {
    await mkdir(join(env.knowledge, 'blobs', 'ab'), { recursive: true });
    await mkdir(join(env.knowledge, 'docs', 'doc-1', 'ver-1'), { recursive: true });
    await writeFile(join(env.knowledge, 'blobs', 'ab', 'abcdef'), 'original-bytes\n');
    await writeFile(join(env.knowledge, 'docs', 'doc-1', 'ver-1', 'markdown.md'), '# parsed\n');
  }

  async function backupFile(): Promise<string> {
    const { stdout } = await backup();
    return stdout.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';
  }

  /** 重打包：在解压目录里改东西后再压回 tar.gz。 */
  async function repack(archive: string, mutate: (dir: string) => Promise<void>, name: string) {
    const unpacked = await mkdtemp(join(env.dir, 'unpacked-'));
    await run('tar', ['-xzf', archive, '-C', unpacked]);
    await mutate(unpacked);
    const poisoned = join(env.dir, name);
    await run('tar', ['-czf', poisoned, '-C', unpacked, '.']);
    return poisoned;
  }

  async function restoreTargets(): Promise<string[]> {
    // 只看真正回放归档的调用（带 --dbname=），跳过 --version / --list 探测。
    return (await stubLog())
      .filter((line) => line.startsWith('PGRESTORE ') && line.includes('--dbname='))
      .map((line) => line.split('--dbname=')[1]?.split(' ')[0] ?? '');
  }

  async function setup() {
    env = await makeEnv();
  }

  async function teardown() {
    await run('rm', ['-rf', env.dir]);
  }

  return {
    setup,
    teardown,
    get env() {
      return env;
    },
    makeEnv,
    run,
    stub,
    addPassThrough,
    stubDocker,
    scriptEnv,
    backup,
    backupError,
    restore,
    restoreError,
    archiveEntries,
    readArchiveFile,
    defaultStubs,
    stubLog,
    composeEnv,
    composeBackup,
    composeRestore,
    seedKnowledge,
    backupFile,
    repack,
    restoreTargets,
  };
}
