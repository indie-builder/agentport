import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDistFresh, findStaleDistPackages } from './check-dist-fresh.js';

const tempRoots: string[] = [];

const createTempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentport-dist-fresh-'));
  tempRoots.push(dir);
  return dir;
};

const setupPackage = (
  root: string,
  pkg: string,
  opts: {
    withDist?: boolean;
    withExportTarget?: boolean;
    srcMtimeSec?: number;
    distMtimeSec?: number;
    tsbuildinfoMtimeSec?: number;
  } = {},
) => {
  const pkgDir = join(root, 'packages', pkg);
  const srcDir = join(pkgDir, 'src');
  const distDir = join(pkgDir, 'dist');
  mkdirSync(srcDir, { recursive: true });

  const pkgJsonPath = join(pkgDir, 'package.json');
  writeFileSync(
    pkgJsonPath,
    JSON.stringify({
      name: `@agentport/${pkg}`,
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
        './*': {
          types: './dist/*.d.ts',
          default: './dist/*.js',
        },
      },
    }),
  );

  const srcFile = join(srcDir, 'index.ts');
  writeFileSync(srcFile, 'export const value = 1;\n');

  const srcTime = opts.srcMtimeSec ?? 1_700_000_000;
  utimesSync(pkgJsonPath, srcTime, srcTime);
  utimesSync(srcFile, srcTime, srcTime);

  if (opts.withDist ?? true) {
    mkdirSync(distDir, { recursive: true });
    const distJs = join(distDir, 'index.js');
    writeFileSync(distJs, 'export const value = 1;\n');
    const distTime = opts.distMtimeSec ?? 1_700_000_100;
    utimesSync(distJs, distTime, distTime);

    if (opts.withExportTarget ?? true) {
      const distDts = join(distDir, 'index.d.ts');
      writeFileSync(distDts, 'export declare const value: number;\n');
      utimesSync(distDts, distTime, distTime);
    }
  }

  if (opts.tsbuildinfoMtimeSec !== undefined) {
    const infoPath = join(pkgDir, 'tsconfig.tsbuildinfo');
    writeFileSync(infoPath, '{}');
    utimesSync(infoPath, opts.tsbuildinfoMtimeSec, opts.tsbuildinfoMtimeSec);
  }
};

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('check-dist-fresh', () => {
  test('reports missing when dist directory does not exist', () => {
    const root = createTempRoot();
    setupPackage(root, 'shared', { withDist: false });
    expect(findStaleDistPackages(root, ['shared'])).toEqual([
      { pkg: 'shared', reason: 'missing', detail: 'dist' },
    ]);
  });

  test('reports missing when declared export target is absent in dist', () => {
    const root = createTempRoot();
    setupPackage(root, 'contract', { withDist: true, withExportTarget: false });
    expect(findStaleDistPackages(root, ['contract'])).toEqual([
      { pkg: 'contract', reason: 'missing', detail: './dist/index.d.ts' },
    ]);
  });

  test('reports stale when src file is newer than dist and tsbuildinfo', () => {
    const root = createTempRoot();
    setupPackage(root, 'core', {
      srcMtimeSec: 1_700_000_200,
      distMtimeSec: 1_700_000_100,
      tsbuildinfoMtimeSec: 1_700_000_150,
    });
    expect(findStaleDistPackages(root, ['core'])).toEqual([
      { pkg: 'core', reason: 'stale', detail: 'src/index.ts' },
    ]);
  });

  test('returns empty when dist or tsbuildinfo is newer than src', () => {
    const root = createTempRoot();
    setupPackage(root, 'shared', {
      srcMtimeSec: 1_700_000_100,
      distMtimeSec: 1_700_000_200,
    });
    setupPackage(root, 'db', {
      srcMtimeSec: 1_700_000_150,
      distMtimeSec: 1_700_000_100,
      tsbuildinfoMtimeSec: 1_700_000_200,
    });
    expect(findStaleDistPackages(root, ['shared', 'db'])).toEqual([]);
  });

  test('bypasses ensureDistFresh when AGENTPORT_DIST_FRESH_CHECKED=1 is set', () => {
    const root = createTempRoot();
    setupPackage(root, 'shared', { withDist: false });
    expect(() =>
      ensureDistFresh({
        root,
        packages: ['shared'],
        env: { AGENTPORT_DIST_FRESH_CHECKED: '1' },
      }),
    ).not.toThrow();

    expect(() =>
      ensureDistFresh({
        root,
        packages: ['shared'],
        env: {},
      }),
    ).toThrow('[dist-fresh] workspace 构建产物缺失或早于源码: shared (missing: dist)');
  });

  test('ignores non-build files like LICENSE while flagging ts and json changes', () => {
    const root = createTempRoot();
    setupPackage(root, 'shared', {
      srcMtimeSec: 1_700_000_100,
      distMtimeSec: 1_700_000_150,
    });
    const licensePath = join(root, 'packages', 'shared', 'src', 'LICENSE');
    writeFileSync(licensePath, 'MIT\n');
    utimesSync(licensePath, 1_700_000_300, 1_700_000_300);

    expect(findStaleDistPackages(root, ['shared'])).toEqual([]);

    const specJsonPath = join(root, 'packages', 'shared', 'src', 'spec.json');
    writeFileSync(specJsonPath, '{"v":1}\n');
    utimesSync(specJsonPath, 1_700_000_300, 1_700_000_300);

    expect(findStaleDistPackages(root, ['shared'])).toEqual([
      { pkg: 'shared', reason: 'stale', detail: 'src/spec.json' },
    ]);

    const indexPath = join(root, 'packages', 'shared', 'src', 'index.ts');
    utimesSync(indexPath, 1_700_000_400, 1_700_000_400);

    expect(findStaleDistPackages(root, ['shared'])).toEqual([
      { pkg: 'shared', reason: 'stale', detail: 'src/index.ts' },
    ]);
  });
});
