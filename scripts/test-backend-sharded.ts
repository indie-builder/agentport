import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BACKEND_DIST_PACKAGES, ensureDistFresh } from './check-dist-fresh.js';

const root = Bun.fileURLToPath(new URL('..', import.meta.url));

const autoBuild = process.argv.includes('--auto-build');

try {
  ensureDistFresh({ root, packages: BACKEND_DIST_PACKAGES, autoBuild });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const testBackend = Bun.fileURLToPath(new URL('./test-backend.ts', import.meta.url));
const tmpDir = join(root, 'tmp');
const timingsPath = join(tmpDir, 'ci-test-timings.json');
const filterPattern = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[cm]?[jt]sx?|[^/]+_test\.[cm]?[jt]sx?)$/;
const ignoredSegments = new Set([
  'node_modules',
  '.git',
  '.claude',
  '.agents',
  'docs',
  'scripts',
  'data',
  'tmp',
]);
const ignoredPrefixes = ['packages/web', 'tests/fixtures'];

const ignored = (path: string) =>
  path.split('/').some((segment) => ignoredSegments.has(segment)) ||
  ignoredPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    const rel = relative(root, abs);
    if (entry.isDirectory()) return ignored(rel) ? [] : walk(abs);
    return entry.isFile() && filterPattern.test(rel) ? [rel] : [];
  });

const files = walk(root).sort();
if (files.length === 0) {
  console.error('test shards: no backend test files found');
  process.exit(1);
}

const defaultShards = 6;
const requested = Number(process.env.CI_TEST_SHARDS ?? defaultShards);
const shardCount = Number.isInteger(requested) && requested > 0 ? requested : defaultShards;

type Shard = { files: string[]; load: number };
const shards: Shard[] = Array.from({ length: shardCount }, () => ({ files: [], load: 0 }));

const timings: Record<string, number> = existsSync(timingsPath)
  ? (JSON.parse(readFileSync(timingsPath, 'utf8')) as Record<string, number>)
  : {};
const hasTimings = Object.keys(timings).length > 0;

if (hasTimings) {
  [...files]
    .sort((a, b) => (timings[b] ?? 0) - (timings[a] ?? 0) || a.localeCompare(b))
    .forEach((file) => {
      const shard = shards.reduce((min, current) => (current.load < min.load ? current : min));
      shard.files.push(file);
      shard.load += timings[file] ?? 0;
    });
} else {
  files.forEach((file, index) => {
    shards[index % shardCount]?.files.push(file);
  });
}

const assigned = shards.flatMap((shard) => shard.files);
if (new Set(assigned).size !== files.length || assigned.length !== files.length) {
  console.error(
    `test shards: partition mismatch (${assigned.length} assigned for ${files.length} files)`,
  );
  process.exit(1);
}

mkdirSync(tmpDir, { recursive: true });

type ShardResult = {
  index: number;
  files: string[];
  code: number;
  seconds: number;
  outfile: string;
};

const children = new Set<ReturnType<typeof Bun.spawn>>();
let interrupted: 'SIGINT' | 'SIGTERM' | undefined;
const stop = (signal: 'SIGINT' | 'SIGTERM') => {
  interrupted ??= signal;
  for (const child of children) child.kill(signal);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

const runShard = async (index: number, shard: Shard): Promise<ShardResult> => {
  const outfile = join(tmpDir, `junit-shard-${index}.xml`);
  rmSync(outfile, { force: true });
  const started = performance.now();
  const child = Bun.spawn(
    [
      process.execPath,
      testBackend,
      '--reporter=junit',
      `--reporter-outfile=${outfile}`,
      '--parallel=1',
      ...shard.files,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        AGENTPORT_DIST_FRESH_CHECKED: '1',
        DB_POOL_MAX: process.env.DB_POOL_MAX ?? '4',
      },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  children.add(child);
  const code = await child.exited;
  children.delete(child);
  return {
    index,
    files: shard.files,
    code,
    seconds: (performance.now() - started) / 1000,
    outfile,
  };
};

const started = performance.now();
const results = await Promise.all(
  shards.flatMap((shard, index) => (shard.files.length > 0 ? [runShard(index, shard)] : [])),
);
const wall = (performance.now() - started) / 1000;

const attributes = (tag: string) =>
  Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));

type Suite = { file: string; tests: number; failures: number; skipped: number; ms: number };

const readSuites = (outfile: string): Suite[] => {
  if (!existsSync(outfile)) return [];
  const xml = readFileSync(outfile, 'utf8');
  return [...xml.matchAll(/<testsuite\b([^>]*)>/g)].flatMap((match) => {
    const attrs = attributes(match[1] ?? '');
    const file = (attrs.file ?? attrs.name ?? '').replace(/^\.\//, '');
    if (!file || attrs.line) return [];
    return [
      {
        file,
        tests: Number(attrs.tests ?? 0),
        failures: Number(attrs.failures ?? 0),
        skipped: Number(attrs.skipped ?? 0),
        ms: Math.round(Number(attrs.time ?? 0) * 1000),
      },
    ];
  });
};

let failed = false;
const totals = { tests: 0, failures: 0, skipped: 0 };
const measured: Record<string, number> = {};
const covered = new Set<string>();

console.log(
  `\nbackend test shards (K=${shardCount}, timings=${hasTimings ? 'LPT' : 'round-robin'})`,
);
for (const result of results) {
  const suites = readSuites(result.outfile);
  const shardTotals = suites.reduce(
    (sum, suite) => ({
      tests: sum.tests + suite.tests,
      failures: sum.failures + suite.failures,
      skipped: sum.skipped + suite.skipped,
    }),
    { tests: 0, failures: 0, skipped: 0 },
  );
  const assignedSet = new Set(result.files);
  const reported = new Set(suites.map((suite) => suite.file));
  const missing = result.files.filter((file) => !reported.has(file));
  const foreign = [...reported].filter((file) => !assignedSet.has(file));
  const duplicated = suites.length !== reported.size;
  suites.forEach((suite) => {
    covered.add(suite.file);
    measured[suite.file] = suite.ms;
  });
  totals.tests += shardTotals.tests;
  totals.failures += shardTotals.failures;
  totals.skipped += shardTotals.skipped;
  const passed = shardTotals.tests - shardTotals.failures - shardTotals.skipped;
  const status =
    result.code === 0 && missing.length === 0 && foreign.length === 0 && !duplicated
      ? 'PASS'
      : 'FAIL';
  if (status === 'FAIL') failed = true;
  console.log(
    `shard ${result.index}  files=${String(result.files.length).padStart(3)}  ${status}  ` +
      `${result.seconds.toFixed(1).padStart(6)}s  ${passed} pass / ${shardTotals.skipped} skip / ${shardTotals.failures} fail`,
  );
  if (missing.length > 0) {
    console.error(`shard ${result.index}: ${missing.length} files produced no junit suite:`);
    for (const file of missing.slice(0, 20)) console.error(`  ${file}`);
  }
  if (foreign.length > 0) {
    console.error(`shard ${result.index}: ${foreign.length} junit suites not assigned here:`);
    for (const file of foreign.slice(0, 20)) console.error(`  ${file}`);
  }
  if (duplicated) {
    console.error(
      `shard ${result.index}: ${suites.length} junit suites for ${reported.size} distinct files`,
    );
  }
}

const uncovered = files.filter((file) => !covered.has(file));
const extra = [...covered].filter((file) => !files.includes(file));
if (uncovered.length > 0) {
  failed = true;
  console.error(`coverage: ${uncovered.length}/${files.length} files reported no junit suite`);
  for (const file of uncovered.slice(0, 20)) console.error(`  ${file}`);
}
if (extra.length > 0) {
  failed = true;
  console.error(`coverage: ${extra.length} junit suites outside the enumerated set`);
  for (const file of extra.slice(0, 20)) console.error(`  ${file}`);
}

const passed = totals.tests - totals.failures - totals.skipped;
const expected = process.env.CI_TEST_EXPECTED?.match(/^(\d+)\/(\d+)\/(\d+)$/);
if (expected) {
  const [pass, skip, fail] = expected.slice(1).map(Number);
  if (pass !== passed || skip !== totals.skipped || fail !== totals.failures) {
    failed = true;
    console.error(
      `totals: expected ${pass} pass / ${skip} skip / ${fail} fail, got ${passed} pass / ${totals.skipped} skip / ${totals.failures} fail`,
    );
  }
}

console.log(
  `coverage  ${covered.size}/${files.length} files ran, no duplicates  ` +
    `(partition ${new Set(assigned).size}=${files.length})`,
);
console.log(`totals    ${passed} pass / ${totals.skipped} skip / ${totals.failures} fail`);
console.log(`wall      ${wall.toFixed(1)}s`);

if (interrupted) {
  process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
} else {
  writeFileSync(timingsPath, JSON.stringify({ ...timings, ...measured }, null, 2));
  if (!failed) for (const result of results) rmSync(result.outfile, { force: true });
  process.exitCode = failed ? 1 : 0;
}
