import { dirname } from 'node:path';

process.chdir(dirname(import.meta.dir));

type Status = 'PASS' | 'FAIL' | 'SKIP';
type Result = { stage: string; status: Status; seconds: number };

const run = async (stage: string, commands: string[][]): Promise<Result> => {
  const started = performance.now();
  try {
    for (const args of commands) {
      const code = await Bun.spawn([process.execPath, ...args], {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      }).exited;
      if (code !== 0) {
        return { stage, status: 'FAIL', seconds: (performance.now() - started) / 1000 };
      }
    }
    return { stage, status: 'PASS', seconds: (performance.now() - started) / 1000 };
  } catch (error) {
    console.error(`${stage}: ${error instanceof Error ? error.message : String(error)}`);
    return { stage, status: 'FAIL', seconds: (performance.now() - started) / 1000 };
  }
};

const skipped = (stages: string[]): Result[] =>
  stages.map((stage) => ({ stage, status: 'SKIP' as const, seconds: 0 }));

const started = performance.now();
const phaseOne = await Promise.all([
  run('lint', [
    ['run', 'lint'],
    ['run', 'lint:focus'],
    ['run', 'lint:contract'],
    ['run', 'lint:lines'],
    ['run', 'lint:docs'],
  ]),
  run('typecheck', [['run', 'typecheck']]),
  run('formal', [['run', 'verify:formal']]),
]);
const results = [...phaseOne];
const typecheckOk = phaseOne.find((result) => result.stage === 'typecheck')?.status === 'PASS';
results.push(...(typecheckOk ? [await run('build', [['run', 'build']])] : skipped(['build'])));
const built = results.find((result) => result.stage === 'build')?.status === 'PASS';
results.push(
  ...(built
    ? await Promise.all([
        run('openui:check', [['run', 'openui:check']]),
        run('test', [['run', 'test:sharded']]),
      ])
    : skipped(['openui:check', 'test'])),
);
results.push(...(built ? [await run('test:web', [['run', 'test:web']])] : skipped(['test:web'])));
if (process.argv.includes('--e2e')) {
  results.push(...(built ? [await run('e2e', [['run', 'e2e:suite']])] : skipped(['e2e'])));
}

console.log('\nCI summary');
for (const { stage, status, seconds } of results) {
  console.log(`${stage.padEnd(14)} ${status.padEnd(5)} ${seconds.toFixed(1)}s`);
}
console.log(
  `${'total'.padEnd(14)} ${''.padEnd(5)} ${((performance.now() - started) / 1000).toFixed(1)}s`,
);
process.exitCode = results.some((result) => result.status === 'FAIL') ? 1 : 0;
