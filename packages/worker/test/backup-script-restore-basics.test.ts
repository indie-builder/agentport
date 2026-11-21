import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBackupScriptSuite } from './fixtures/backup-script-harness.js';

const suite = createBackupScriptSuite();

beforeEach(suite.setup);
afterEach(suite.teardown);

describe('restore.sh (compose volume)', () => {
  it('restores knowledge into the docker volume and snapshots the previous copy', async () => {
    await suite.defaultStubs();
    await suite.stubDocker();
    await suite.seedKnowledge();
    const { stdout: backupOut } = await suite.composeBackup({
      STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
    });
    const archive = backupOut.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';

    await writeFile(join(suite.env.knowledge, 'blobs', 'ab', 'abcdef'), 'changed\n');
    await writeFile(join(suite.env.knowledge, 'stale.txt'), 'stale\n');

    const { stdout, stderr } = await suite.composeRestore([archive], {
      STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
      RESTORE_ENV_TARGET: join(suite.env.dir, 'restored.env'),
    });
    expect(stdout).toContain('RESTORE OK');
    expect(stderr).toContain('restoring knowledge (/knowledge)');
    expect(await readFile(join(suite.env.knowledge, 'blobs', 'ab', 'abcdef'), 'utf8')).toBe(
      'original-bytes\n',
    );
    expect(await readFile(join(suite.env.knowledge, 'stale.txt'), 'utf8').catch(() => '')).toBe('');

    const safety = (await readdir(suite.env.backupDir)).find(
      (name) => name.startsWith('pre-restore-') && name.endsWith('.tar.gz'),
    );
    const manifest = JSON.parse(
      (
        await suite.readArchiveFile(join(suite.env.backupDir, safety ?? ''), './manifest.json')
      ).toString('utf8'),
    );
    expect(manifest.knowledge).toMatchObject({ files: 3 });
  });

  it('refuses to swap the live knowledge volume while api is running', async () => {
    await suite.defaultStubs();
    await suite.stubDocker();
    await suite.seedKnowledge();
    const { stdout: backupOut } = await suite.composeBackup({
      STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
    });
    const archive = backupOut.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';
    const { stderr } = await suite.restoreError([archive], {
      STUB_VOLUME_MOUNT: '/nonexistent/docker-volume',
      STUB_COMPOSE_RUNNING: '1',
      RESTORE_ENV_TARGET: join(suite.env.dir, 'restored.env'),
    });
    expect(stderr).toContain('api/worker are running');
    expect(await readFile(join(suite.env.knowledge, 'blobs', 'ab', 'abcdef'), 'utf8')).toBe(
      'original-bytes\n',
    );
  });
});

describe('restore.sh', () => {
  async function makeBackup(): Promise<string> {
    await suite.defaultStubs();
    const { stdout } = await suite.backup();
    return stdout.trim().split('\n').at(-1)?.replace('BACKUP OK ', '') ?? '';
  }

  async function makeTarget(): Promise<{ dir: string; target: string; targetEnv: string }> {
    const dir = await mkdtemp(join(suite.env.dir, 'target-'));
    const target = join(dir, 'workspaces');
    const targetEnv = join(dir, '.env');
    await mkdir(target);
    await writeFile(targetEnv, 'DATABASE_URL=postgres://target/only\n');
    return { dir, target, targetEnv };
  }

  it('recovers with an explicit DATABASE_URL when no local env exists', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();

    const { stdout, stderr } = await suite.restore([archive, '--target-workspaces', target], {
      DATABASE_URL: 'postgres://caller/target',
      BACKUP_ENV_FILE: join(suite.env.dir, 'missing.env'),
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stdout).toContain('RESTORE OK');
    expect(stderr).not.toContain('caller/target');
    expect(await suite.restoreTargets()).toEqual(['postgres://caller/target']);

    const safety = (await readdir(suite.env.backupDir)).find(
      (name) => name.startsWith('pre-restore-') && name.endsWith('.tar.gz'),
    );
    const safetyArchive = join(suite.env.backupDir, safety ?? '');
    const safetyEnv = (await suite.readArchiveFile(safetyArchive, './env')).toString('utf8');
    expect(safetyEnv).toContain('no local config existed');
    expect(safetyEnv).toContain("DATABASE_URL='postgres://caller/target'");
    expect(safetyEnv).not.toContain('APP_SECRET_KEY');

    const safetyEnvFile = join(suite.env.dir, 'safety.env');
    await writeFile(safetyEnvFile, safetyEnv);
    const second = await mkdtemp(join(suite.env.dir, 'target-'));
    const secondTarget = join(second, 'workspaces');
    await mkdir(secondTarget);
    const { stdout: again } = await suite.restore(
      [safetyArchive, '--target-workspaces', secondTarget],
      {
        BACKUP_ENV_FILE: safetyEnvFile,
      },
    );
    expect(again).toContain('RESTORE OK');
    expect(await suite.restoreTargets()).toEqual([
      'postgres://caller/target',
      'postgres://caller/target',
    ]);
  });

  it('writes a source-safe bootstrap env when no local env exists', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();
    const tricky = `postgres://u:p@db:5432/t?x=1&y=$(touch ${join(suite.env.dir, 'pwned')})`;

    await suite.restore([archive, '--target-workspaces', target], {
      DATABASE_URL: tricky,
      BACKUP_ENV_FILE: join(suite.env.dir, 'missing.env'),
      RESTORE_ENV_TARGET: targetEnv,
    });

    const safety = (await readdir(suite.env.backupDir)).find(
      (name) => name.startsWith('pre-restore-') && name.endsWith('.tar.gz'),
    );
    const bootstrap = join(suite.env.dir, 'bootstrap.env');
    await writeFile(
      bootstrap,
      await suite.readArchiveFile(join(suite.env.backupDir, safety ?? ''), './env'),
    );
    const { stdout } = await suite.run('bash', [
      '-c',
      '. "$1"; printf "%s" "$DATABASE_URL"',
      '_',
      bootstrap,
    ]);
    expect(stdout).toBe(tricky);
    await expect(stat(join(suite.env.dir, 'pwned'))).rejects.toThrow();
  });

  it('restores the exact quoted DATABASE_URL from the bootstrap env it generated', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();
    const tricky = `postgres://u:p'ass word@db:5432/t?x=1&y=$(touch ${join(suite.env.dir, 'pwned-restore')})`;

    await suite.restore([archive, '--target-workspaces', target], {
      DATABASE_URL: tricky,
      BACKUP_ENV_FILE: join(suite.env.dir, 'missing.env'),
      RESTORE_ENV_TARGET: targetEnv,
    });

    const safety = (await readdir(suite.env.backupDir)).find(
      (name) => name.startsWith('pre-restore-') && name.endsWith('.tar.gz'),
    );
    const bootstrap = join(suite.env.dir, 'bootstrap-roundtrip.env');
    await writeFile(
      bootstrap,
      await suite.readArchiveFile(join(suite.env.backupDir, safety ?? ''), './env'),
    );

    await writeFile(suite.env.log, '');
    const second = await mkdtemp(join(suite.env.dir, 'target-'));
    const secondTarget = join(second, 'workspaces');
    await mkdir(secondTarget);
    await suite.restore([archive, '--target-workspaces', secondTarget], {
      BACKUP_ENV_FILE: bootstrap,
    });
    const restored = (await suite.stubLog())
      .filter((line) => line.startsWith('PGRESTORE ') && line.includes('--dbname='))
      .map((line) => line.split('--dbname=')[1] ?? '');
    expect(restored).toEqual([tricky]);

    await writeFile(suite.env.log, '');
    await suite.backup({ BACKUP_ENV_FILE: bootstrap });
    const dumped = (await suite.stubLog())
      .filter((line) => line.startsWith('PGDUMP --format=custom '))
      .map((line) => line.slice('PGDUMP --format=custom --no-owner --no-privileges '.length));
    expect(dumped).toEqual([tricky]);
    await expect(stat(join(suite.env.dir, 'pwned-restore'))).rejects.toThrow();
  });

  it('round-trips workspace files, keeps run_* and uses the caller DATABASE_URL', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();
    await writeFile(
      join(suite.env.workspaces, 'demo-agent', 'agent-memory', 'MEMORY.md'),
      '# changed\n',
    );

    const { stdout } = await suite.restore([archive, '--target-workspaces', target], {
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

    expect(await suite.restoreTargets()).toEqual(['postgres://caller/target']);
    const calls = await suite.stubLog();
    expect(calls.some((line) => line.startsWith('BUN '))).toBe(true);
    expect(calls.some((line) => line.includes('DATABASE_URL=postgres://caller/target'))).toBe(true);
    expect(await readFile(targetEnv, 'utf8')).toContain('APP_SECRET_KEY=super-secret-value');
    const safety = (await readdir(suite.env.backupDir)).filter((name) =>
      name.startsWith('pre-restore-'),
    );
    expect(safety.some((name) => name.endsWith('.tar.gz'))).toBe(true);
    expect(safety.some((name) => name.endsWith('.env'))).toBe(true);
  });

  it('keeps run_* directories that exist in the live target', async () => {
    const archive = await makeBackup();
    await mkdir(join(suite.env.workspaces, 'demo-agent', 'run_live01'), { recursive: true });
    await writeFile(join(suite.env.workspaces, 'demo-agent', 'run_live01', 'keep.txt'), 'live\n');
    await writeFile(
      join(suite.env.workspaces, 'demo-agent', 'agent-memory', 'MEMORY.md'),
      '# changed\n',
    );

    await suite.restore([archive], { RESTORE_ENV_TARGET: join(suite.env.dir, 'restored.env') });
    expect(
      await readFile(join(suite.env.workspaces, 'demo-agent', 'run_live01', 'keep.txt'), 'utf8'),
    ).toBe('live\n');
    expect(
      await readFile(join(suite.env.workspaces, 'demo-agent', 'agent-memory', 'MEMORY.md'), 'utf8'),
    ).toBe('# memory\n');
    expect(
      (await readdir(suite.env.workspaces)).filter((name) => name.startsWith('.restore-')),
    ).toEqual([]);
  });

  it('keeps run_* for an expert that exists only in the live workspaces', async () => {
    const archive = await makeBackup();
    const liveOnly = join(suite.env.workspaces, 'live-only-agent');
    await mkdir(join(liveOnly, 'sessions'), { recursive: true });
    await mkdir(join(liveOnly, 'run_live09'), { recursive: true });
    await writeFile(join(liveOnly, 'sessions', 'transcript.jsonl'), '{"old":1}\n');
    await writeFile(join(liveOnly, 'run_live09', 'keep.txt'), 'live-run\n');

    await suite.restore([archive], { RESTORE_ENV_TARGET: join(suite.env.dir, 'restored.env') });

    expect(await readFile(join(liveOnly, 'run_live09', 'keep.txt'), 'utf8')).toBe('live-run\n');
    expect(
      await readFile(join(liveOnly, 'sessions', 'transcript.jsonl'), 'utf8').catch(() => ''),
    ).toBe('');
    expect(
      (await readdir(suite.env.workspaces)).filter((name) => name.startsWith('.restore-')),
    ).toEqual([]);
  });

  it('rejects legacy sql.gz backups', async () => {
    const legacy = join(suite.env.dir, '20260101-000000.sql.gz');
    await writeFile(legacy, 'not used');
    const { stderr } = await suite.restoreError([legacy]);
    expect(stderr).toContain('legacy sql.gz backups are not supported');
  });

  it('restores legacy archives that have no knowledge field', async () => {
    await suite.defaultStubs();
    const archive = await suite.backupFile();
    const { target, targetEnv } = await makeTarget();
    const legacy = await suite.repack(
      archive,
      async (dir) => {
        const path = join(dir, 'manifest.json');
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        delete manifest.knowledge;
        await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      },
      'legacy.tar.gz',
    );
    const { stdout } = await suite.restore([legacy, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stdout).toContain('RESTORE OK');
  });

  it('round-trips knowledge to --target-knowledge', async () => {
    await suite.defaultStubs();
    await suite.seedKnowledge();
    const archive = await suite.backupFile();
    const { dir: targetDir, target, targetEnv } = await makeTarget();
    const targetKnowledge = join(targetDir, 'knowledge');

    const { stdout } = await suite.restore(
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
    await suite.defaultStubs();
    await suite.seedKnowledge();
    const archive = await suite.backupFile();
    await writeFile(join(suite.env.knowledge, 'blobs', 'ab', 'abcdef'), 'changed\n');
    await writeFile(join(suite.env.knowledge, 'stale.txt'), 'stale\n');

    const { stderr } = await suite.restore([archive], {
      RESTORE_ENV_TARGET: join(suite.env.dir, 'restored.env'),
    });
    expect(stderr).toContain('is not empty');
    expect(await readFile(join(suite.env.knowledge, 'blobs', 'ab', 'abcdef'), 'utf8')).toBe(
      'original-bytes\n',
    );
    expect(await readFile(join(suite.env.knowledge, 'stale.txt'), 'utf8').catch(() => '')).toBe('');
    expect(
      (await readdir(suite.env.knowledge)).filter((name) => name.startsWith('.restore-')),
    ).toEqual([]);

    const safety = (await readdir(suite.env.backupDir)).find(
      (name) => name.startsWith('pre-restore-') && name.endsWith('.tar.gz'),
    );
    const manifest = JSON.parse(
      (
        await suite.readArchiveFile(join(suite.env.backupDir, safety ?? ''), './manifest.json')
      ).toString('utf8'),
    );
    expect(manifest.knowledge).toMatchObject({ files: 3 });
  });

  it('refuses a non-empty --target-knowledge', async () => {
    await suite.defaultStubs();
    const archive = await suite.backupFile();
    const { dir: targetDir, target, targetEnv } = await makeTarget();
    const targetKnowledge = join(targetDir, 'knowledge');
    await mkdir(targetKnowledge);
    await writeFile(join(targetKnowledge, 'occupied'), 'x');
    const { stderr } = await suite.restoreError(
      [archive, '--target-workspaces', target, '--target-knowledge', targetKnowledge],
      { RESTORE_ENV_TARGET: targetEnv },
    );
    expect(stderr).toContain('--target-knowledge must be empty');
    expect(await suite.restoreTargets()).toEqual([]);
  });

  it('does not overwrite a non-empty target directory', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();
    await writeFile(join(target, 'occupied'), 'x');
    const { stderr } = await suite.restoreError([archive, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toContain('must be empty');
    expect(await suite.restoreTargets()).toEqual([]);
  });
});
