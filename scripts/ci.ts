import { dirname } from 'node:path';
import {
  type PlannedStage,
  parseCiArgs,
  parseGitDiffNameStatus,
  parseGitStatusPorcelain,
  planCi,
  type StageName,
} from './ci-planner.js';

process.chdir(dirname(import.meta.dir));

type Status = 'PASS' | 'FAIL' | 'SKIP';

type StageResult = {
  stage: StageName;
  status: Status;
  seconds: number;
  command: string;
  reason?: string;
  fixHint?: string;
  output?: string;
};

const USAGE = `Usage: bun scripts/ci.ts [options]

Options:
  --fast             Skip build:web, openui:check, formal, test, test:web, e2e
  --changed [base]   Run only stages affected by git diff against base (default: origin/main -> HEAD)
  --json             Print a single JSON report to stdout
  --verbose          Stream stage output live instead of buffering
  --e2e              Include e2e:suite stage
  -h, --help         Show this help message`;

const runGit = async (args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(['git', ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { ok: code === 0, stdout, stderr };
};

const formatGitError = (prefix: string, result: { stderr: string }): string => {
  const detail = result.stderr.trim();
  return detail.length > 0 ? `${prefix}: ${detail}` : prefix;
};

const detectChangedFiles = async (
  explicitBase: string | undefined,
): Promise<{ changedFiles: string[]; deletedOrRenamedFiles: string[] }> => {
  let base = explicitBase;
  if (base) {
    const verified = await runGit(['rev-parse', '--verify', `${base}^{commit}`]);
    if (!verified.ok) {
      throw new Error(formatGitError(`Invalid --changed base ref "${base}"`, verified));
    }
  } else {
    const originMain = await runGit(['rev-parse', '--verify', '--quiet', 'origin/main']);
    base = originMain.ok ? 'origin/main' : 'HEAD';
  }

  const changedSet = new Set<string>();
  const deletedSet = new Set<string>();

  if (base !== 'HEAD') {
    let diff = await runGit(['diff', '--name-status', '-z', `${base}...HEAD`]);
    if (!diff.ok) {
      diff = await runGit(['diff', '--name-status', '-z', base]);
    }
    if (!diff.ok) {
      throw new Error(formatGitError(`Failed to diff against "${base}"`, diff));
    }
    const parsed = parseGitDiffNameStatus(diff.stdout);
    for (const file of parsed.changedFiles) changedSet.add(file);
    for (const file of parsed.deletedOrRenamedFiles) deletedSet.add(file);
  } else if (explicitBase === 'HEAD') {
    const diff = await runGit(['diff', '--name-status', '-z', 'HEAD']);
    if (!diff.ok) {
      throw new Error(formatGitError('Failed to diff against "HEAD"', diff));
    }
    const parsed = parseGitDiffNameStatus(diff.stdout);
    for (const file of parsed.changedFiles) changedSet.add(file);
    for (const file of parsed.deletedOrRenamedFiles) deletedSet.add(file);
  }

  const status = await runGit(['status', '--porcelain=v1', '-z', '-uall']);
  if (!status.ok) {
    throw new Error(formatGitError('Failed to read git status', status));
  }
  const parsed = parseGitStatusPorcelain(status.stdout);
  for (const file of parsed.changedFiles) changedSet.add(file);
  for (const file of parsed.deletedOrRenamedFiles) deletedSet.add(file);

  return {
    changedFiles: [...changedSet],
    deletedOrRenamedFiles: [...deletedSet],
  };
};

const combineOutput = (stdout: string, stderr: string): string => {
  const parts = [stdout.trim(), stderr.trim()].filter((part) => part.length > 0);
  return parts.join('\n');
};

const executeStage = async (planned: PlannedStage, verbose: boolean): Promise<StageResult> => {
  const command = `bun ${planned.args.join(' ')}`;
  if (!planned.enabled) {
    return {
      stage: planned.stage,
      status: 'SKIP',
      seconds: 0,
      command,
      ...(planned.skipReason ? { reason: planned.skipReason } : {}),
      ...(planned.fixHint ? { fixHint: planned.fixHint } : {}),
    };
  }

  const started = performance.now();
  try {
    const proc = Bun.spawn([process.execPath, ...planned.args], {
      stdin: verbose ? 'inherit' : 'ignore',
      stdout: verbose ? 'inherit' : 'pipe',
      stderr: verbose ? 'inherit' : 'pipe',
    });
    const [code, stdout, stderr] = verbose
      ? [await proc.exited, '', '']
      : await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
    const seconds = (performance.now() - started) / 1000;
    const output = combineOutput(stdout, stderr);
    return {
      stage: planned.stage,
      status: code === 0 ? 'PASS' : 'FAIL',
      seconds,
      command,
      ...(planned.fixHint ? { fixHint: planned.fixHint } : {}),
      ...(code !== 0 && output.length > 0 ? { output } : {}),
    };
  } catch (error) {
    const seconds = (performance.now() - started) / 1000;
    return {
      stage: planned.stage,
      status: 'FAIL',
      seconds,
      command,
      ...(planned.fixHint ? { fixHint: planned.fixHint } : {}),
      output: error instanceof Error ? error.message : String(error),
    };
  }
};

const run = async (): Promise<void> => {
  let options: ReturnType<typeof parseCiArgs>;
  try {
    options = parseCiArgs(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  const started = performance.now();
  let gitChanges: { changedFiles: string[]; deletedOrRenamedFiles: string[] };
  try {
    gitChanges = options.changed
      ? await detectChangedFiles(options.base)
      : { changedFiles: [], deletedOrRenamedFiles: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: message }));
    } else {
      console.error(message);
    }
    process.exitCode = 1;
    return;
  }

  const plan = planCi({
    options,
    changedFiles: gitChanges.changedFiles,
    deletedOrRenamedFiles: gitChanges.deletedOrRenamedFiles,
  });

  const verbose = options.verbose && !options.json;

  const stagePromises = new Map<StageName, Promise<StageResult>>();
  const plannedByName = new Map<StageName, PlannedStage>(
    plan.stages.map((stage) => [stage.stage, stage]),
  );

  const schedule = (stageName: StageName): Promise<StageResult> => {
    const existing = stagePromises.get(stageName);
    if (existing) return existing;

    const planned = plannedByName.get(stageName);
    if (!planned) {
      throw new Error(`Missing planned stage: ${stageName}`);
    }

    const promise = (async (): Promise<StageResult> => {
      if (!planned.enabled) {
        return executeStage(planned, verbose);
      }

      const depResults = await Promise.all(
        planned.dependsOn
          .filter((dep) => plannedByName.get(dep)?.enabled)
          .map((dep) => schedule(dep)),
      );

      const failedGate = depResults.find((dep) => dep.status !== 'PASS');

      if (failedGate) {
        const reason =
          failedGate.status === 'SKIP' && failedGate.reason
            ? failedGate.reason
            : `upstream ${failedGate.stage} failed`;
        return {
          stage: planned.stage,
          status: 'SKIP',
          seconds: 0,
          command: `bun ${planned.args.join(' ')}`,
          reason,
          ...(planned.fixHint ? { fixHint: planned.fixHint } : {}),
        };
      }

      return executeStage(planned, verbose);
    })();

    stagePromises.set(stageName, promise);
    return promise;
  };

  const results = await Promise.all(plan.stages.map((stage) => schedule(stage.stage)));
  const totalSeconds = (performance.now() - started) / 1000;
  const ok = results.every((result) => result.status !== 'FAIL');

  if (options.json) {
    console.log(
      JSON.stringify({
        ok,
        mode: plan.mode,
        changedFiles: plan.changedFiles,
        affectedPackages: plan.affectedPackages,
        totalSeconds: Number(totalSeconds.toFixed(3)),
        stages: results,
      }),
    );
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const failed = results.filter((result) => result.status === 'FAIL');
  for (const item of failed) {
    console.error(`\n=== FAIL: ${item.stage} (${item.seconds.toFixed(1)}s) ===`);
    console.error(`cmd: ${item.command}`);
    if (item.fixHint) {
      console.error(`fix: ${item.fixHint}`);
    }
    if (item.output) {
      console.error(item.output);
    }
  }

  if (options.changed && plan.changedFiles.length === 0) {
    console.log('No changed files detected; skipping all CI stages.');
  }

  const width = Math.max(14, ...results.map((result) => result.stage.length)) + 2;
  console.log('\nCI summary');
  for (const result of results) {
    const reason = result.status === 'SKIP' && result.reason ? ` (${result.reason})` : '';
    console.log(
      `${result.stage.padEnd(width)} ${result.status.padEnd(5)} ${result.seconds.toFixed(1)}s${reason}`,
    );
  }
  console.log(`${'total'.padEnd(width)} ${''.padEnd(5)} ${totalSeconds.toFixed(1)}s`);

  if (failed.length > 0) {
    console.error('\nFailed stages:');
    for (const item of failed) {
      const fixSuffix = item.fixHint ? ` (fix: ${item.fixHint})` : '';
      console.error(`  - ${item.stage}: ${item.command}${fixSuffix}`);
    }
  }

  process.exitCode = ok ? 0 : 1;
};

await run();
