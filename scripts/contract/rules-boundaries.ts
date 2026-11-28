import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ContractContext, RuleModule } from './context.js';

const BOUNDARY_RULES = [
  'web-server-import',
  'shared-import',
  'contract-import',
  'db-import',
  'core-import',
  'worker-import',
  'sandbox-import',
  'api-import',
  'core-browser-node',
  'file-cycle',
  'api-module-cycle',
  'worker-domain-cycle',
] as const;

const allowedWebCoreImports = new Set([
  '@agentport/core/workspace',
  '@agentport/core/plugin-display',
  '@agentport/core/record',
]);
const forbiddenWebPackages = [
  '@agentport/db',
  '@agentport/api',
  '@agentport/worker',
  '@agentport/sandbox',
];

const coreBrowserEntrypoints = [
  'packages/core/src/workspace.ts',
  'packages/core/src/plugin-display.ts',
  'packages/core/src/record.ts',
];

const apiDomainOf = (displayPath: string): string | undefined =>
  /^packages\/api\/src\/modules\/([^/]+)\//.exec(displayPath)?.[1];

const workerSubdomainOf = (displayPath: string): string | undefined =>
  /^packages\/worker\/src\/([^/]+)\//.exec(displayPath)?.[1];

function checkPackageBoundaries(ctx: ContractContext): void {
  if (ctx.hasRule('web-server-import')) {
    for (const file of ctx.webFiles) {
      for (const imp of ctx.getModuleImports(file)) {
        if (
          forbiddenWebPackages.some((pkg) => ctx.matchesPackage(imp.specifier, pkg)) ||
          (ctx.matchesPackage(imp.specifier, '@agentport/core') &&
            !allowedWebCoreImports.has(imp.specifier))
        ) {
          ctx.report(
            'web-server-import',
            `${ctx.rel(file)}:${imp.line}: web 禁止引入 ${imp.specifier}（只允许 @agentport/core/workspace、@agentport/core/plugin-display、@agentport/core/record、@agentport/shared 与 @agentport/contract）`,
          );
        }
      }
    }
  }

  if (ctx.hasRule('shared-import')) {
    for (const file of ctx.sharedFiles) {
      for (const imp of ctx.getModuleImports(file)) {
        if (
          imp.specifier.startsWith('node:') ||
          ctx.matchesPackage(imp.specifier, 'react') ||
          ctx.matchesPackage(imp.specifier, 'react-dom') ||
          imp.specifier.startsWith('@agentport/')
        ) {
          ctx.report(
            'shared-import',
            `${ctx.rel(file)}:${imp.line}: shared 禁止引入 ${imp.specifier}（packages/shared 只允许依赖 zod 与包内相对路径）`,
          );
        }
      }
    }
  }

  if (ctx.hasRule('contract-import')) {
    ctx.checkForbiddenImports(
      ctx.contractFiles,
      [
        '@agentport/db',
        '@agentport/api',
        '@agentport/worker',
        '@agentport/core',
        '@agentport/web',
        '@agentport/sandbox',
      ],
      (file, imp) =>
        ctx.report(
          'contract-import',
          `${ctx.rel(file)}:${imp.line}: contract 禁止引入 ${imp.specifier}（packages/contract 只允许依赖 @agentport/shared、zod 与 @orpc/contract）`,
        ),
    );
  }

  if (ctx.hasRule('db-import')) {
    ctx.checkForbiddenImports(
      ctx.dbFiles,
      [
        '@agentport/api',
        '@agentport/worker',
        '@agentport/contract',
        '@agentport/web',
        '@agentport/sandbox',
        'hono',
        'bullmq',
        'pg',
      ],
      (file, imp) =>
        ctx.report(
          'db-import',
          `${ctx.rel(file)}:${imp.line}: db 禁止引入 ${imp.specifier}（db 模块边界只使用 drizzle-orm/bun-sql，不引入路由、队列或 pg）`,
        ),
    );
  }

  if (ctx.hasRule('core-import')) {
    ctx.checkForbiddenImports(
      ctx.coreFiles,
      [
        '@agentport/db',
        '@agentport/api',
        '@agentport/worker',
        '@agentport/sandbox',
        '@agentport/contract',
        '@agentport/web',
      ],
      (file, imp) =>
        ctx.report(
          'core-import',
          `${ctx.rel(file)}:${imp.line}: core 禁止引入 ${imp.specifier}（packages/core 只允许依赖 @agentport/shared 与包内相对路径）`,
        ),
    );
  }

  if (ctx.hasRule('worker-import')) {
    ctx.checkForbiddenImports(
      ctx.workerFiles,
      ['@agentport/api', '@agentport/contract', '@agentport/web', '@agentport/sandbox'],
      (file, imp) =>
        ctx.report(
          'worker-import',
          `${ctx.rel(file)}:${imp.line}: worker 禁止引入 ${imp.specifier}（packages/worker 只允许依赖 @agentport/core、@agentport/db 与 @agentport/shared）`,
        ),
    );
  }

  if (ctx.hasRule('sandbox-import')) {
    ctx.checkForbiddenImports(
      ctx.sandboxFiles,
      [
        '@agentport/core',
        '@agentport/db',
        '@agentport/api',
        '@agentport/worker',
        '@agentport/contract',
        '@agentport/web',
      ],
      (file, imp) =>
        ctx.report(
          'sandbox-import',
          `${ctx.rel(file)}:${imp.line}: sandbox 禁止引入 ${imp.specifier}（packages/sandbox 只允许依赖 @agentport/shared）`,
        ),
    );
  }

  if (ctx.hasRule('api-import')) {
    ctx.checkForbiddenImports(
      ctx.apiFiles,
      ['@agentport/worker', '@agentport/sandbox', '@agentport/web'],
      (file, imp) =>
        ctx.report(
          'api-import',
          `${ctx.rel(file)}:${imp.line}: api 禁止引入 ${imp.specifier}（packages/api 只允许依赖 @agentport/contract、@agentport/core、@agentport/db 与 @agentport/shared）`,
        ),
    );
  }

  if (ctx.hasRule('core-browser-node')) {
    for (const entry of coreBrowserEntrypoints) {
      const fullPath = join(ctx.root, entry);
      if (!existsSync(fullPath)) continue;
      const code = ctx.readStripped(fullPath);
      for (const imp of ctx.getModuleImports(fullPath)) {
        if (imp.specifier.startsWith('node:')) {
          ctx.report(
            'core-browser-node',
            `${entry}:${imp.line}: 浏览器可达子路径禁引 Node 内建或 Buffer（${imp.specifier}）`,
          );
        }
      }
      for (const m of code.matchAll(/\bBuffer\b/g)) {
        if (m.index !== undefined) {
          ctx.report(
            'core-browser-node',
            `${entry}:${ctx.lineAt(code, m.index)}: 浏览器可达子路径禁引 Node 内建或 Buffer`,
          );
        }
      }
    }
  }
}

function checkDependencyCycles(ctx: ContractContext): void {
  if (!ctx.hasAnyRule(['file-cycle', 'api-module-cycle', 'worker-domain-cycle'])) return;

  const srcFileSet = new Set(ctx.allSrcFiles);
  const fileAdj = new Map<string, Set<string>>(ctx.allSrcFiles.map((file) => [file, new Set()]));
  const apiModuleAdj = new Map<string, Set<string>>();
  const workerDomainAdj = new Map<string, Set<string>>();

  for (const file of ctx.allSrcFiles) {
    const displayPath = ctx.rel(file);
    const apiDomain = apiDomainOf(displayPath);
    if (apiDomain && !apiModuleAdj.has(apiDomain)) apiModuleAdj.set(apiDomain, new Set());
    const workerSubdomain = workerSubdomainOf(displayPath);
    if (workerSubdomain && !workerDomainAdj.has(workerSubdomain)) {
      workerDomainAdj.set(workerSubdomain, new Set());
    }

    for (const imp of ctx.getModuleImports(file)) {
      const target = ctx.resolveModule(file, imp.specifier);
      if (!target || target === file || !srcFileSet.has(target)) continue;
      fileAdj.get(file)?.add(target);
      const targetPath = ctx.rel(target);
      const targetApiDomain = apiDomainOf(targetPath);
      if (apiDomain && targetApiDomain && apiDomain !== targetApiDomain) {
        apiModuleAdj.get(apiDomain)?.add(targetApiDomain);
      }
      const targetWorkerSubdomain = workerSubdomainOf(targetPath);
      if (workerSubdomain && targetWorkerSubdomain && workerSubdomain !== targetWorkerSubdomain) {
        workerDomainAdj.get(workerSubdomain)?.add(targetWorkerSubdomain);
      }
    }
  }

  for (const cycle of ctx.findCycles(ctx.allSrcFiles, fileAdj)) {
    ctx.report(
      'file-cycle',
      `发现文件级循环依赖：${cycle.map(ctx.rel).join(' -> ')}（拆分共享类型/纯函数到独立文件或下沉至下层包以消除循环）`,
    );
  }
  for (const cycle of ctx.findCycles([...apiModuleAdj.keys()], apiModuleAdj)) {
    ctx.report(
      'api-module-cycle',
      `发现 API 业务域循环依赖：${cycle.join(' -> ')}（将跨域共享逻辑下沉到 @agentport/db 或 @agentport/core，打破 modules/<domain> 环）`,
    );
  }
  for (const cycle of ctx.findCycles([...workerDomainAdj.keys()], workerDomainAdj)) {
    ctx.report(
      'worker-domain-cycle',
      `发现 Worker 子域循环依赖：${cycle.join(' -> ')}（将跨子域共享逻辑下沉到 @agentport/core、@agentport/db 或公共模块，打破子域环）`,
    );
  }
}

export const boundariesRulesModule: RuleModule = {
  rules: BOUNDARY_RULES,
  run(ctx) {
    checkPackageBoundaries(ctx);
    checkDependencyCycles(ctx);
  },
};
