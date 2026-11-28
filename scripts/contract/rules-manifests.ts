import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ContractContext, RuleModule } from './context.js';

const MANIFEST_RULES = [
  'node-version-lock',
  'catalog-shared-deps',
  'dockerfile-workspace-sync',
] as const;

const node24VersionRe =
  /^(?:[\^~]?24(?:\.(?:\d+(?:\.(?:\d+|x|X|\*))?|x|X|\*))?|>=24(?:\.\d+){0,2}\s+<25(?:\.0){0,2})$/;
const dockerNodeFromRe = /^\s*FROM\s+(?:--\S+\s+)*(?:[^\s/]+\/)*node(?::|@|\s|$)/i;
const dockerNode24FromRe = /^\s*FROM\s+(?:--\S+\s+)*(?:[^\s/]+\/)*node:24(?:\.\d+)*(?:-|\s|@|$)/i;
const nodeLockReason = 'Node.js 与 @types/node 永久锁定 24.x，禁止升级到 26+';
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

type ManifestRecord = {
  engines?: { node?: unknown };
  workspaces?: { catalog?: Record<string, unknown> };
  overrides?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
};

type SharedDepUse = {
  pkgDir: string;
  pkgPath: string;
  field: string;
  version: unknown;
};

function checkDirectTypesNode(
  ctx: ContractContext,
  manifestPath: string,
  manifest: ManifestRecord,
): void {
  for (const field of dependencyFields) {
    const version = manifest[field]?.['@types/node'];
    if (
      version !== undefined &&
      (typeof version !== 'string' || (version !== 'catalog:' && !node24VersionRe.test(version)))
    ) {
      ctx.report(
        'node-version-lock',
        `${ctx.rel(manifestPath)}: ${field}["@types/node"] 为 ${JSON.stringify(version)}（${nodeLockReason}，改为 catalog: 或 24.x 版本）`,
      );
    }
  }
}

function checkManifestsAndCatalog(ctx: ContractContext): void {
  if (!ctx.hasAnyRule(['node-version-lock', 'catalog-shared-deps'])) return;

  const rootPackagePath = join(ctx.root, 'package.json');
  let rootPkg: ManifestRecord | null = null;
  if (existsSync(rootPackagePath)) {
    rootPkg = JSON.parse(ctx.read(rootPackagePath)) as ManifestRecord;
    const nodeEngine = rootPkg?.engines?.node;
    if (typeof nodeEngine !== 'string' || !node24VersionRe.test(nodeEngine)) {
      ctx.report(
        'node-version-lock',
        `package.json: engines.node 为 ${JSON.stringify(nodeEngine)}（${nodeLockReason}，须锁定为 24.x 如 ">=24.22.2 <25"）`,
      );
    }
    const catalogTypesNode = rootPkg?.workspaces?.catalog?.['@types/node'];
    if (
      catalogTypesNode !== undefined &&
      (typeof catalogTypesNode !== 'string' || !node24VersionRe.test(catalogTypesNode))
    ) {
      ctx.report(
        'node-version-lock',
        `package.json: workspaces.catalog["@types/node"] 为 ${JSON.stringify(catalogTypesNode)}（${nodeLockReason}，须锁定为 24.x）`,
      );
    }
    const overridesTypesNode = rootPkg?.overrides?.['@types/node'];
    if (
      overridesTypesNode !== undefined &&
      (typeof overridesTypesNode !== 'string' ||
        (overridesTypesNode !== 'catalog:' && !node24VersionRe.test(overridesTypesNode)))
    ) {
      ctx.report(
        'node-version-lock',
        `package.json: overrides["@types/node"] 为 ${JSON.stringify(overridesTypesNode)}（${nodeLockReason}，须锁定为 24.x）`,
      );
    }
    checkDirectTypesNode(ctx, rootPackagePath, rootPkg);
  }

  const sharedDepUses = new Map<string, SharedDepUse[]>();
  if (existsSync(ctx.packagesDir)) {
    for (const name of readdirSync(ctx.packagesDir).sort()) {
      const pkgJsonPath = join(ctx.packagesDir, name, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      const pkg = JSON.parse(ctx.read(pkgJsonPath)) as ManifestRecord;
      const pkgNodeEngine = pkg?.engines?.node;
      if (
        pkgNodeEngine !== undefined &&
        (typeof pkgNodeEngine !== 'string' || !node24VersionRe.test(pkgNodeEngine))
      ) {
        ctx.report(
          'node-version-lock',
          `${ctx.rel(pkgJsonPath)}: engines.node 为 ${JSON.stringify(pkgNodeEngine)}（${nodeLockReason}，须锁定为 24.x）`,
        );
      }
      checkDirectTypesNode(ctx, pkgJsonPath, pkg);
      for (const field of dependencyFields) {
        const deps = pkg?.[field];
        if (!deps || typeof deps !== 'object') continue;
        for (const [dep, version] of Object.entries(deps)) {
          if (typeof version === 'string' && version.startsWith('workspace:')) continue;
          const uses = sharedDepUses.get(dep) ?? [];
          uses.push({ pkgDir: name, pkgPath: ctx.rel(pkgJsonPath), field, version });
          sharedDepUses.set(dep, uses);
        }
      }
    }
  }

  const rootCatalog =
    rootPkg?.workspaces?.catalog && typeof rootPkg.workspaces.catalog === 'object'
      ? rootPkg.workspaces.catalog
      : {};
  for (const [dep, uses] of [...sharedDepUses.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const pkgCount = new Set(uses.map((use) => use.pkgDir)).size;
    if (pkgCount < 2) continue;
    for (const use of uses) {
      if (use.version !== 'catalog:') {
        ctx.report(
          'catalog-shared-deps',
          `${use.pkgPath}: ${use.field}["${dep}"] 为 ${JSON.stringify(use.version)}（共享依赖出现在 ${pkgCount} 个子包中，须在根 package.json workspaces.catalog 声明并在各子包统一使用 "catalog:"）`,
        );
      }
    }
    const catalogVersion = rootCatalog[dep];
    if (typeof catalogVersion !== 'string' || catalogVersion.trim() === '') {
      ctx.report(
        'catalog-shared-deps',
        `package.json: workspaces.catalog 缺少共享依赖 "${dep}"（已在 ${pkgCount} 个子包中使用，须在根 workspaces.catalog 中声明版本）`,
      );
    }
  }
}

function checkDockerfile(ctx: ContractContext): void {
  const checkNode = ctx.hasRule('node-version-lock');
  const checkSync = ctx.hasRule('dockerfile-workspace-sync');
  if (!checkNode && !checkSync) return;

  const dockerfilePath = join(ctx.root, 'Dockerfile');
  if (!existsSync(dockerfilePath)) return;

  const lines = ctx.read(dockerfilePath).split('\n');
  let hasPackageCopy = false;
  const copiedManifestPackages = new Set<string>();
  const referencedPackages: { pkg: string; line: number }[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    if (checkNode && dockerNodeFromRe.test(line) && !dockerNode24FromRe.test(line)) {
      ctx.report(
        'node-version-lock',
        `Dockerfile:${lineNo}: ${line.trim()}（${nodeLockReason}，须使用 node:24 镜像）`,
      );
    }
    if (!checkSync) continue;

    const copyMatch = /^\s*COPY\s+(.+)$/i.exec(line);
    if (!copyMatch?.[1]) continue;

    const tokens = copyMatch[1].trim().split(/\s+/);
    const flags: string[] = [];
    const pathTokens: string[] = [];
    for (const token of tokens) {
      if (pathTokens.length === 0 && token.startsWith('--')) {
        flags.push(token);
      } else {
        pathTokens.push(token);
      }
    }
    if (pathTokens.length < 2) continue;

    const sources = pathTokens.slice(0, -1);
    const dest = pathTokens.at(-1);
    const hasFromFlag = flags.some((flag) => flag.toLowerCase().startsWith('--from='));

    if (hasFromFlag) {
      for (const source of sources) {
        const pkgMatch = /(?:^|\/)packages\/([^/]+)\//.exec(source);
        if (pkgMatch?.[1]) {
          referencedPackages.push({ pkg: pkgMatch[1], line: lineNo });
        }
      }
      continue;
    }

    for (const source of sources) {
      const manifestMatch = /^packages\/([^/]+)\/package\.json$/.exec(source);
      if (manifestMatch?.[1]) {
        hasPackageCopy = true;
        copiedManifestPackages.add(manifestMatch[1]);
        referencedPackages.push({ pkg: manifestMatch[1], line: lineNo });
      } else if (
        !source.startsWith('packages/') &&
        !source.includes('*') &&
        !source.includes('?') &&
        (dest === '.' || dest === './')
      ) {
        if (!existsSync(join(ctx.root, source))) {
          ctx.report(
            'dockerfile-workspace-sync',
            `Dockerfile:${lineNo}: COPY 的根文件 ${source} 不存在`,
          );
        }
      }
    }
  }

  if (checkSync && (hasPackageCopy || referencedPackages.length > 0)) {
    const workspacePackages = new Set<string>();
    if (existsSync(ctx.packagesDir)) {
      for (const name of readdirSync(ctx.packagesDir).sort()) {
        if (existsSync(join(ctx.packagesDir, name, 'package.json'))) {
          workspacePackages.add(name);
        }
      }
    }
    if (hasPackageCopy) {
      for (const pkg of [...workspacePackages].sort()) {
        if (!copiedManifestPackages.has(pkg)) {
          ctx.report(
            'dockerfile-workspace-sync',
            `Dockerfile: 缺少子包 packages/${pkg}/package.json 的 COPY 声明`,
          );
        }
      }
    }
    for (const ref of referencedPackages) {
      if (!workspacePackages.has(ref.pkg)) {
        ctx.report(
          'dockerfile-workspace-sync',
          `Dockerfile:${ref.line}: 引用了不存在的子包 packages/${ref.pkg}`,
        );
      }
    }
  }
}

export const manifestsRulesModule: RuleModule = {
  rules: MANIFEST_RULES,
  run(ctx) {
    checkManifestsAndCatalog(ctx);
    checkDockerfile(ctx);
  },
};
