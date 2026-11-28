import { existsSync } from 'node:fs';

const LIMIT = 3000;
const EXCLUDED_DIRS = ['packages/db/migrations/meta/', 'packages/core/src/generated/'];
const EXCLUDED_FILES = ['packages/web/src/routeTree.gen.ts', 'packages/web/src/lib/cn-tables.ts'];

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
  { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
);
if (!listedRun.success) {
  const reason = listedRun.signalCode ? `signal ${listedRun.signalCode}` : `exit ${listedRun.exitCode}`;
  console.error(listedRun.stderr?.toString('utf8').trim() || `git ls-files failed (${reason})`);
  process.exit(listedRun.exitCode || 1);
}
const listed = listedRun.stdout.toString('utf8');

const files = listed
  .split('\0')
  .filter(Boolean)
  .filter((file) => !EXCLUDED_DIRS.some((dir) => file.startsWith(dir)))
  .filter((file) => !EXCLUDED_FILES.includes(file))
  .filter((file) => existsSync(file));

const problems = [];
for (const file of files) {
  const text = await Bun.file(file).text();
  const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (lines > LIMIT) {
    problems.push(`${file}: ${lines} 行，超过 ${LIMIT} 行上限，请按领域/业务边界重构`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`file lines OK (${files.length} files checked)`);
