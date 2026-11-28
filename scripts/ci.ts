import { dirname } from 'node:path';

process.chdir(dirname(import.meta.dir));

type Status = 'PASS' | 'FAIL' | 'SKIP';
type Result = { stage: string; status: Status; seconds: number };

const runOne = async (stage: string, args: string[], buffered: boolean): Promise<boolean> => {
  try {
    const proc = Bun.spawn([process.execPath, ...args], {
      stdin: 'inherit',
      stdout: buffered ? 'pipe' : 'inherit',
      stderr: buffered ? 'pipe' : 'inherit',
    });
    const [code, stdout, stderr] = buffered
      ? await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
      : [await proc.exited, '', ''];
    if (code !== 0 && buffered) {
      console.error(`--- FAIL: bun ${args.join(' ')} ---`);
      if (stdout) process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);
      if (stderr) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
    }
    return code === 0;
  } catch (error) {
    console.error(`${stage}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
};

const run = async (stage: string, commands: string[][]): Promise<Result> => {
  const started = performance.now();
  const buffered = commands.length > 1;
  const outcomes = await Promise.all(commands.map((args) => runOne(stage, args, buffered)));
  return {
    stage,
    status: outcomes.every(Boolean) ? 'PASS' : 'FAIL',
    seconds: (performance.now() - started) / 1000,
  };
};

const skip = (stage: string): Result => ({ stage, status: 'SKIP', seconds: 0 });

const started = performance.now();
const withE2e = process.argv.includes('--e2e');

const lintPromise = run('lint', [
  ['run', 'lint'],
  ['run', 'lint:focus'],
  ['run', 'lint:contract'],
  ['run', 'lint:contract:test'],
  ['run', 'lint:lines'],
  ['run', 'lint:docs'],
]);
const formalPromise = run('formal', [['run', 'verify:formal']]);
const typecheckPromise = run('typecheck', [['run', 'typecheck']]);

const buildPromise = typecheckPromise.then((typecheck) =>
  typecheck.status === 'PASS' ? run('build', [['run', 'build']]) : skip('build'),
);

const postBuildPromise = buildPromise.then(async (build) => {
  if (build.status !== 'PASS') {
    return {
      openui: skip('openui:check'),
      test: skip('test'),
      testWeb: skip('test:web'),
      e2e: withE2e ? skip('e2e') : null,
    };
  }
  const testPromise = run('test', [['run', 'test:sharded']]);
  const afterFormal = formalPromise.then(
    () => undefined,
    () => undefined,
  );
  const openuiPromise = afterFormal.then(() => run('openui:check', [['run', 'openui:check']]));
  const testWebPromise = afterFormal.then(() =>
    run('test:web', [['run', 'test:web', '--', '--maxWorkers=4']]),
  );
  const e2ePromise = withE2e
    ? Promise.all([openuiPromise, testPromise, testWebPromise]).then(() =>
        run('e2e', [['run', 'e2e:suite']]),
      )
    : Promise.resolve(null);
  const [openui, test, testWeb, e2e] = await Promise.all([
    openuiPromise,
    testPromise,
    testWebPromise,
    e2ePromise,
  ]);
  return { openui, test, testWeb, e2e };
});

const [lint, typecheck, formal, build, postBuild] = await Promise.all([
  lintPromise,
  typecheckPromise,
  formalPromise,
  buildPromise,
  postBuildPromise,
]);

const results: Result[] = [
  lint,
  typecheck,
  formal,
  build,
  postBuild.openui,
  postBuild.test,
  postBuild.testWeb,
  ...(postBuild.e2e ? [postBuild.e2e] : []),
];

console.log('\nCI summary');
for (const { stage, status, seconds } of results) {
  console.log(`${stage.padEnd(14)} ${status.padEnd(5)} ${seconds.toFixed(1)}s`);
}
console.log(
  `${'total'.padEnd(14)} ${''.padEnd(5)} ${((performance.now() - started) / 1000).toFixed(1)}s`,
);
process.exitCode = results.some((result) => result.status === 'FAIL') ? 1 : 0;
