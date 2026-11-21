import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDb } from '@agentport/db';
import { createBackupScriptSuite } from './fixtures/backup-script-harness.js';

const suite = createBackupScriptSuite();

beforeEach(suite.setup);
afterEach(suite.teardown);

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

  // 目标库哨兵只在配置中止用例里用来证明「没有发生写库」；多数脚本用例仍用 stub。
  const realDatabaseUrl = process.env.DATABASE_URL ?? '';
  const hasRealDatabase =
    realDatabaseUrl !== '' && !realDatabaseUrl.includes('backend_infra_unavailable');

  async function abortWithConfig(extra: Record<string, string>): Promise<string> {
    const archive = await makeBackup();
    const { stderr } = await suite.restoreError([archive], extra);
    expect(await suite.restoreTargets()).toEqual([]);
    return stderr;
  }

  it('aborts before the database when the env file is empty', async () => {
    const empty = join(suite.env.dir, 'empty.env');
    await writeFile(empty, '');
    const stderr = await abortWithConfig({
      DATABASE_URL: 'postgres://caller/target',
      BACKUP_ENV_FILE: empty,
    });
    expect(stderr).toContain('config is empty or unreadable');
  });

  it('aborts before the database when the env file cannot be copied', async () => {
    const archive = await makeBackup();
    await suite.run('rm', ['-f', join(suite.env.bin, 'install')]);
    await suite.stub('install', 'exit 1');
    const { stderr } = await suite.restoreError([archive], {
      DATABASE_URL: 'postgres://caller/target',
    });
    expect(stderr).toContain('pre-restore config backup failed');
    expect(await suite.restoreTargets()).toEqual([]);
  });

  it.skipIf(!hasRealDatabase)(
    'leaves a real target database sentinel intact when config is empty',
    async () => {
      const archive = await makeBackup();
      const empty = join(suite.env.dir, 'empty.env');
      await writeFile(empty, '');
      const { client } = createDb(realDatabaseUrl);
      try {
        await client.unsafe('drop table if exists restore_sentinel');
        await client.unsafe('create table restore_sentinel (id int primary key, note text)');
        await client.unsafe("insert into restore_sentinel values (1, 'keep')");

        const { stderr } = await suite.restoreError([archive], {
          DATABASE_URL: realDatabaseUrl,
          BACKUP_ENV_FILE: empty,
        });
        expect(stderr).toContain('config is empty or unreadable');
        // 不是只看返回值：真正的目标库仍必须保有哨兵，且没有任何 --dbname 恢复调用。
        expect(await suite.restoreTargets()).toEqual([]);
        const rows = await client.unsafe('select note from restore_sentinel where id = 1');
        expect(rows).toEqual([{ note: 'keep' }]);
      } finally {
        await client.close();
      }
    },
  );

  it('rolls the live-only expert back when its first run move fails', async () => {
    const archive = await makeBackup();
    const liveOnly = join(suite.env.workspaces, 'live-only-agent');
    await mkdir(join(liveOnly, 'sessions'), { recursive: true });
    await mkdir(join(liveOnly, 'run_live09'), { recursive: true });
    await writeFile(join(liveOnly, 'sessions', 'transcript.jsonl'), '{"old":1}\n');
    await writeFile(join(liveOnly, 'run_live09', 'keep.txt'), 'live-run\n');

    await suite.run('rm', ['-f', join(suite.env.bin, 'mv')]);
    await suite.stub(
      'mv',
      `if [ -n "\${FAIL_MV_RUN:-}" ]; then case "$1" in */.restore-holding-*/live-only-agent/run_*) exit 1;; esac; fi\nexec /bin/mv "$@"`,
    );

    const { stderr } = await suite.restoreError([archive], {
      RESTORE_ENV_TARGET: join(suite.env.dir, 'restored.env'),
      FAIL_MV_RUN: '1',
    });
    expect(stderr).toContain('workspace swap failed');

    // 第一个 run 都没搬成功：整个旧目录必须回到原路径，holding 不残留。
    expect(await readFile(join(liveOnly, 'run_live09', 'keep.txt'), 'utf8')).toBe('live-run\n');
    expect(await readFile(join(liveOnly, 'sessions', 'transcript.jsonl'), 'utf8')).toBe(
      '{"old":1}\n',
    );
    expect(
      (await readdir(suite.env.workspaces)).filter((name) => name.startsWith('.restore-')),
    ).toEqual([]);
  });

  it('rolls back every run of a live-only expert when a later run move fails', async () => {
    const archive = await makeBackup();
    const liveOnly = join(suite.env.workspaces, 'live-only-agent');
    await mkdir(join(liveOnly, 'sessions'), { recursive: true });
    await mkdir(join(liveOnly, 'run_aaa'), { recursive: true });
    await mkdir(join(liveOnly, 'run_bbb'), { recursive: true });
    await writeFile(join(liveOnly, 'sessions', 'transcript.jsonl'), '{"old":1}\n');
    await writeFile(join(liveOnly, 'run_aaa', 'a.txt'), 'first-run\n');
    await writeFile(join(liveOnly, 'run_bbb', 'b.txt'), 'second-run\n');

    await suite.run('rm', ['-f', join(suite.env.bin, 'mv')]);
    await suite.stub(
      'mv',
      `if [ -n "\${FAIL_MV_SECOND_RUN:-}" ]; then case "$1" in */.restore-holding-*/live-only-agent/run_bbb) exit 1;; esac; fi\nexec /bin/mv "$@"`,
    );

    const { stderr } = await suite.restoreError([archive], {
      RESTORE_ENV_TARGET: join(suite.env.dir, 'restored.env'),
      FAIL_MV_SECOND_RUN: '1',
    });
    expect(stderr).toContain('workspace swap failed');

    // 第一个 run 已搬进按需新建的目录、第二个失败：两者都要完整回到线上目录。
    expect(await readFile(join(liveOnly, 'run_aaa', 'a.txt'), 'utf8')).toBe('first-run\n');
    expect(await readFile(join(liveOnly, 'run_bbb', 'b.txt'), 'utf8')).toBe('second-run\n');
    // 持久目录与备份专家的 run 也按原样回滚，而不是把 run 散落在新建目录里。
    expect(await readFile(join(liveOnly, 'sessions', 'transcript.jsonl'), 'utf8')).toBe(
      '{"old":1}\n',
    );
    expect(
      await readFile(
        join(suite.env.workspaces, 'demo-agent', 'run_01abc', 'workspace.txt'),
        'utf8',
      ),
    ).toBe('derived\n');
    expect(
      (await readdir(suite.env.workspaces)).filter((name) => name.startsWith('.restore-')),
    ).toEqual([]);
  });

  it('rejects symlink members before touching anything', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();
    const unpacked = await mkdtemp(join(suite.env.dir, 'unpacked-'));
    await suite.run('tar', ['-xzf', archive, '-C', unpacked]);
    await symlink('/etc/passwd', join(unpacked, 'workspaces', 'escape'));
    const poisoned = join(suite.env.dir, 'poisoned.tar.gz');
    await suite.run('tar', ['-czf', poisoned, '-C', unpacked, '.']);

    const { stderr } = await suite.restoreError([poisoned, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toContain('symlink');
    expect(await suite.restoreTargets()).toEqual([]);
    expect(await readdir(target)).toEqual([]);
  });

  it('rejects traversal members and does not run pg_restore', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();
    const unpacked = await mkdtemp(join(suite.env.dir, 'unpacked-'));
    await suite.run('tar', ['-xzf', archive, '-C', unpacked]);
    await writeFile(join(suite.env.dir, 'escape'), 'outside\n');
    const poisoned = join(suite.env.dir, 'poisoned.tar.gz');
    // tar -r 允许追加 ../ 成员名，正好模拟一份被拼接的归档。
    await writeFile(join(unpacked, '..', 'escape'), 'outside\n');
    await suite.run('tar', ['-cf', join(suite.env.dir, 'poisoned.tar'), '-C', unpacked, '.']);
    // -P：GNU tar 默认会把 `../escape` 改写成 `escape`，不加就测不到越界成员。
    await suite.run('tar', [
      '-P',
      '-rf',
      join(suite.env.dir, 'poisoned.tar'),
      '-C',
      unpacked,
      '../escape',
    ]);
    await suite.run('gzip', ['-f', join(suite.env.dir, 'poisoned.tar')]);
    expect(await suite.archiveEntries(poisoned)).toContain('../escape');

    const { stderr } = await suite.restoreError([poisoned, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toContain('unsafe member path');
    expect(await suite.restoreTargets()).toEqual([]);
  });

  it('rejects an archive whose database content no longer matches the manifest', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();
    const unpacked = await mkdtemp(join(suite.env.dir, 'unpacked-'));
    await suite.run('tar', ['-xzf', archive, '-C', unpacked]);
    await writeFile(join(unpacked, 'database.dump'), 'tampered');
    const poisoned = join(suite.env.dir, 'tampered.tar.gz');
    await suite.run('tar', ['-czf', poisoned, '-C', unpacked, '.']);
    const { stderr } = await suite.restoreError([poisoned, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toMatch(/checksum mismatch|size mismatch/);
    expect(await suite.restoreTargets()).toEqual([]);
  });

  it('leaves the database alone when pg_restore fails', async () => {
    const archive = await makeBackup();
    const { target, targetEnv } = await makeTarget();
    await suite.stub(
      'pg_restore',
      'printf "PGRESTORE %s\\n" "$*" >>"$STUB_LOG"; cat </dev/null; case "$*" in *--list*) exit 0;; esac; echo "constraint violation" >&2; exit 1',
    );
    const { stderr } = await suite.restoreError([archive, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toContain('rolled back');
    // 文件只在数据库成功后换入，失败时原样保留。
    expect(await readdir(target)).toEqual([]);
    // 配置也不该在数据库失败时被替换。
    expect(await readFile(targetEnv, 'utf8')).toBe('DATABASE_URL=postgres://target/only\n');
  });

  it('rejects a tampered knowledge file', async () => {
    await suite.defaultStubs();
    await suite.seedKnowledge();
    const archive = await suite.backupFile();
    const { target, targetEnv } = await makeTarget();
    const poisoned = await suite.repack(
      archive,
      async (dir) => {
        await writeFile(join(dir, 'knowledge', 'blobs', 'ab', 'abcdef'), 'tampered-bytes\n');
      },
      'tampered-knowledge.tar.gz',
    );
    const { stderr } = await suite.restoreError([poisoned, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toContain('knowledge content checksum mismatch');
    expect(await suite.restoreTargets()).toEqual([]);
  });

  it('rejects an archive whose manifest lists knowledge but the archive lacks it', async () => {
    await suite.defaultStubs();
    await suite.seedKnowledge();
    const archive = await suite.backupFile();
    const { target, targetEnv } = await makeTarget();
    const poisoned = await suite.repack(
      archive,
      async (dir) => {
        await rm(join(dir, 'knowledge'), { recursive: true });
      },
      'missing-knowledge.tar.gz',
    );
    const { stderr } = await suite.restoreError([poisoned, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toContain('manifest lists knowledge but the archive has no knowledge/');
  });

  it('rejects an archive that carries knowledge/ but the manifest says null', async () => {
    await suite.defaultStubs();
    const archive = await suite.backupFile();
    const { target, targetEnv } = await makeTarget();
    const poisoned = await suite.repack(
      archive,
      async (dir) => {
        await mkdir(join(dir, 'knowledge'), { recursive: true });
        await writeFile(join(dir, 'knowledge', 'extra'), 'x');
      },
      'extra-knowledge.tar.gz',
    );
    const { stderr } = await suite.restoreError([poisoned, '--target-workspaces', target], {
      RESTORE_ENV_TARGET: targetEnv,
    });
    expect(stderr).toContain('knowledge/ but the manifest has none');
  });

  // 换入第二个顶层目录失败：已换入的新目录必须撤掉，旧目录回到原路径而不是嵌进新目录。
  it('rolls back swapped entries when a later entry fails to move in', async () => {
    await suite.defaultStubs();
    await suite.seedKnowledge();
    const archive = await suite.backupFile();
    await suite.run('rm', [
      '-rf',
      join(suite.env.knowledge, 'blobs'),
      join(suite.env.knowledge, 'docs'),
    ]);
    await mkdir(join(suite.env.knowledge, 'blobs', 'old'), { recursive: true });
    await mkdir(join(suite.env.knowledge, 'docs', 'old'), { recursive: true });
    await writeFile(join(suite.env.knowledge, 'blobs', 'old', 'old.bin'), 'old-blob\n', {
      mode: 0o600,
    });
    await writeFile(join(suite.env.knowledge, 'docs', 'old', 'old.md'), 'old-doc\n', {
      mode: 0o600,
    });
    await suite.run('rm', ['-f', join(suite.env.bin, 'mv')]);
    await suite.stub(
      'mv',
      `if [ -n "\${FAIL_MV_STAGE:-}" ]; then case "$1" in */.restore-staging-*/docs) exit 1;; esac; fi\nexec /bin/mv "$@"`,
    );

    const { stderr } = await suite.restoreError([archive], {
      RESTORE_ENV_TARGET: join(suite.env.dir, 'restored.env'),
      FAIL_MV_STAGE: '1',
    });
    expect(stderr).toContain('workspace swap failed');

    // 旧数据回到 DB 引用的原路径，层级没有被新目录套住。
    expect(await readFile(join(suite.env.knowledge, 'blobs', 'old', 'old.bin'), 'utf8')).toBe(
      'old-blob\n',
    );
    expect(await readFile(join(suite.env.knowledge, 'docs', 'old', 'old.md'), 'utf8')).toBe(
      'old-doc\n',
    );
    expect((await stat(join(suite.env.knowledge, 'blobs', 'old', 'old.bin'))).mode & 0o777).toBe(
      0o600,
    );
    expect(await readdir(join(suite.env.knowledge, 'blobs'))).toEqual(['old']);
    expect(await readdir(join(suite.env.knowledge, 'docs'))).toEqual(['old']);
    // 已换入的新内容撤掉，临时目录不残留。
    expect(
      (await readdir(suite.env.knowledge)).filter((name) => name.startsWith('.restore-')),
    ).toEqual([]);
  });

  // 换入失败后旧目录回搬也失败：holding 是唯一副本，必须保留并指明确切位置。
  it('keeps the holding directory when rollback itself fails to restore', async () => {
    await suite.defaultStubs();
    await suite.seedKnowledge();
    const archive = await suite.backupFile();
    await suite.run('rm', [
      '-rf',
      join(suite.env.knowledge, 'blobs'),
      join(suite.env.knowledge, 'docs'),
    ]);
    await mkdir(join(suite.env.knowledge, 'blobs', 'old'), { recursive: true });
    await mkdir(join(suite.env.knowledge, 'docs', 'old'), { recursive: true });
    await writeFile(join(suite.env.knowledge, 'blobs', 'old', 'old.bin'), 'old-blob\n');
    await writeFile(join(suite.env.knowledge, 'docs', 'old', 'old.md'), 'old-doc\n');
    await suite.run('rm', ['-f', join(suite.env.bin, 'mv')]);
    await suite.stub(
      'mv',
      [
        `if [ -n "\${FAIL_MV_STAGE:-}" ]; then case "$1" in */.restore-staging-*/docs) exit 1;; esac; fi`,
        `if [ -n "\${FAIL_MV_ROLLBACK:-}" ]; then case "$1" in */.restore-holding-*/blobs) exit 1;; esac; fi`,
        'exec /bin/mv "$@"',
        '',
      ].join('\n'),
    );

    const { stderr } = await suite.restoreError([archive], {
      RESTORE_ENV_TARGET: join(suite.env.dir, 'restored.env'),
      FAIL_MV_STAGE: '1',
      FAIL_MV_ROLLBACK: '1',
    });
    expect(stderr).toContain('workspace swap failed');

    // 新内容不得留在线上，旧副本留在 holding 并报出路径。
    expect(await readdir(join(suite.env.knowledge, 'blobs')).catch(() => [])).toEqual([]);
    expect(await readFile(join(suite.env.knowledge, 'docs', 'old', 'old.md'), 'utf8')).toBe(
      'old-doc\n',
    );
    const holding = (await readdir(suite.env.knowledge)).find((name) =>
      name.startsWith('.restore-holding-'),
    );
    expect(holding).toBeTruthy();
    expect(stderr).toContain(join(suite.env.knowledge, holding ?? 'missing-holding'));
    expect(
      await readFile(join(suite.env.knowledge, holding ?? '', 'blobs', 'old', 'old.bin'), 'utf8'),
    ).toBe('old-blob\n');
  });
});
