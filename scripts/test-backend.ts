import { existsSync } from 'node:fs';
import { BACKEND_DIST_PACKAGES, ensureDistFresh } from './check-dist-fresh.js';

const root = Bun.fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
if (existsSync('.env')) process.loadEnvFile('.env');

const rawArgs = process.argv.slice(2);
const autoBuild = rawArgs.includes('--auto-build');
const args = rawArgs.filter((arg) => arg !== '--auto-build');

try {
  ensureDistFresh({ root, packages: BACKEND_DIST_PACKAGES, autoBuild });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const { default: setup } = await import('../packages/worker/test/global-setup.js');
let child: ReturnType<typeof Bun.spawn> | undefined;
let interrupted: 'SIGINT' | 'SIGTERM' | undefined;
const interrupt = (signal: 'SIGINT' | 'SIGTERM') => {
  interrupted = signal;
  child?.kill(signal);
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

let code = 1;
try {
  const infra = await setup();
  try {
    if (!interrupted) {
      child = Bun.spawn(
        [process.execPath, 'test', '--isolate', '--parallel=2', '--timeout=20000', ...args],
        {
          cwd: root,
          env: { ...process.env, ...infra.env, AGENTPORT_BACKEND_TEST: '1' },
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        },
      );
      code = await child.exited;
    }
  } finally {
    await infra.close();
  }
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : code;
