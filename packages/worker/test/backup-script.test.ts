import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
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
  return { dir, bin, workspaces, backupDir, envFile, log: join(dir, 'calls.log') };
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

function scriptEnv(extra: Record<string, string> = {}) {
  return {
    PATH: env.bin,
    HOME: env.dir,
    TMPDIR: env.dir,
    STUB_LOG: env.log,
    DATABASE_URL: '',
    BACKUP_WORKSPACES_DIR: env.workspaces,
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

  it('keeps the local backup and fails when restic upload fails', async () => {
    await defaultStubs();
    await stub('restic', 'echo "repository unreachable" >&2; exit 1');
    const { stderr } = await backupError({ RESTIC_REPOSITORY: '/tmp/offsite-repo' });
    expect(stderr).toContain('local backup kept');
    const names = (await readdir(env.backupDir)).filter((name) => name.endsWith('.tar.gz'));
    expect(names).toHaveLength(1);
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
