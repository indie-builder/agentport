import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

type JournalEntry = {
  idx?: unknown;
  tag?: unknown;
};

type JournalFile = {
  entries?: unknown;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const listSqlFiles = (migrationsDir: string): string[] => {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
};

const readJournalJson = (journalPath: string): { data?: JournalFile; error?: string } => {
  try {
    const raw = JSON.parse(readFileSync(journalPath, 'utf8')) as unknown;
    if (!isPlainObject(raw)) {
      return { error: `[db-migrations] _journal.json 格式无效: ${journalPath}` };
    }
    return { data: raw as JournalFile };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `[db-migrations] 无法解析 _journal.json (${journalPath}): ${message}` };
  }
};

const validateJournal = (migrationsDir: string): { errors: string[]; count: number } => {
  const journalPath = join(migrationsDir, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    return { errors: [`[db-migrations] 缺少迁移索引文件: ${journalPath}`], count: 0 };
  }

  const parsed = readJournalJson(journalPath);
  if (parsed.error || !parsed.data) {
    return {
      errors: [parsed.error ?? `[db-migrations] 无法读取 _journal.json: ${journalPath}`],
      count: 0,
    };
  }

  const { entries } = parsed.data;
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      errors: [`[db-migrations] _journal.json 的 entries 必须为非空数组: ${journalPath}`],
      count: 0,
    };
  }

  const errors: string[] = [];
  const seenTags = new Set<string>();

  for (let i = 0; i < entries.length; i += 1) {
    const rawEntry = entries[i];
    if (!isPlainObject(rawEntry)) {
      errors.push(`[db-migrations] _journal.json 第 ${i} 项格式无效`);
      continue;
    }

    const entry = rawEntry as JournalEntry;
    if (entry.idx !== i) {
      errors.push(
        `[db-migrations] _journal.json 条目 idx 不连续：期望 ${i}，实际为 ${String(entry.idx)} (tag=${String(entry.tag)})`,
      );
    }

    if (typeof entry.tag !== 'string' || entry.tag.length === 0) {
      errors.push(`[db-migrations] _journal.json 第 ${i} 项缺少有效的 tag`);
      continue;
    }

    if (seenTags.has(entry.tag)) {
      errors.push(`[db-migrations] _journal.json 存在重复 tag: ${entry.tag}`);
      continue;
    }

    seenTags.add(entry.tag);
    const sqlPath = join(migrationsDir, `${entry.tag}.sql`);
    if (!existsSync(sqlPath) || !statSync(sqlPath).isFile()) {
      errors.push(`[db-migrations] 迁移 ${entry.tag} 缺少对应 SQL 文件: ${sqlPath}`);
      continue;
    }

    if (readFileSync(sqlPath, 'utf8').trim().length === 0) {
      errors.push(`[db-migrations] 迁移 SQL 文件为空: ${sqlPath}`);
    }
  }

  for (const fileName of listSqlFiles(migrationsDir)) {
    const tag = fileName.slice(0, -4);
    if (!seenTags.has(tag)) {
      errors.push(
        `[db-migrations] 发现未注册到 _journal.json 的孤立 SQL 文件: ${join(migrationsDir, fileName)}`,
      );
    }
  }

  return { errors, count: entries.length };
};

export const checkMigrationJournal = (migrationsDir: string): string[] =>
  validateJournal(migrationsDir).errors;

const formatProcessOutput = (stdout: Uint8Array, stderr: Uint8Array): string =>
  [Buffer.from(stderr).toString('utf8').trim(), Buffer.from(stdout).toString('utf8').trim()]
    .filter(Boolean)
    .join('\n');

const resolveDrizzleKitBin = (root: string): string => {
  const pkgBin = join(root, 'packages', 'db', 'node_modules', '.bin', 'drizzle-kit');
  return existsSync(pkgBin) ? pkgBin : join(root, 'node_modules', '.bin', 'drizzle-kit');
};

const runDrizzleCheck = (root: string): string | null => {
  const pkgDbDir = join(root, 'packages', 'db');
  const drizzleKitBin = resolveDrizzleKitBin(root);
  if (!existsSync(drizzleKitBin)) {
    return `[db-migrations] 找不到 drizzle-kit 可执行文件: ${drizzleKitBin}`;
  }

  const result = Bun.spawnSync([drizzleKitBin, 'check'], {
    cwd: pkgDbDir,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stderr = Buffer.from(result.stderr).toString('utf8').trim();
  if (!result.success || stderr.length > 0) {
    const detail = formatProcessOutput(result.stdout, result.stderr);
    return `[db-migrations] drizzle-kit check 失败：${detail || `exit ${result.exitCode ?? 1}`}`;
  }

  return null;
};

const runDrizzleDriftCheck = (
  root: string,
  migrationsDir: string,
  expectedEntryCount: number,
): string | null => {
  const sharedDist = join(root, 'packages', 'shared', 'dist', 'index.js');
  const coreDist = join(root, 'packages', 'core', 'dist', 'index.js');
  if (!existsSync(sharedDist) || !existsSync(coreDist)) {
    return '[db-migrations] 缺少 workspace dist 产物，请先运行 bun run typecheck 后再执行 bun run lint:db';
  }

  const pkgDbDir = join(root, 'packages', 'db');
  const drizzleKitBin = resolveDrizzleKitBin(root);
  if (!existsSync(drizzleKitBin)) {
    return `[db-migrations] 找不到 drizzle-kit 可执行文件: ${drizzleKitBin}`;
  }

  const tmpParent = join(root, 'tmp');
  mkdirSync(tmpParent, { recursive: true });
  const scratch = mkdtempSync(join(tmpParent, 'db-drift-'));

  try {
    const tmpMigrationsDir = join(scratch, 'migrations');
    cpSync(migrationsDir, tmpMigrationsDir, { recursive: true });
    const outRel = relative(pkgDbDir, tmpMigrationsDir).replaceAll('\\', '/');

    const result = Bun.spawnSync(
      [
        drizzleKitBin,
        'generate',
        '--dialect',
        'postgresql',
        '--schema',
        './src/schema.ts',
        '--out',
        outRel,
        '--name',
        '__ci_drift_probe__',
      ],
      {
        cwd: pkgDbDir,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const stdout = Buffer.from(result.stdout).toString('utf8');
    const stderr = Buffer.from(result.stderr).toString('utf8');

    if (!result.success) {
      const detail = formatProcessOutput(result.stdout, result.stderr);
      return `[db-migrations] drizzle-kit generate 离线漂移检测失败（可能存在待确认的列/表重命名或 schema 错误），请运行 bun run db:generate 核对：\n${detail || `exit ${result.exitCode ?? 1}`}`;
    }

    const originalSqlFiles = new Set(listSqlFiles(migrationsDir));
    const generatedSqlFiles = listSqlFiles(tmpMigrationsDir).filter(
      (name) => !originalSqlFiles.has(name),
    );

    const tmpJournal = readJournalJson(join(tmpMigrationsDir, 'meta', '_journal.json'));
    const tmpEntries = tmpJournal.data?.entries;
    const tmpEntryCount = Array.isArray(tmpEntries) ? tmpEntries.length : expectedEntryCount;

    if (generatedSqlFiles.length > 0 || tmpEntryCount > expectedEntryCount) {
      const firstSql = generatedSqlFiles[0];
      if (firstSql) {
        const preview = readFileSync(join(tmpMigrationsDir, firstSql), 'utf8')
          .split('\n')
          .slice(0, 25)
          .join('\n');
        return `[db-migrations] packages/db/src/schema.ts 与 packages/db/migrations/ 存在未生成迁移的漂移，请运行 bun run db:generate：\n${preview}`;
      }
      return '[db-migrations] packages/db/src/schema.ts 与 packages/db/migrations/ 存在未生成迁移的漂移，请运行 bun run db:generate';
    }

    if (stderr.trim().length > 0 || !stdout.includes('No schema changes, nothing to migrate')) {
      return `[db-migrations] drizzle-kit generate 离线漂移检测未确认零变更（可能存在交互式重命名提示或加载错误），请运行 bun run db:generate 核对：\n${stderr.trim() || stdout.trim()}`;
    }

    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

const parseArgs = (argv: string[]): { root: string; staticOnly: boolean } => {
  let root = resolve(import.meta.dir, '..');
  let staticOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--static-only') {
      staticOnly = true;
    } else if (arg === '--root') {
      const val = argv[++i];
      if (!val) throw new Error('[db-migrations] --root 需要提供目录路径');
      root = resolve(val);
    } else if (arg?.startsWith('--root=')) {
      const val = arg.slice('--root='.length);
      if (!val) throw new Error('[db-migrations] --root 需要提供目录路径');
      root = resolve(val);
    } else {
      throw new Error(`[db-migrations] 未知参数: ${arg ?? ''}`);
    }
  }

  return { root, staticOnly };
};

const main = () => {
  const { root, staticOnly } = parseArgs(process.argv.slice(2));
  const migrationsDir = join(root, 'packages', 'db', 'migrations');

  const journalResult = validateJournal(migrationsDir);
  if (journalResult.errors.length > 0) {
    console.error(journalResult.errors.join('\n'));
    process.exit(1);
  }

  if (staticOnly) {
    console.log(`db migrations OK (${journalResult.count} migrations, static)`);
    return;
  }

  const checkError = runDrizzleCheck(root);
  if (checkError) {
    console.error(checkError);
    process.exit(1);
  }

  const driftError = runDrizzleDriftCheck(root, migrationsDir, journalResult.count);
  if (driftError) {
    console.error(driftError);
    process.exit(1);
  }

  console.log(
    `db migrations OK (${journalResult.count} migrations, snapshots valid, 0 schema drift)`,
  );
};

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message.startsWith('[db-migrations]') ? message : `[db-migrations] ${message}`);
    process.exit(1);
  }
}
