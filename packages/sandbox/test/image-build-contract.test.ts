import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const rootPath = fileURLToPath(root);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('build context and sandbox image', () => {
  it('produces api and sandbox images from one root Dockerfile', () => {
    const dockerfile = read('Dockerfile');
    const stages = [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gm)].map((match) => match[1]);
    expect(stages).toContain('sandbox');
    // docker build . must keep producing the api/worker image; sandbox needs --target.
    expect(stages.at(-1)).toBe('runtime');
    expect(dockerfile).toContain('pnpm --filter @agentport/sandbox deploy --prod /out/sandbox');
    // Worker reuses the image with an explicit supervisor entrypoint, but the default stays runner.
    expect(dockerfile).toContain('test -f dist/session-supervisor.js');
    expect(dockerfile).toContain('ENTRYPOINT ["node", "dist/runner.js"]');
  });

  it.skipIf(!existsSync(new URL('packages/shared/dist/index.js', root)))(
    'deploys shared without src, tests or tsconfig',
    async () => {
      const out = mkdtempSync(join(tmpdir(), 'shared-deploy-'));
      try {
        execFileSync('pnpm', ['--filter', './packages/shared', 'deploy', '--prod', out], {
          cwd: rootPath,
          stdio: 'pipe',
        });

        // pnpm deploy adds its own lock/workspace files beside the packed manifest.
        const allowed = new Set([
          'dist',
          'node_modules',
          'package.json',
          'pnpm-lock.yaml',
          'pnpm-workspace.yaml',
        ]);
        expect(readdirSync(out).filter((entry) => !allowed.has(entry))).toEqual([]);

        const deployed = await import(pathToFileURL(join(out, 'dist/index.js')).href);
        expect(deployed.agentDuplicateInputSchema.safeParse({}).success).toBe(false);
        expect(deployed.agentDuplicateInputSchema.safeParse({ slug: 'x', name: 'x' }).success).toBe(
          true,
        );
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
  );

  it('removes the standalone sandbox manifests and shared staging', () => {
    for (const path of [
      'packages/sandbox/Dockerfile',
      'packages/sandbox/.dockerignore',
      'packages/sandbox/package.docker.json',
      'packages/sandbox/package.docker-lock.json',
      'packages/sandbox/package.shared.json',
    ]) {
      expect(existsSync(new URL(path, root)), path).toBe(false);
    }
    expect(read('scripts/up.sh')).not.toContain('packages/sandbox/shared');
    expect(read('.github/workflows/ci.yml')).not.toContain('packages/sandbox/shared');
    expect(read('.github/workflows/release.yml')).not.toContain('packages/sandbox/shared');
  });

  it('builds the sandbox target everywhere the image is produced', () => {
    expect(read('scripts/up.sh')).toContain('docker build --target sandbox');
    expect(read('.github/workflows/ci.yml')).toContain('docker build --target sandbox');
    expect(read('.github/workflows/release.yml')).toContain('target: sandbox');
    expect(read('packages/sandbox/package.json')).toContain('--target sandbox');
  });

  it('keeps runtime data and repo tooling out of the build context', () => {
    const ignore = read('.dockerignore');
    for (const entry of ['.git', '.claude', '.agents', 'backups', '.e2e']) {
      expect(ignore.split('\n'), entry).toContain(entry);
    }
    expect(ignore).not.toMatch(/^packages\/?$/m);
  });

  it('uses compose native waiting instead of script polling', () => {
    const up = read('scripts/up.sh');
    expect(up).toContain('--wait');
    expect(up).not.toContain('docker compose ps --format');
    // One-shot migrate must be removed first so every up run re-applies it.
    expect(up).toContain('rm -sf migrate');
  });
});
