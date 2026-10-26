import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// 这些用例只用临时目录 + stub 的 pg_dump/pg_restore/pnpm，不触真实数据库或工作区卷。
const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..', '..');
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
    ['APP_SECRET_KEY=super-secret-value', 'DATABASE_URL=postgres://u:secret@db:5432/app', ''].join(
      '\n',
    ),
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
  await stub('pnpm', 'printf "PNPM %s DATABASE_URL=%s\\n" "$*" "$DATABASE_URL" >>"$STUB_LOG"');
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

beforeEach(async () => {
  env = await makeEnv();
});

afterEach(async () => {
  await run('rm', ['-rf', env.dir]);
});

describe('backup.sh', () => {
  it('publishes a complete archive with config and persistent workspaces only', async () => {
    await defaultStubs();
    const { stdout } = await backup();
    const file = stdout.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';
    expect(file).toMatch(/backups\/\d{8}-\d{6}\.tar\.gz$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const entries = await archiveEntries(file);
    for (const member of [
      './manifest.json',
      './database.dump',
      './env',
      './workspaces/',
      './workspaces/demo-agent/agent-memory/MEMORY.md',
      './workspaces/demo-agent/sessions/transcript.jsonl',
    ]) {
      expect(entries).toContain(member);
    }
    // run_* 是派生的工作区，sandbox-probes 是试连挂载点，都不该进备份。
    expect(entries.some((entry) => entry.includes('/run_'))).toBe(false);
    expect(entries.some((entry) => entry.includes('sandbox-probes'))).toBe(false);

    const manifest = JSON.parse((await readArchiveFile(file, './manifest.json')).toString('utf8'));
    expect(manifest).toMatchObject({
      format: 'agentport-backup',
      version: 2,
      workspaces: { files: 2, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    // DATABASE_URL 只出现在调用 pg_dump 的参数里，不写进清单。
    expect((await readArchiveFile(file, './manifest.json')).toString('utf8')).not.toContain(
      'secret',
    );
  });

  it('includes the env file verbatim in the archive and keeps it out of logs', async () => {
    await defaultStubs();
    const { stdout, stderr } = await backup();
    const file = stdout.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';
    expect((await readArchiveFile(file, './env')).toString('utf8')).toContain(
      'APP_SECRET_KEY=super-secret-value',
    );
    expect(stdout + stderr).not.toContain('super-secret-value');
    expect(stdout + stderr).not.toContain('postgres://u:secret');
  });

  it('does not publish anything when pg_dump fails', async () => {
    await defaultStubs();
    await stub('pg_dump', 'cat </dev/null; echo "connection refused" >&2; exit 1');
    const { stderr } = await backupError();
    expect(stderr).toContain('no backup published');
    await expect(readdir(env.backupDir).catch(() => [])).resolves.toEqual([]);
  });

  it('applies retention to its own archives and leaves pre-restore copies alone', async () => {
    await defaultStubs();
    await mkdir(env.backupDir, { recursive: true });
    for (const name of ['20200101-000000', '20200102-000000', '20200103-000000']) {
      await writeFile(join(env.backupDir, `${name}.tar.gz`), 'old');
    }
    await writeFile(join(env.backupDir, 'pre-restore-20200101-000000.tar.gz'), 'keep');
    const { stdout } = await backup({ BACKUP_KEEP: '2' });
    expect(stdout).toContain('BACKUP OK');
    const names = (await readdir(env.backupDir)).filter((name) => name.endsWith('.tar.gz'));
    expect(names).toContain('pre-restore-20200101-000000.tar.gz');
    expect(names.filter((name) => !name.startsWith('pre-restore-'))).toHaveLength(2);
  });

  it('archives the knowledge dir and records it in the manifest', async () => {
    await defaultStubs();
    await seedKnowledge();
    const file = await backupFile();
    const entries = await archiveEntries(file);
    expect(entries).toContain('./knowledge/');
    expect(entries).toContain('./knowledge/blobs/ab/abcdef');
    expect(entries).toContain('./knowledge/docs/doc-1/ver-1/markdown.md');
    const manifest = JSON.parse((await readArchiveFile(file, './manifest.json')).toString('utf8'));
    expect(manifest.knowledge).toEqual({
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      files: 2,
      bytes: 24,
    });
  });

  it('succeeds without a knowledge dir and records knowledge: null', async () => {
    await defaultStubs();
    const file = await backupFile();
    const entries = await archiveEntries(file);
    expect(entries.some((entry) => entry.startsWith('./knowledge'))).toBe(false);
    const manifest = JSON.parse((await readArchiveFile(file, './manifest.json')).toString('utf8'));
    expect(manifest.knowledge).toBeNull();
  });

  it('treats an empty knowledge dir like a missing one', async () => {
    await defaultStubs();
    await mkdir(join(env.knowledge, 'blobs'), { recursive: true });
    const file = await backupFile();
    const manifest = JSON.parse((await readArchiveFile(file, './manifest.json')).toString('utf8'));
    expect(manifest.knowledge).toBeNull();
    expect((await archiveEntries(file)).some((entry) => entry.startsWith('./knowledge'))).toBe(
      false,
    );
  });

  it('keeps the local backup and fails when restic upload fails', async () => {
    await defaultStubs();
    await stub('restic', 'echo "repository unreachable" >&2; exit 1');
    const { stderr } = await backupError({ RESTIC_REPOSITORY: '/tmp/offsite-repo' });
    expect(stderr).toContain('local backup kept');
    const names = (await readdir(env.backupDir)).filter((name) => name.endsWith('.tar.gz'));
    expect(names).toHaveLength(1);
  });
});

describe('backup.sh (compose volume)', () => {
  it('reads the knowledge volume through a one-off container when the host mount is unreachable', async () => {
    await defaultStubs();
    await stubDocker();
    await seedKnowledge();
    const { stdout, stderr } = await composeBackup({
      STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
    });
    const file = stdout.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';
    expect(stderr).toContain('knowledge: compose run');
    const entries = await archiveEntries(file);
    expect(entries).toContain('./knowledge/blobs/ab/abcdef');
    const manifest = JSON.parse((await readArchiveFile(file, './manifest.json')).toString('utf8'));
    expect(manifest.knowledge).toMatchObject({ files: 2, bytes: 24 });
  });

  it('uses compose exec while api is running', async () => {
    await defaultStubs();
    await stubDocker();
    await seedKnowledge();
    const { stderr } = await composeBackup({
      STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
      STUB_COMPOSE_RUNNING: '1',
    });
    expect(stderr).toContain('knowledge: compose exec api:/knowledge');
    expect((await stubLog()).some((line) => line.includes(' exec -T api '))).toBe(true);
  });

  it('fails instead of publishing when the configured volume cannot be read', async () => {
    await defaultStubs();
    await stubDocker();
    await seedKnowledge();
    // 卷在容器里也不可读：find 失败不能被 wc 的 0 吞成「没有知识库」。
    const { stderr } = await backupError({
      ...composeEnv({ STUB_VOLUME_MOUNT: '/nonexistent/docker-volume', STUB_DOCKER_FAIL: '1' }),
    });
    expect(stderr).toContain('cannot read knowledge storage');
    expect(stderr).toContain('no backup published');
    await expect(readdir(env.backupDir).catch(() => [])).resolves.toEqual([]);
  });

  it('fails when the container find itself errors', async () => {
    await defaultStubs();
    await stubDocker();
    // 目录存在但容器内 find 失败（权限错误）：不能靠 wc 的 0 当成「没有知识库」。
    const blocked = join(env.dir, 'blocked-volume');
    await mkdir(join(blocked, 'blobs'), { recursive: true });
    await writeFile(join(blocked, 'blobs', 'x'), 'x');
    await run('chmod', ['000', blocked]);
    const failure = await composeBackup({
      STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
      STUB_KN_DIR: blocked,
    }).then(
      () => null,
      (error: { stderr: string }) => error,
    );
    await run('chmod', ['700', blocked]);
    expect(failure?.stderr).toContain('cannot read knowledge storage');
    expect(failure?.stderr).toContain('no backup published');
  });

  it('falls back to a container when the host volume mount is not readable', async () => {
    await defaultStubs();
    await stubDocker();
    await seedKnowledge();
    // 宿主路径存在却读不了：不能当成空知识库，要改走容器读同一卷。
    const blocked = join(env.dir, 'blocked-knowledge');
    await mkdir(blocked);
    await run('chmod', ['000', blocked]);
    const result = await composeBackup({ STUB_VOLUME_MOUNT: blocked }).finally(() =>
      run('chmod', ['700', blocked]),
    );
    expect(result.stderr).toContain('knowledge: compose run');
    const file = result.stdout.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';
    const manifest = JSON.parse((await readArchiveFile(file, './manifest.json')).toString('utf8'));
    expect(manifest.knowledge).toMatchObject({ files: 2 });
  });

  it('fails when an explicitly configured knowledge dir cannot be read', async () => {
    await defaultStubs();
    const blocked = join(env.dir, 'blocked-knowledge');
    await mkdir(join(blocked, 'blobs'), { recursive: true });
    await writeFile(join(blocked, 'blobs', 'x'), 'x');
    await run('chmod', ['000', blocked]);
    const failure = await backup({
      BACKUP_KNOWLEDGE_DIR: blocked,
      KNOWLEDGE_DIR: '',
    }).then(
      () => null,
      (error: { stderr: string }) => error,
    );
    await run('chmod', ['700', blocked]);
    expect(failure?.stderr).toContain('cannot read knowledge storage');
    expect(failure?.stderr).toContain('no backup published');
  });
});

describe('restore.sh (compose volume)', () => {
  it('restores knowledge into the docker volume and snapshots the previous copy', async () => {
    await defaultStubs();
    await stubDocker();
    await seedKnowledge();
    const { stdout: backupOut } = await composeBackup({
      STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
    });
    const archive = backupOut.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';

    // 线上知识库在“容器卷”里被改过：恢复必须换回归档内容，旧内容进安全副本。
    await writeFile(join(env.knowledge, 'blobs', 'ab', 'abcdef'), 'changed\n');
    await writeFile(join(env.knowledge, 'stale.txt'), 'stale\n');

    const { stdout, stderr } = await composeRestore([archive], {
      STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
      RESTORE_ENV_TARGET: join(env.dir, 'restored.env'),
    });
    expect(stdout).toContain('RESTORE OK');
    expect(stderr).toContain('restoring knowledge (/knowledge)');
    expect(await readFile(join(env.knowledge, 'blobs', 'ab', 'abcdef'), 'utf8')).toBe(
      'original-bytes\n',
    );
    expect(await readFile(join(env.knowledge, 'stale.txt'), 'utf8').catch(() => '')).toBe('');

    const safety = (await readdir(env.backupDir)).find(
      (name) => name.startsWith('pre-restore-') && name.endsWith('.tar.gz'),
    );
    const manifest = JSON.parse(
      (await readArchiveFile(join(env.backupDir, safety ?? ''), './manifest.json')).toString(
        'utf8',
      ),
    );
    // 当前卷里的 3 个文件（2 个原始 + stale.txt）都在安全副本里。
    expect(manifest.knowledge).toMatchObject({ files: 3 });
  });

  it('refuses to swap the live knowledge volume while api is running', async () => {
    await defaultStubs();
    await stubDocker();
    await seedKnowledge();
    const { stdout: backupOut } = await composeBackup({
      STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
    });
    const archive = backupOut.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';
    const { stderr } = await restoreError([archive], {
      STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
      STUB_COMPOSE_RUNNING: '1',
      RESTORE_ENV_TARGET: join(env.dir, 'restored.env'),
    });
    expect(stderr).toContain('api/worker are running');
    expect(await readFile(join(env.knowledge, 'blobs', 'ab', 'abcdef'), 'utf8')).toBe(
      'original-bytes\n',
    );
  });
});

describe('restore.sh', () => {
  async function makeBackup(): Promise<string> {
    await defaultStubs();
    const { stdout } = await backup();
    return stdout.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';
  }

  async function makeTarget(): Promise<{ dir: string; target: string; targetEnv: string }> {
    const dir = await mkdtemp(join(env.dir, 'target-'));
    const target = join(dir, 'workspaces');
    const targetEnv = join(dir, '.env');
    await mkdir(target);
    await writeFile(targetEnv, 'DATABASE_URL=postgres://target/only\n');
    return { dir, target, targetEnv };
  }

  it('round-trips workspace files, keeps run_* and uses the caller DATABASE_URL', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();
    await writeFile(join(env.workspaces, 'demo-agent', 'agent-memory', 'MEMORY.md'), '# changed\n');

    const { stdout } = await restore([archive, '--target-workspaces', target], {
      DATABASE_URL: 'postgres://caller/target',
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stdout).toContain('RESTORE OK');
    expect(await readFile(join(target, 'demo-agent', 'agent-memory', 'MEMORY.md'), 'utf8')).toBe(
      '# memory\n',
    );
    expect(await readFile(join(target, 'demo-agent', 'sessions', 'transcript.jsonl'), 'utf8')).toBe(
      '{"x":1}\n',
    );

    // 恢复必须落在调用环境指定的库，不能拿归档 env 里的 DATABASE_URL。
    expect(await restoreTargets()).toEqual(['postgres://caller/target']);
    const calls = await stubLog();
    expect(calls.some((line) => line.startsWith('PNPM '))).toBe(true);
    expect(calls.some((line) => line.includes('DATABASE_URL=postgres://caller/target'))).toBe(true);
    // 配置文件恢复成归档里的内容，目标 .env 原样留了安全副本。
    expect(await readFile(targetEnv, 'utf8')).toContain('APP_SECRET_KEY=super-secret-value');
    const safety = (await readdir(env.backupDir)).filter((name) => name.startsWith('pre-restore-'));
    expect(safety.some((name) => name.endsWith('.tar.gz'))).toBe(true);
    expect(safety.some((name) => name.endsWith('.env'))).toBe(true);
  });

  it('keeps run_* directories that exist in the live target', async () => {
    const archive = await makeBackup();
    await mkdir(join(env.workspaces, 'demo-agent', 'run_live01'), { recursive: true });
    await writeFile(join(env.workspaces, 'demo-agent', 'run_live01', 'keep.txt'), 'live\n');
    await writeFile(join(env.workspaces, 'demo-agent', 'agent-memory', 'MEMORY.md'), '# changed\n');

    // 恢复真实工作区；配置写到临时目标，避免改到用例自己的 .env。
    await restore([archive], { RESTORE_ENV_TARGET: join(env.dir, 'restored.env') });
    expect(
      await readFile(join(env.workspaces, 'demo-agent', 'run_live01', 'keep.txt'), 'utf8'),
    ).toBe('live\n');
    expect(
      await readFile(join(env.workspaces, 'demo-agent', 'agent-memory', 'MEMORY.md'), 'utf8'),
    ).toBe('# memory\n');
    // 换入过程中的临时目录不能留在工作区里。
    expect((await readdir(env.workspaces)).filter((name) => name.startsWith('.restore-'))).toEqual(
      [],
    );
  });

  it('rejects symlink members before touching anything', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();
    const unpacked = await mkdtemp(join(env.dir, 'unpacked-'));
    await run('tar', ['-xzf', archive, '-C', unpacked]);
    await symlink('/etc/passwd', join(unpacked, 'workspaces', 'escape'));
    const poisoned = join(env.dir, 'poisoned.tar.gz');
    await run('tar', ['-czf', poisoned, '-C', unpacked, '.']);

    const { stderr } = await restoreError([poisoned, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toContain('symlink');
    expect(await restoreTargets()).toEqual([]);
    expect(await readdir(target)).toEqual([]);
  });

  it('rejects traversal members and does not run pg_restore', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();
    const unpacked = await mkdtemp(join(env.dir, 'unpacked-'));
    await run('tar', ['-xzf', archive, '-C', unpacked]);
    await writeFile(join(env.dir, 'escape'), 'outside\n');
    const poisoned = join(env.dir, 'poisoned.tar.gz');
    // tar -r 允许追加 ../ 成员名，正好模拟一份被拼接的归档。
    await writeFile(join(unpacked, '..', 'escape'), 'outside\n');
    await run('tar', ['-cf', join(env.dir, 'poisoned.tar'), '-C', unpacked, '.']);
    // -P：GNU tar 默认会把 `../escape` 改写成 `escape`，不加就测不到越界成员。
    await run('tar', ['-P', '-rf', join(env.dir, 'poisoned.tar'), '-C', unpacked, '../escape']);
    await run('gzip', ['-f', join(env.dir, 'poisoned.tar')]);
    expect(await archiveEntries(poisoned)).toContain('../escape');

    const { stderr } = await restoreError([poisoned, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toContain('unsafe member path');
    expect(await restoreTargets()).toEqual([]);
  });

  it('rejects an archive whose database content no longer matches the manifest', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();
    const unpacked = await mkdtemp(join(env.dir, 'unpacked-'));
    await run('tar', ['-xzf', archive, '-C', unpacked]);
    await writeFile(join(unpacked, 'database.dump'), 'tampered');
    const poisoned = join(env.dir, 'tampered.tar.gz');
    await run('tar', ['-czf', poisoned, '-C', unpacked, '.']);
    const { stderr } = await restoreError([poisoned, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toMatch(/checksum mismatch|size mismatch/);
    expect(await restoreTargets()).toEqual([]);
  });

  it('rejects legacy sql.gz backups', async () => {
    const legacy = join(env.dir, '20260101-000000.sql.gz');
    await writeFile(legacy, 'not used');
    const { stderr } = await restoreError([legacy]);
    expect(stderr).toContain('legacy sql.gz backups are not supported');
  });

  it('leaves the database alone when pg_restore fails', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();
    await stub(
      'pg_restore',
      'printf "PGRESTORE %s\\n" "$*" >>"$STUB_LOG"; cat </dev/null; case "$*" in *--list*) exit 0;; esac; echo "constraint violation" >&2; exit 1',
    );
    const { stderr } = await restoreError([archive, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toContain('rolled back');
    // 文件只在数据库成功后换入，失败时原样保留。
    expect(await readdir(target)).toEqual([]);
    // 配置也不该在数据库失败时被替换。
    expect(await readFile(targetEnv, 'utf8')).toBe('DATABASE_URL=postgres://target/only\n');
  });

  it('rejects a tampered knowledge file', async () => {
    await defaultStubs();
    await seedKnowledge();
    const archive = await backupFile();
    const { target, targetEnv } = await makeTarget();
    const poisoned = await repack(
      archive,
      async (dir) => {
        await writeFile(join(dir, 'knowledge', 'blobs', 'ab', 'abcdef'), 'tampered-bytes\n');
      },
      'tampered-knowledge.tar.gz',
    );
    const { stderr } = await restoreError([poisoned, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toContain('knowledge content checksum mismatch');
    expect(await restoreTargets()).toEqual([]);
  });

  it('rejects an archive whose manifest lists knowledge but the archive lacks it', async () => {
    await defaultStubs();
    await seedKnowledge();
    const archive = await backupFile();
    const { target, targetEnv } = await makeTarget();
    const poisoned = await repack(
      archive,
      async (dir) => {
        await rm(join(dir, 'knowledge'), { recursive: true });
      },
      'missing-knowledge.tar.gz',
    );
    const { stderr } = await restoreError([poisoned, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toContain('manifest lists knowledge but the archive has no knowledge/');
  });

  it('rejects an archive that carries knowledge/ but the manifest says null', async () => {
    await defaultStubs();
    const archive = await backupFile();
    const { target, targetEnv } = await makeTarget();
    const poisoned = await repack(
      archive,
      async (dir) => {
        await mkdir(join(dir, 'knowledge'), { recursive: true });
        await writeFile(join(dir, 'knowledge', 'extra'), 'x');
      },
      'extra-knowledge.tar.gz',
    );
    const { stderr } = await restoreError([poisoned, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toContain('knowledge/ but the manifest has none');
  });

  it('restores legacy archives that have no knowledge field', async () => {
    await defaultStubs();
    const archive = await backupFile();
    const { target, targetEnv } = await makeTarget();
    const legacy = await repack(
      archive,
      async (dir) => {
        const path = join(dir, 'manifest.json');
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        delete manifest.knowledge;
        await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      },
      'legacy.tar.gz',
    );
    const { stdout } = await restore([legacy, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stdout).toContain('RESTORE OK');
  });

  it('round-trips knowledge to --target-knowledge', async () => {
    await defaultStubs();
    await seedKnowledge();
    const archive = await backupFile();
    const { dir: targetDir, target, targetEnv } = await makeTarget();
    const targetKnowledge = join(targetDir, 'knowledge');

    const { stdout } = await restore(
      [archive, '--target-workspaces', target, '--target-knowledge', targetKnowledge],
      { DATABASE_URL: 'postgres://caller/target', RESTORE_ENV_TARGET: targetEnv },
    );
    expect(stdout).toContain('RESTORE OK');
    expect(await readFile(join(targetKnowledge, 'blobs', 'ab', 'abcdef'), 'utf8')).toBe(
      'original-bytes\n',
    );
    expect((await stat(join(targetKnowledge, 'blobs', 'ab', 'abcdef'))).mode & 0o777).toBe(0o600);
    expect(
      await readFile(join(targetKnowledge, 'docs', 'doc-1', 'ver-1', 'markdown.md'), 'utf8'),
    ).toBe('# parsed\n');
  });

  it('restores knowledge to KNOWLEDGE_DIR and saves the previous copy in the safety archive', async () => {
    await defaultStubs();
    await seedKnowledge();
    const archive = await backupFile();
    await writeFile(join(env.knowledge, 'blobs', 'ab', 'abcdef'), 'changed\n');
    await writeFile(join(env.knowledge, 'stale.txt'), 'stale\n');

    const { stderr } = await restore([archive], {
      RESTORE_ENV_TARGET: join(env.dir, 'restored.env'),
    });
    expect(stderr).toContain('is not empty');
    expect(await readFile(join(env.knowledge, 'blobs', 'ab', 'abcdef'), 'utf8')).toBe(
      'original-bytes\n',
    );
    expect(await readFile(join(env.knowledge, 'stale.txt'), 'utf8').catch(() => '')).toBe('');
    expect((await readdir(env.knowledge)).filter((name) => name.startsWith('.restore-'))).toEqual(
      [],
    );

    const safety = (await readdir(env.backupDir)).find(
      (name) => name.startsWith('pre-restore-') && name.endsWith('.tar.gz'),
    );
    const manifest = JSON.parse(
      (await readArchiveFile(join(env.backupDir, safety ?? ''), './manifest.json')).toString(
        'utf8',
      ),
    );
    expect(manifest.knowledge).toMatchObject({ files: 3 });
  });

  // 换入第二个顶层目录失败：已换入的新目录必须撤掉，旧目录回到原路径而不是嵌进新目录。
  it('rolls back swapped entries when a later entry fails to move in', async () => {
    await defaultStubs();
    await seedKnowledge();
    const archive = await backupFile();
    await run('rm', ['-rf', join(env.knowledge, 'blobs'), join(env.knowledge, 'docs')]);
    await mkdir(join(env.knowledge, 'blobs', 'old'), { recursive: true });
    await mkdir(join(env.knowledge, 'docs', 'old'), { recursive: true });
    await writeFile(join(env.knowledge, 'blobs', 'old', 'old.bin'), 'old-blob\n', { mode: 0o600 });
    await writeFile(join(env.knowledge, 'docs', 'old', 'old.md'), 'old-doc\n', { mode: 0o600 });
    await run('rm', ['-f', join(env.bin, 'mv')]);
    await stub(
      'mv',
      'if [ -n "${FAIL_MV_STAGE:-}" ]; then case "$1" in */.restore-staging-*/docs) exit 1;; esac; fi\nexec /bin/mv "$@"',
    );

    const { stderr } = await restoreError([archive], {
      RESTORE_ENV_TARGET: join(env.dir, 'restored.env'),
      FAIL_MV_STAGE: '1',
    });
    expect(stderr).toContain('workspace swap failed');

    // 旧数据回到 DB 引用的原路径，层级没有被新目录套住。
    expect(await readFile(join(env.knowledge, 'blobs', 'old', 'old.bin'), 'utf8')).toBe(
      'old-blob\n',
    );
    expect(await readFile(join(env.knowledge, 'docs', 'old', 'old.md'), 'utf8')).toBe('old-doc\n');
    expect((await stat(join(env.knowledge, 'blobs', 'old', 'old.bin'))).mode & 0o777).toBe(0o600);
    expect(await readdir(join(env.knowledge, 'blobs'))).toEqual(['old']);
    expect(await readdir(join(env.knowledge, 'docs'))).toEqual(['old']);
    // 已换入的新内容撤掉，临时目录不残留。
    expect((await readdir(env.knowledge)).filter((name) => name.startsWith('.restore-'))).toEqual(
      [],
    );
  });

  // 换入失败后旧目录回搬也失败：holding 是唯一副本，必须保留并指明确切位置。
  it('keeps the holding directory when rollback itself fails to restore', async () => {
    await defaultStubs();
    await seedKnowledge();
    const archive = await backupFile();
    await run('rm', ['-rf', join(env.knowledge, 'blobs'), join(env.knowledge, 'docs')]);
    await mkdir(join(env.knowledge, 'blobs', 'old'), { recursive: true });
    await mkdir(join(env.knowledge, 'docs', 'old'), { recursive: true });
    await writeFile(join(env.knowledge, 'blobs', 'old', 'old.bin'), 'old-blob\n');
    await writeFile(join(env.knowledge, 'docs', 'old', 'old.md'), 'old-doc\n');
    await run('rm', ['-f', join(env.bin, 'mv')]);
    await stub(
      'mv',
      [
        'if [ -n "${FAIL_MV_STAGE:-}" ]; then case "$1" in */.restore-staging-*/docs) exit 1;; esac; fi',
        'if [ -n "${FAIL_MV_ROLLBACK:-}" ]; then case "$1" in */.restore-holding-*/blobs) exit 1;; esac; fi',
        'exec /bin/mv "$@"',
        '',
      ].join('\n'),
    );

    const { stderr } = await restoreError([archive], {
      RESTORE_ENV_TARGET: join(env.dir, 'restored.env'),
      FAIL_MV_STAGE: '1',
      FAIL_MV_ROLLBACK: '1',
    });
    expect(stderr).toContain('workspace swap failed');

    // 新内容不得留在线上，旧副本留在 holding 并报出路径。
    expect(await readdir(join(env.knowledge, 'blobs')).catch(() => [])).toEqual([]);
    expect(await readFile(join(env.knowledge, 'docs', 'old', 'old.md'), 'utf8')).toBe('old-doc\n');
    const holding = (await readdir(env.knowledge)).find((name) =>
      name.startsWith('.restore-holding-'),
    );
    expect(holding).toBeTruthy();
    expect(stderr).toContain(join(env.knowledge, holding ?? 'missing-holding'));
    expect(
      await readFile(join(env.knowledge, holding ?? '', 'blobs', 'old', 'old.bin'), 'utf8'),
    ).toBe('old-blob\n');
  });

  it('refuses a non-empty --target-knowledge', async () => {
    await defaultStubs();
    const archive = await backupFile();
    const { dir: targetDir, target, targetEnv } = await makeTarget();
    const targetKnowledge = join(targetDir, 'knowledge');
    await mkdir(targetKnowledge);
    await writeFile(join(targetKnowledge, 'occupied'), 'x');
    const { stderr } = await restoreError(
      [archive, '--target-workspaces', target, '--target-knowledge', targetKnowledge],
      { RESTORE_ENV_TARGET: targetEnv },
    );
    expect(stderr).toContain('--target-knowledge must be empty');
    expect(await restoreTargets()).toEqual([]);
  });

  it('does not overwrite a non-empty target directory', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();
    await writeFile(join(target, 'occupied'), 'x');
    const { stderr } = await restoreError([archive, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toContain('must be empty');
    expect(await restoreTargets()).toEqual([]);
  });
});
