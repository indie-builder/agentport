import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../../', import.meta.url);
const rootPath = Bun.fileURLToPath(root);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('build context and sandbox image', () => {
  it.skipIf(!existsSync(new URL('packages/shared/dist/index.js', root)))(
    'packs shared without src, tests or tsconfig',
    async () => {
      const out = mkdtempSync(join(tmpdir(), 'shared-deploy-'));
      try {
        execFileSync('bun', ['pm', 'pack', '--destination', out], {
          cwd: join(rootPath, 'packages/shared'),
          stdio: 'pipe',
        });
        const archive = readdirSync(out).find((entry) => entry.endsWith('.tgz'));
        if (archive === undefined) throw new Error('shared archive was not produced');
        execFileSync('tar', ['-xzf', join(out, archive), '-C', out]);
        const packed = join(out, 'package');
        expect(readdirSync(packed).sort()).toEqual(['dist', 'package.json']);
        expect(
          JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8')).dependencies.zod,
        ).toBe(JSON.parse(read('package.json')).workspaces.catalog.zod);
        cpSync(join(rootPath, 'packages/shared/node_modules'), join(packed, 'node_modules'), {
          recursive: true,
          dereference: true,
        });

        const deployed = await import(Bun.pathToFileURL(join(packed, 'dist/index.js')).href);
        expect(deployed.agentDuplicateInputSchema.safeParse({}).success).toBe(false);
        expect(deployed.agentDuplicateInputSchema.safeParse({ slug: 'x', name: 'x' }).success).toBe(
          true,
        );
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
  );

  it('builds the sandbox target everywhere the image is produced', () => {
    expect(read('scripts/up.sh')).toContain('docker build --target sandbox');
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
});
