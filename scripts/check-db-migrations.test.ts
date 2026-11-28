import { afterEach, describe, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkMigrationJournal } from './check-db-migrations.js';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT_PATH = join(import.meta.dir, 'check-db-migrations.ts');

const tempRoots: string[] = [];

const createTempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentport-db-migrations-'));
  tempRoots.push(dir);
  return dir;
};

type JournalFixtureEntry = {
  idx: number;
  tag: string;
  sql?: string;
};

const setupMigrationsRoot = (
  root: string,
  entries: JournalFixtureEntry[],
  extraSqlFiles: Record<string, string> = {},
): string => {
  const migrationsDir = join(root, 'packages', 'db', 'migrations');
  const metaDir = join(migrationsDir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  writeFileSync(
    join(metaDir, '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: entries.map((entry) => ({
        idx: entry.idx,
        version: '7',
        when: 1_792_427_122_105 + entry.idx,
        tag: entry.tag,
        breakpoints: true,
      })),
    }),
  );

  for (const entry of entries) {
    if (entry.sql !== undefined) {
      writeFileSync(join(migrationsDir, `${entry.tag}.sql`), entry.sql);
    }
  }

  for (const [name, content] of Object.entries(extraSqlFiles)) {
    writeFileSync(join(migrationsDir, name), content);
  }

  return migrationsDir;
};

const runCli = (
  args: string[],
  cwd = REPO_ROOT,
): { exitCode: number | null; stdout: string; stderr: string } => {
  const result = Bun.spawnSync([process.execPath, SCRIPT_PATH, ...args], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString('utf8'),
    stderr: Buffer.from(result.stderr).toString('utf8'),
  };
};

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('check-db-migrations', () => {
  test('passes valid journal and matching SQL files', () => {
    const root = createTempRoot();
    const migrationsDir = setupMigrationsRoot(root, [
      { idx: 0, tag: '0000_init', sql: 'CREATE TABLE a (id int);\n' },
      { idx: 1, tag: '0001_add_b', sql: 'CREATE TABLE b (id int);\n' },
    ]);

    expect(checkMigrationJournal(migrationsDir)).toEqual([]);

    const res = runCli(['--root', root, '--static-only']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('db migrations OK (2 migrations, static)');
  });

  test('fails when a journal entry is missing its SQL file', () => {
    const root = createTempRoot();
    const migrationsDir = setupMigrationsRoot(root, [
      { idx: 0, tag: '0000_init', sql: 'CREATE TABLE a (id int);\n' },
      { idx: 1, tag: '0001_missing' },
    ]);

    const errors = checkMigrationJournal(migrationsDir);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('[db-migrations]');
    expect(errors[0]).toContain('0001_missing');

    const res = runCli(['--root', root, '--static-only']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('[db-migrations]');
  });

  test('fails when an orphan SQL file exists outside _journal.json', () => {
    const root = createTempRoot();
    const migrationsDir = setupMigrationsRoot(
      root,
      [{ idx: 0, tag: '0000_init', sql: 'CREATE TABLE a (id int);\n' }],
      { '0001_orphan.sql': 'CREATE TABLE orphan (id int);\n' },
    );

    const errors = checkMigrationJournal(migrationsDir);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('[db-migrations]');
    expect(errors[0]).toContain('0001_orphan.sql');

    const res = runCli(['--root', root, '--static-only']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('[db-migrations]');
  });

  test('fails when journal idx values are non-sequential', () => {
    const root = createTempRoot();
    const migrationsDir = setupMigrationsRoot(root, [
      { idx: 0, tag: '0000_init', sql: 'CREATE TABLE a (id int);\n' },
      { idx: 2, tag: '0001_gap', sql: 'CREATE TABLE b (id int);\n' },
    ]);

    const errors = checkMigrationJournal(migrationsDir);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('[db-migrations]');
    expect(errors[0]).toContain('idx');

    const res = runCli(['--root', root, '--static-only']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('[db-migrations]');
  });

  test('fails when journal contains duplicate tags', () => {
    const root = createTempRoot();
    const migrationsDir = setupMigrationsRoot(root, [
      { idx: 0, tag: '0000_dup', sql: 'CREATE TABLE a (id int);\n' },
      { idx: 1, tag: '0000_dup', sql: 'CREATE TABLE a (id int);\n' },
    ]);

    const errors = checkMigrationJournal(migrationsDir);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('[db-migrations]');
    expect(errors[0]).toContain('0000_dup');

    const res = runCli(['--root', root, '--static-only']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('[db-migrations]');
  });

  test('fails when a SQL migration file is empty', () => {
    const root = createTempRoot();
    const migrationsDir = setupMigrationsRoot(root, [{ idx: 0, tag: '0000_empty', sql: '   \n' }]);

    const errors = checkMigrationJournal(migrationsDir);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('[db-migrations]');
    expect(errors[0]).toContain('0000_empty.sql');

    const res = runCli(['--root', root, '--static-only']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('[db-migrations]');
  });

  test('passes full 3-layer check against repo and leaves zero tmp/db-drift-* dirs', () => {
    const sharedDist = join(REPO_ROOT, 'packages', 'shared', 'dist', 'index.js');
    const coreDist = join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js');
    if (!existsSync(sharedDist) || !existsSync(coreDist)) {
      return;
    }

    const res = runCli([], REPO_ROOT);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(
      /^db migrations OK \(\d+ migrations, snapshots valid, 0 schema drift\)/,
    );

    const tmpDir = join(REPO_ROOT, 'tmp');
    const leftovers = existsSync(tmpDir)
      ? readdirSync(tmpDir).filter((name) => name.startsWith('db-drift-'))
      : [];
    expect(leftovers).toEqual([]);
  });

  test('fails when drizzle-kit generate hits interactive TTY rename prompt and exits 0', () => {
    const sharedDist = join(REPO_ROOT, 'packages', 'shared', 'dist', 'index.js');
    const coreDist = join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js');
    if (!existsSync(sharedDist) || !existsSync(coreDist)) {
      return;
    }

    const root = mkdtempSync(join(tmpdir(), 'agentport-db-rename-'));
    try {
      const pkgDbDir = join(root, 'packages', 'db');
      mkdirSync(pkgDbDir, { recursive: true });
      symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'));
      symlinkSync(join(REPO_ROOT, 'packages', 'shared'), join(root, 'packages', 'shared'));
      symlinkSync(join(REPO_ROOT, 'packages', 'core'), join(root, 'packages', 'core'));
      symlinkSync(
        join(REPO_ROOT, 'packages', 'db', 'node_modules'),
        join(pkgDbDir, 'node_modules'),
      );
      cpSync(join(REPO_ROOT, 'packages', 'db', 'package.json'), join(pkgDbDir, 'package.json'));
      cpSync(
        join(REPO_ROOT, 'packages', 'db', 'drizzle.config.ts'),
        join(pkgDbDir, 'drizzle.config.ts'),
      );
      cpSync(join(REPO_ROOT, 'packages', 'db', 'migrations'), join(pkgDbDir, 'migrations'), {
        recursive: true,
      });
      cpSync(join(REPO_ROOT, 'packages', 'db', 'src'), join(pkgDbDir, 'src'), {
        recursive: true,
      });

      const agentsSchemaPath = join(pkgDbDir, 'src', 'schema', 'agents.ts');
      const original = readFileSync(agentsSchemaPath, 'utf8');
      const mutated = original.replace("text('role')", "text('role_renamed')");
      expect(mutated).not.toBe(original);
      writeFileSync(agentsSchemaPath, mutated);

      const res = runCli(['--root', root], REPO_ROOT);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('[db-migrations]');
      expect(res.stderr).toContain('离线漂移检测未确认零变更');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
