import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBackupScriptSuite } from './fixtures/backup-script-harness.js';

const suite = createBackupScriptSuite();

beforeEach(suite.setup);
afterEach(suite.teardown);

describe('backup.sh', () => {
  it('publishes a complete archive with config and persistent workspaces only', async () => {
    await suite.defaultStubs();
    const { stdout } = await suite.backup();
    const file = stdout.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';
    expect(file).toMatch(/backups\/\d{8}-\d{6}\.tar\.gz$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const entries = await suite.archiveEntries(file);
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

    const manifest = JSON.parse(
      (await suite.readArchiveFile(file, './manifest.json')).toString('utf8'),
    );
    expect(manifest).toMatchObject({
      format: 'agentport-backup',
      version: 2,
      workspaces: { files: 2, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    // DATABASE_URL 只出现在调用 pg_dump 的参数里，不写进清单。
    expect((await suite.readArchiveFile(file, './manifest.json')).toString('utf8')).not.toContain(
      'secret',
    );
  });

  it('includes the env file verbatim in the archive and keeps it out of logs', async () => {
    await suite.defaultStubs();
    const { stdout, stderr } = await suite.backup();
    const file = stdout.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';
    expect((await suite.readArchiveFile(file, './env')).toString('utf8')).toContain(
      'APP_SECRET_KEY=super-secret-value',
    );
    expect(stdout + stderr).not.toContain('super-secret-value');
    expect(stdout + stderr).not.toContain('postgres://u:secret');
  });

  it('does not publish anything when pg_dump fails', async () => {
    await suite.defaultStubs();
    await suite.stub('pg_dump', 'cat </dev/null; echo "connection refused" >&2; exit 1');
    const { stderr } = await suite.backupError();
    expect(stderr).toContain('no backup published');
    await expect(readdir(suite.env.backupDir).catch(() => [])).resolves.toEqual([]);
  });

  it('applies retention to its own archives and leaves pre-restore copies alone', async () => {
    await suite.defaultStubs();
    await mkdir(suite.env.backupDir, { recursive: true });
    for (const name of ['20200101-000000', '20200102-000000', '20200103-000000']) {
      await writeFile(join(suite.env.backupDir, `${name}.tar.gz`), 'old');
    }
    await writeFile(join(suite.env.backupDir, 'pre-restore-20200101-000000.tar.gz'), 'keep');
    const { stdout } = await suite.backup({ BACKUP_KEEP: '2' });
    expect(stdout).toContain('BACKUP OK');
    const names = (await readdir(suite.env.backupDir)).filter((name) => name.endsWith('.tar.gz'));
    expect(names).toContain('pre-restore-20200101-000000.tar.gz');
    expect(names.filter((name) => !name.startsWith('pre-restore-'))).toHaveLength(2);
  });

  it('archives the knowledge dir and records it in the manifest', async () => {
    await suite.defaultStubs();
    await suite.seedKnowledge();
    const file = await suite.backupFile();
    const entries = await suite.archiveEntries(file);
    expect(entries).toContain('./knowledge/');
    expect(entries).toContain('./knowledge/blobs/ab/abcdef');
    expect(entries).toContain('./knowledge/docs/doc-1/ver-1/markdown.md');
    const manifest = JSON.parse(
      (await suite.readArchiveFile(file, './manifest.json')).toString('utf8'),
    );
    expect(manifest.knowledge).toEqual({
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      files: 2,
      bytes: 24,
    });
  });

  it('succeeds without a knowledge dir and records knowledge: null', async () => {
    await suite.defaultStubs();
    const file = await suite.backupFile();
    const entries = await suite.archiveEntries(file);
    expect(entries.some((entry) => entry.startsWith('./knowledge'))).toBe(false);
    const manifest = JSON.parse(
      (await suite.readArchiveFile(file, './manifest.json')).toString('utf8'),
    );
    expect(manifest.knowledge).toBeNull();
  });

  it('treats an empty knowledge dir like a missing one', async () => {
    await suite.defaultStubs();
    await mkdir(join(suite.env.knowledge, 'blobs'), { recursive: true });
    const file = await suite.backupFile();
    const manifest = JSON.parse(
      (await suite.readArchiveFile(file, './manifest.json')).toString('utf8'),
    );
    expect(manifest.knowledge).toBeNull();
    expect(
      (await suite.archiveEntries(file)).some((entry) => entry.startsWith('./knowledge')),
    ).toBe(false);
  });

  it('keeps the local backup and fails when restic upload fails', async () => {
    await suite.defaultStubs();
    await suite.stub('restic', 'echo "repository unreachable" >&2; exit 1');
    const { stderr } = await suite.backupError({ RESTIC_REPOSITORY: '/tmp/offsite-repo' });
    expect(stderr).toContain('local backup kept');
    const names = (await readdir(suite.env.backupDir)).filter((name) => name.endsWith('.tar.gz'));
    expect(names).toHaveLength(1);
  });
});

describe('backup.sh (compose volume)', () => {
  it('reads the knowledge volume through a one-off container when the host mount is unreachable', async () => {
    await suite.defaultStubs();
    await suite.stubDocker();
    await suite.seedKnowledge();
    const { stdout, stderr } = await suite.composeBackup({
      STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
    });
    const file = stdout.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';
    expect(stderr).toContain('knowledge: compose run');
    const entries = await suite.archiveEntries(file);
    expect(entries).toContain('./knowledge/blobs/ab/abcdef');
    const manifest = JSON.parse(
      (await suite.readArchiveFile(file, './manifest.json')).toString('utf8'),
    );
    expect(manifest.knowledge).toMatchObject({ files: 2, bytes: 24 });
  });

  it('uses compose exec while api is running', async () => {
    await suite.defaultStubs();
    await suite.stubDocker();
    await suite.seedKnowledge();
    const { stderr } = await suite.composeBackup({
      STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
      STUB_COMPOSE_RUNNING: '1',
    });
    expect(stderr).toContain('knowledge: compose exec api:/knowledge');
    expect((await suite.stubLog()).some((line) => line.includes(' exec -T api '))).toBe(true);
  });

  it('fails instead of publishing when the configured volume cannot be read', async () => {
    await suite.defaultStubs();
    await suite.stubDocker();
    await suite.seedKnowledge();
    // 卷在容器里也不可读：find 失败不能被 wc 的 0 吞成「没有知识库」。
    const { stderr } = await suite.backupError({
      ...suite.composeEnv({
        STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
        STUB_DOCKER_FAIL: '1',
      }),
    });
    expect(stderr).toContain('cannot read knowledge storage');
    expect(stderr).toContain('no backup published');
    await expect(readdir(suite.env.backupDir).catch(() => [])).resolves.toEqual([]);
  });

  it('fails when the container find itself errors', async () => {
    await suite.defaultStubs();
    await suite.stubDocker();
    // 目录存在但容器内 find 失败（权限错误）：不能靠 wc 的 0 当成「没有知识库」。
    const blocked = join(suite.env.dir, 'blocked-volume');
    await mkdir(join(blocked, 'blobs'), { recursive: true });
    await writeFile(join(blocked, 'blobs', 'x'), 'x');
    await suite.run('chmod', ['000', blocked]);
    const failure = await suite
      .composeBackup({
        STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
        STUB_KN_DIR: blocked,
      })
      .then(
        () => null,
        (error: { stderr: string }) => error,
      );
    await suite.run('chmod', ['700', blocked]);
    expect(failure?.stderr).toContain('cannot read knowledge storage');
    expect(failure?.stderr).toContain('no backup published');
  });

  it('falls back to a container when the host volume mount is not readable', async () => {
    await suite.defaultStubs();
    await suite.stubDocker();
    await suite.seedKnowledge();
    // 宿主路径存在却读不了：不能当成空知识库，要改走容器读同一卷。
    const blocked = join(suite.env.dir, 'blocked-knowledge');
    await mkdir(blocked);
    await suite.run('chmod', ['000', blocked]);
    const result = await suite
      .composeBackup({ STUB_VOLUME_MOUNT: blocked })
      .finally(() => suite.run('chmod', ['700', blocked]));
    expect(result.stderr).toContain('knowledge: compose run');
    const file = result.stdout.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';
    const manifest = JSON.parse(
      (await suite.readArchiveFile(file, './manifest.json')).toString('utf8'),
    );
    expect(manifest.knowledge).toMatchObject({ files: 2 });
  });

  it('fails when an explicitly configured knowledge dir cannot be read', async () => {
    await suite.defaultStubs();
    const blocked = join(suite.env.dir, 'blocked-knowledge');
    await mkdir(join(blocked, 'blobs'), { recursive: true });
    await writeFile(join(blocked, 'blobs', 'x'), 'x');
    await suite.run('chmod', ['000', blocked]);
    const failure = await suite
      .backup({
        BACKUP_KNOWLEDGE_DIR: blocked,
        KNOWLEDGE_DIR: '',
      })
      .then(
        () => null,
        (error: { stderr: string }) => error,
      );
    await suite.run('chmod', ['700', blocked]);
    expect(failure?.stderr).toContain('cannot read knowledge storage');
    expect(failure?.stderr).toContain('no backup published');
  });
});
