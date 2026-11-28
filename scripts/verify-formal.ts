import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const FORMAL_DIR = join(ROOT, 'formal');
const CACHE_DIR = join(ROOT, '.cache');
const JAR_PATH = join(CACHE_DIR, 'tla2tools-1.7.4.jar');
const JAR_URL = 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar';
const JAR_SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';

type CheckSpec = { name: string; dir: string; tla: string; cfg: string } & (
  | { kind: 'pass' }
  | { kind: 'expect-fail' | 'finding'; invariant: string }
);

const CHECKS: CheckSpec[] = [
  {
    kind: 'pass',
    name: 'AgentRunLifecycle',
    dir: 'agent-run-lifecycle',
    tla: 'AgentRunLifecycle.tla',
    cfg: 'AgentRunLifecycle.cfg',
  },
  {
    kind: 'expect-fail',
    name: 'BugWorkerClaimRunning',
    dir: 'agent-run-lifecycle',
    tla: 'BugWorkerClaimRunning.tla',
    cfg: 'BugWorkerClaimRunning.cfg',
    invariant: 'NoDoubleExecution',
  },
  {
    kind: 'expect-fail',
    name: 'BugPendingFinishOverwrite',
    dir: 'agent-run-lifecycle',
    tla: 'BugPendingFinishOverwrite.tla',
    cfg: 'BugPendingFinishOverwrite.cfg',
    invariant: 'NoPendingFinishOverwrite',
  },
  {
    kind: 'expect-fail',
    name: 'BugDoubleTerminalClaim',
    dir: 'agent-run-lifecycle',
    tla: 'BugDoubleTerminalClaim.tla',
    cfg: 'BugDoubleTerminalClaim.cfg',
    invariant: 'AtMostOneTerminalWinner',
  },
  {
    kind: 'finding',
    name: 'FindingNoStuckEnqueueFailure',
    dir: 'agent-run-lifecycle',
    tla: 'AgentRunLifecycle.tla',
    cfg: 'FindingNoStuckEnqueueFailure.cfg',
    invariant: 'NoStuckEnqueueFailure',
  },
  {
    kind: 'finding',
    name: 'FindingEnqueueOkImpliesJobWasActive',
    dir: 'agent-run-lifecycle',
    tla: 'AgentRunLifecycle.tla',
    cfg: 'FindingEnqueueOkImpliesJobWasActive.cfg',
    invariant: 'EnqueueOkImpliesJobWasActive',
  },
  {
    kind: 'pass',
    name: 'SchedulerSync',
    dir: 'scheduler-sync',
    tla: 'SchedulerSync.tla',
    cfg: 'SchedulerSync.cfg',
  },
  {
    kind: 'expect-fail',
    name: 'BugConcurrentSync',
    dir: 'scheduler-sync',
    tla: 'BugConcurrentSync.tla',
    cfg: 'BugConcurrentSync.cfg',
    invariant: 'NoStaleOverwrite',
  },
];

function javaMajorVersion(bin: string): number | null {
  const proc = Bun.spawnSync([bin, '-version'], { stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) return null;
  const text = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  const match = text.match(/version\s+"(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  const major = Number(match[1]);
  return major === 1 && match[2] !== undefined ? Number(match[2]) : major;
}

function collectMacJvmBins(baseDir: string): string[] {
  const entries = (() => {
    try {
      return readdirSync(baseDir);
    } catch {
      return [];
    }
  })();
  return entries
    .sort()
    .reverse()
    .map((entry) => join(baseDir, entry, 'Contents', 'Home', 'bin', 'java'));
}

async function resolveJava17(): Promise<string> {
  const candidates: string[] = [];
  if (process.env.JAVA) candidates.push(process.env.JAVA);
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, 'bin', 'java'));
  if (process.env.HOME) {
    candidates.push(
      ...collectMacJvmBins(join(process.env.HOME, 'Library', 'Java', 'JavaVirtualMachines')),
    );
  }
  candidates.push(...collectMacJvmBins('/Library/Java/JavaVirtualMachines'));
  const pathJava = Bun.which('java');
  if (pathJava) candidates.push(pathJava);

  for (const candidate of candidates) {
    if (!(await Bun.file(candidate).exists())) continue;
    const major = javaMajorVersion(candidate);
    if (major !== null && major >= 17) return candidate;
  }
  throw new Error('Java 17+ not found. Set JAVA=/path/to/java (JDK 17+).');
}

async function sha256Hex(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

async function ensureTlaJar(): Promise<string> {
  mkdirSync(dirname(JAR_PATH), { recursive: true });
  if ((await Bun.file(JAR_PATH).exists()) && (await sha256Hex(JAR_PATH)) === JAR_SHA256) {
    return JAR_PATH;
  }
  const response = await fetch(JAR_URL);
  if (!response.ok) {
    throw new Error(`Failed to download tla2tools.jar: ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  if (actual !== JAR_SHA256) {
    throw new Error(`tla2tools.jar SHA-256 mismatch: expected ${JAR_SHA256}, got ${actual}`);
  }
  await Bun.write(JAR_PATH, bytes);
  return JAR_PATH;
}

function summarizeTlc(output: string): string {
  const stats = output.match(/(\d+)\s+states generated,\s+(\d+)\s+distinct states found/);
  const depth = output.match(/The depth of the complete state graph search is (\d+)/);
  const finished = output.match(/Finished in ([^\s]+)\s/);
  const parts: string[] = [];
  if (stats?.[1] && stats[2]) parts.push(`${stats[1]} states / ${stats[2]} distinct`);
  if (depth?.[1]) parts.push(`depth ${depth[1]}`);
  if (finished?.[1]) parts.push(finished[1]);
  return parts.join(', ');
}

async function runTlc(javaBin: string, jarPath: string, check: CheckSpec) {
  const metaDir = mkdtempSync(join(tmpdir(), 'agentport-tlc-'));
  try {
    const proc = Bun.spawn(
      [
        javaBin,
        '-XX:+UseParallelGC',
        '-cp',
        jarPath,
        'tlc2.TLC',
        '-workers',
        '2',
        '-metadir',
        metaDir,
        '-config',
        join(FORMAL_DIR, check.dir, check.cfg),
        join(FORMAL_DIR, check.dir, check.tla),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, output: `${stdout}\n${stderr}` };
  } finally {
    rmSync(metaDir, { recursive: true, force: true });
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await fn(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

const started = performance.now();
const javaBin = await resolveJava17();
const jarPath = await ensureTlaJar();

const outcomes = await mapLimit(CHECKS, 3, async (check) => ({
  check,
  ...(await runTlc(javaBin, jarPath, check)),
}));

let failed = false;
for (const { check, exitCode, output } of outcomes) {
  const summary = summarizeTlc(output);
  if (check.kind === 'pass') {
    if (exitCode !== 0) {
      failed = true;
      console.error(`FAIL ${check.name} (expected pass, got exit ${exitCode})\n${output}`);
    } else {
      console.log(`PASS ${check.name} (${summary})`);
    }
    continue;
  }

  const violated = `Invariant ${check.invariant} is violated`;
  if (exitCode === 0) {
    failed = true;
    if (check.kind === 'finding') {
      console.error(
        `FAIL ${check.name}: Finding ${check.name} 已被生产代码修复：请将 ${check.invariant} 移回 AgentRunLifecycle.cfg 并移除 ${check.cfg}`,
      );
    } else {
      console.error(`FAIL ${check.name}: expected violation of ${check.invariant}, but TLC passed`);
    }
    continue;
  }
  if (!output.includes(violated)) {
    failed = true;
    console.error(
      `FAIL ${check.name}: expected "${violated}", got exit ${exitCode} with different output\n${output}`,
    );
    continue;
  }
  const tag = check.kind === 'finding' ? 'FINDING' : 'BUG-RED';
  console.log(`${tag} ${check.name} (${violated}; ${summary})`);
}

console.log(
  `formal verification finished in ${((performance.now() - started) / 1000).toFixed(1)}s`,
);
if (failed) process.exit(1);
