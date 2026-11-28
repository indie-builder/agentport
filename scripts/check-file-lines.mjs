import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HARD_LIMIT = 3000;
const DEFAULT_SRC_LIMIT = 800;
const DEFAULT_TEST_LIMIT = 1500;
const TEST_FILE_RE = /(?:^|\/)(?:test|tests)\/|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/;
const EXCLUDED_DIRS = [
  'packages/db/migrations/meta/',
  'packages/core/src/generated/',
  'scripts/baselines/',
];
const EXCLUDED_FILES = ['packages/web/src/routeTree.gen.ts', 'packages/web/src/lib/cn-tables.ts'];
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.json'];
const WALK_IGNORE = new Set(['node_modules', '.git', 'dist', '.claude', '.agents']);

function parseArgs(argv) {
  let root = process.cwd();
  let baselineRel = 'scripts/baselines/file-lines.json';
  let tighten = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tighten') {
      tighten = true;
    } else if (arg === '--root') {
      const val = argv[++i];
      if (!val) throw new Error('--root requires a directory path');
      root = resolve(val);
    } else if (arg.startsWith('--root=')) {
      root = resolve(arg.slice('--root='.length));
    } else if (arg === '--baseline') {
      const val = argv[++i];
      if (!val) throw new Error('--baseline requires a file path');
      baselineRel = val;
    } else if (arg.startsWith('--baseline=')) {
      baselineRel = arg.slice('--baseline='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    root,
    baselinePath: resolve(root, baselineRel),
    tighten,
  };
}

function walkFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (WALK_IGNORE.has(name)) continue;
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) {
      out.push(...walkFiles(full, rel));
    } else if (EXTENSIONS.some((ext) => name.endsWith(ext))) {
      out.push(rel);
    }
  }
  return out;
}

function listFiles(root) {
  let rawFiles;
  if (existsSync(join(root, '.git'))) {
    const listedRun = Bun.spawnSync(
      [
        'git',
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        '*.ts',
        '*.tsx',
        '*.js',
        '*.mjs',
        '*.json',
      ],
      { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    );
    if (!listedRun.success) {
      const reason = listedRun.signalCode
        ? `signal ${listedRun.signalCode}`
        : `exit ${listedRun.exitCode}`;
      console.error(listedRun.stderr?.toString('utf8').trim() || `git ls-files failed (${reason})`);
      process.exit(listedRun.exitCode || 1);
    }
    rawFiles = listedRun.stdout.toString('utf8').split('\0').filter(Boolean);
  } else {
    rawFiles = walkFiles(root);
  }
  return rawFiles
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => !EXCLUDED_DIRS.some((dir) => file.startsWith(dir)))
    .filter((file) => !EXCLUDED_FILES.includes(file))
    .filter((file) => existsSync(join(root, file)))
    .sort();
}

function sortRecord(record) {
  const sorted = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }
  return sorted;
}

const { root, baselinePath, tighten } = parseArgs(process.argv.slice(2));
const baselineExists = existsSync(baselinePath);
const baselineRaw = baselineExists ? JSON.parse(await Bun.file(baselinePath).text()) : {};
if (!baselineRaw || typeof baselineRaw !== 'object' || Array.isArray(baselineRaw)) {
  console.error(`[file-lines] invalid baseline format: ${baselinePath}`);
  process.exit(1);
}
const baseline = baselineRaw;
const nextBaseline = { ...baseline };
let tightened = false;

const files = listFiles(root);
const checkedSet = new Set(files);
const problems = [];
const improved = [];

for (const file of files) {
  const text = await Bun.file(join(root, file)).text();
  const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  const isJson = file.endsWith('.json');
  const baselineLimit = baseline[file];

  if (lines > HARD_LIMIT) {
    problems.push(
      `[file-lines] ${file}: ${lines} 行，超过 ${HARD_LIMIT} 行硬上限，请按领域/业务边界重构`,
    );
    continue;
  }

  if (isJson) continue;

  const defaultLimit = TEST_FILE_RE.test(file) ? DEFAULT_TEST_LIMIT : DEFAULT_SRC_LIMIT;
  if (baselineLimit !== undefined) {
    if (lines > baselineLimit) {
      problems.push(
        `[file-lines] ${file}: ${lines} 行，超过棘轮基线 ${baselineLimit} 行（默认上限 ${defaultLimit} 行），请拆分重构而非继续膨胀`,
      );
    } else if (lines <= defaultLimit) {
      if (tighten) {
        delete nextBaseline[file];
        tightened = true;
      } else {
        problems.push(
          `[file-lines] ${file}: 已降至 ${lines} 行（<= 默认上限 ${defaultLimit} 行），请运行 bun run ratchet:tighten 从基线移除`,
        );
      }
    } else if (lines < baselineLimit) {
      if (tighten) {
        nextBaseline[file] = lines;
        tightened = true;
      } else {
        improved.push(file);
      }
    }
  } else if (lines > defaultLimit) {
    problems.push(
      `[file-lines] ${file}: ${lines} 行，超过默认上限 ${defaultLimit} 行，请按领域/业务边界拆分`,
    );
  }
}

for (const file of Object.keys(baseline)) {
  if (!checkedSet.has(file)) {
    if (tighten) {
      delete nextBaseline[file];
      tightened = true;
    } else {
      problems.push(
        `[file-lines] ${file}: 基线中的文件已不存在，请运行 bun run ratchet:tighten 清理僵尸条目`,
      );
    }
  }
}

if (tighten && tightened && (baselineExists || Object.keys(nextBaseline).length > 0)) {
  await Bun.write(baselinePath, `${JSON.stringify(sortRecord(nextBaseline), null, 2)}\n`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

console.log(
  tighten
    ? `file lines tighten OK (${files.length} files checked${tightened ? ', baseline updated' : ''})`
    : `file lines OK (${files.length} files checked)`,
);
if (!tighten && improved.length > 0) {
  console.log(`tip: ${improved.length} 个文件行数已下降，可运行 bun run ratchet:tighten 锁定收益`);
}
