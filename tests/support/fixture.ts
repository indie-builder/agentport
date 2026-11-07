import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { scenarios } from './scenarios.js';

type Scenarios = {
  [K in keyof typeof scenarios]: Awaited<ReturnType<(typeof scenarios)[K]>>;
};

type Arguments<F> = F extends (...args: infer A) => unknown ? A : never;
type Result<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never;

const runner = fileURLToPath(new URL('./fixtures/run.ts', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));

export async function fixture<S extends keyof Scenarios, A extends keyof Scenarios[S]>(
  scenario: S,
  operation: A,
  ...args: Arguments<Scenarios[S][A]>
): Promise<Result<Scenarios[S][A]>> {
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error('E2E_DATABASE_URL must identify the isolated E2E database');
  return new Promise((resolve, reject) => {
    const child = execFile(
      'bun',
      ['--no-env-file', runner],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          E2E_DATABASE_URL: databaseUrl,
          E2E_REDIS_URL: process.env.E2E_REDIS_URL,
          E2E_WORKER_PAUSED: process.env.E2E_WORKER_PAUSED,
        },
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`Fixture ${scenario}/${String(operation)} failed\n${stderr}`, {
              cause: error,
            }),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout).result);
        } catch (cause) {
          reject(
            new Error(`Fixture ${scenario}/${String(operation)} returned invalid JSON`, { cause }),
          );
        }
      },
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(JSON.stringify({ scenario, operation, args }));
  });
}
