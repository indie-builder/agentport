import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const BACKEND_DIST_PACKAGES = ['shared', 'contract', 'core', 'db', 'sandbox'] as const;

export const WEB_DIST_PACKAGES = ['shared', 'contract', 'core'] as const;

export type StalePackage = {
  pkg: string;
  reason: 'missing' | 'stale';
  detail: string;
};

const collectDistExportTargets = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return (value.startsWith('./dist/') || value.startsWith('dist/')) && !value.includes('*')
      ? [value]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectDistExportTargets);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(collectDistExportTargets);
  }
  return [];
};

const readDistExportTargets = (pkgJsonPath: string): string[] => {
  if (!existsSync(pkgJsonPath)) return [];
  const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { exports?: unknown };
  return collectDistExportTargets(parsed.exports);
};

const SRC_INPUT_PATTERN = /\.(?:[cm]?[jt]sx?|json)$/;

const walkLatestMtime = (
  dir: string,
  baseDir: string,
  filePattern?: RegExp,
): { count: number; maxMtimeMs: number; newestPath: string } => {
  let count = 0;
  let maxMtimeMs = 0;
  let newestPath = '';
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && (!filePattern || filePattern.test(entry.name))) {
        count += 1;
        const mtimeMs = statSync(fullPath).mtimeMs;
        if (mtimeMs > maxMtimeMs) {
          maxMtimeMs = mtimeMs;
          newestPath = relative(baseDir, fullPath).replace(/\\/g, '/');
        }
      }
    }
  }

  return { count, maxMtimeMs, newestPath };
};

export const findStaleDistPackages = (
  root: string,
  packages: readonly string[],
): StalePackage[] => {
  const stale: StalePackage[] = [];

  for (const pkg of packages) {
    const pkgDir = join(root, 'packages', pkg);
    const distDir = join(pkgDir, 'dist');
    if (!existsSync(distDir)) {
      stale.push({ pkg, reason: 'missing', detail: 'dist' });
      continue;
    }

    const distStats = walkLatestMtime(distDir, pkgDir);
    if (distStats.count === 0) {
      stale.push({ pkg, reason: 'missing', detail: 'dist' });
      continue;
    }

    const exportTargets = readDistExportTargets(join(pkgDir, 'package.json'));
    const missingTarget = exportTargets.find((target) => !existsSync(join(pkgDir, target)));
    if (missingTarget) {
      stale.push({ pkg, reason: 'missing', detail: missingTarget });
      continue;
    }

    const srcDir = join(pkgDir, 'src');
    let latestSrcMtime = 0;
    let newestSrcPath = '';
    if (existsSync(srcDir)) {
      const srcStats = walkLatestMtime(srcDir, pkgDir, SRC_INPUT_PATTERN);
      latestSrcMtime = srcStats.maxMtimeMs;
      newestSrcPath = srcStats.newestPath;
    }

    for (const metaFile of ['package.json', 'tsconfig.json']) {
      const metaPath = join(pkgDir, metaFile);
      if (!existsSync(metaPath)) continue;
      const mtimeMs = statSync(metaPath).mtimeMs;
      if (mtimeMs > latestSrcMtime) {
        latestSrcMtime = mtimeMs;
        newestSrcPath = metaFile;
      }
    }

    const tsbuildinfoPath = join(pkgDir, 'tsconfig.tsbuildinfo');
    const tsbuildinfoMtime = existsSync(tsbuildinfoPath) ? statSync(tsbuildinfoPath).mtimeMs : 0;
    const latestBuildMtime = Math.max(distStats.maxMtimeMs, tsbuildinfoMtime);

    if (latestSrcMtime > latestBuildMtime + 50) {
      stale.push({ pkg, reason: 'stale', detail: newestSrcPath });
    }
  }

  return stale;
};

const formatStaleError = (stale: readonly StalePackage[]): string => {
  const list = stale.map((item) => `${item.pkg} (${item.reason}: ${item.detail})`).join(', ');
  return `[dist-fresh] workspace 构建产物缺失或早于源码: ${list}. 请先运行 bun run typecheck（或加 --auto-build / AGENTPORT_AUTO_BUILD=1）后再跑测试。`;
};

export const ensureDistFresh = (options: {
  root: string;
  packages: readonly string[];
  autoBuild?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): void => {
  const env = options.env ?? process.env;
  if (env.AGENTPORT_DIST_FRESH_CHECKED === '1' || env.AGENTPORT_SKIP_DIST_CHECK === '1') {
    return;
  }

  const initialStale = findStaleDistPackages(options.root, options.packages);
  if (initialStale.length === 0) {
    return;
  }

  if (options.autoBuild || env.AGENTPORT_AUTO_BUILD === '1') {
    const buildResult = Bun.spawnSync([process.execPath, 'run', 'typecheck'], {
      cwd: options.root,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (!buildResult.success) {
      throw new Error(
        `[dist-fresh] 自动构建失败 (exit ${buildResult.exitCode ?? 1})，请先手动执行 bun run typecheck。`,
      );
    }
    const remainingStale = findStaleDistPackages(options.root, options.packages);
    if (remainingStale.length === 0) {
      return;
    }
    throw new Error(formatStaleError(remainingStale));
  }

  throw new Error(formatStaleError(initialStale));
};
