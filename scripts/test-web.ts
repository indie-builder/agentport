import { resolve } from 'node:path';
import { ensureDistFresh, WEB_DIST_PACKAGES } from './check-dist-fresh.js';

const root = Bun.fileURLToPath(new URL('..', import.meta.url));
const rawArgs = Bun.argv.slice(2);
const autoBuild = rawArgs.includes('--auto-build');
const forwardedArgs = rawArgs.filter((arg) => arg !== '--auto-build');

try {
  ensureDistFresh({ root, packages: WEB_DIST_PACKAGES, autoBuild });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

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
  child = Bun.spawn(
    [
      resolve(root, 'node_modules/.bin/vitest'),
      'run',
      '--config',
      'packages/web/vitest.config.ts',
      ...forwardedArgs,
    ],
    {
      cwd: root,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  code = await child.exited;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : code;
