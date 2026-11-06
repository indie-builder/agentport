import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
if (existsSync('.env')) process.loadEnvFile('.env');

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
        [
          process.execPath,
          'test',
          '--isolate',
          '--parallel=2',
          '--timeout=20000',
          '--path-ignore-patterns=**/web/**',
          ...process.argv.slice(2),
        ],
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
