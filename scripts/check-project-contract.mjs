import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';

const ROOT = process.cwd();
const problems = [];
const report = (rule, message) => problems.push(`[${rule}] ${message}`);

/** @param {string} dir @param {RegExp} ext */
function walk(dir, ext) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, ext));
    else if (ext.test(name)) out.push(full);
  }
  return out;
}

const rel = (p) => relative(ROOT, p);
const fileSources = new Map();
const read = (p) => {
  if (!fileSources.has(p)) fileSources.set(p, readFileSync(p, 'utf8'));
  return fileSources.get(p);
};
const lineAt = (src, index) => src.slice(0, index).split('\n').length;

function skipBalancedBraces(src, i) {
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(src, i, c);
      continue;
    }
    if (c === '`') {
      i = scanTemplateLiteral(src, i).end;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  return i;
}

function skipQuoted(src, i, quote) {
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

function scanTemplateLiteral(src, start) {
  let i = start + 1;
  let staticText = '';
  let exprText = '';
  const expressions = [];
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      staticText += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '`') {
      return { end: i + 1, staticText, exprText, expressions };
    }
    if (ch === '$' && src[i + 1] === '{') {
      i += 2;
      const exprStart = i;
      i = skipBalancedBraces(src, i);
      const expr = src.slice(exprStart, i - 1);
      expressions.push({ expr, index: exprStart });
      exprText += ` ${expr} `;
      staticText += ' ';
      continue;
    }
    staticText += ch;
    i += 1;
  }
  return { end: i, staticText, exprText, expressions };
}

function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '\\' && next === '/') {
      out += ch + next;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < src.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(src, i, ch);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '`') {
      const tpl = scanTemplateLiteral(src, i);
      out += src.slice(i, tpl.end);
      i = tpl.end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const strippedSources = new Map();
const readStripped = (p) => {
  if (!strippedSources.has(p)) strippedSources.set(p, stripComments(read(p)));
  return strippedSources.get(p);
};
const modules = new Map();

function readModule(file) {
  if (!modules.has(file)) {
    const ast = parse(read(file), {
      sourceFilename: file,
      sourceType: 'module',
      plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
    });
    traverse(ast, {
      Program(path) {
        modules.set(file, { ast, program: path });
        path.stop();
      },
    });
  }
  return modules.get(file);
}

const nameOf = (node) => (node.type === 'Identifier' ? node.name : node.value);

function importedBinding(binding) {
  const path = binding?.path;
  if (!path?.isImportSpecifier() || path.node.importKind === 'type') return;
  const declaration = path.parent;
  if (declaration.importKind === 'type') return;
  return { source: declaration.source.value, name: nameOf(path.node.imported) };
}

function unwrapExpression(node) {
  while (
    node?.type === 'TSAsExpression' ||
    node?.type === 'TSSatisfiesExpression' ||
    node?.type === 'TSNonNullExpression' ||
    node?.type === 'ParenthesizedExpression'
  ) {
    node = node.expression;
  }
  return node;
}

function unwrapNodePath(path) {
  while (
    path.isTSAsExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isTSNonNullExpression() ||
    path.isParenthesizedExpression()
  ) {
    path = path.get('expression');
  }
  return path;
}

function stringLiteral(node) {
  node = unwrapExpression(node);
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
}

function isMember(node, name) {
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return false;
  if (!node.computed) return node.property.type === 'Identifier' && node.property.name === name;
  if (node.property.type === 'StringLiteral') return node.property.value === name;
  return (
    node.property.type === 'TemplateLiteral' &&
    node.property.expressions.length === 0 &&
    node.property.quasis[0].value.cooked === name
  );
}

function isUnboundGlobalOrMember(path, name) {
  path = unwrapNodePath(path);
  if (path.isIdentifier() && path.node.name === name) {
    return !path.scope.getBinding(name);
  }
  if (
    (path.isMemberExpression() || path.isOptionalMemberExpression()) &&
    isMember(path.node, name)
  ) {
    const obj = unwrapNodePath(path.get('object'));
    return (
      obj.isIdentifier() && obj.node.name === 'globalThis' && !obj.scope.getBinding('globalThis')
    );
  }
  return false;
}

function extractModuleImports(file) {
  const imports = [];
  const push = (specifier, line, isTypeOnly, isDynamic) => {
    if (specifier !== undefined) imports.push({ specifier, line, isTypeOnly, isDynamic });
  };
  traverse(readModule(file).ast, {
    ImportDeclaration(path) {
      const { importKind, specifiers, source, loc } = path.node;
      const isTypeOnly =
        importKind === 'type' ||
        (specifiers.length > 0 &&
          specifiers.every((spec) => spec.type === 'ImportSpecifier' && spec.importKind === 'type'));
      push(source.value, loc.start.line, isTypeOnly, false);
    },
    ExportNamedDeclaration(path) {
      const { exportKind, specifiers, source, loc } = path.node;
      if (!source) return;
      const isTypeOnly =
        exportKind === 'type' ||
        (specifiers.length > 0 && specifiers.every((spec) => spec.exportKind === 'type'));
      push(source.value, loc.start.line, isTypeOnly, false);
    },
    ExportAllDeclaration(path) {
      const { exportKind, source, loc } = path.node;
      push(source.value, loc.start.line, exportKind === 'type', false);
    },
    TSImportEqualsDeclaration(path) {
      const { importKind, moduleReference, loc } = path.node;
      if (moduleReference.type === 'TSExternalModuleReference') {
        push(moduleReference.expression.value, loc.start.line, importKind === 'type', false);
      }
    },
    ImportExpression(path) {
      push(stringLiteral(path.node.source), path.node.loc.start.line, false, true);
    },
    TSImportType(path) {
      push(stringLiteral(path.node.source), path.node.loc.start.line, true, false);
    },
    'CallExpression|OptionalCallExpression'(path) {
      if (!isUnboundGlobalOrMember(path.get('callee'), 'require')) return;
      push(stringLiteral(path.node.arguments[0]), path.node.loc.start.line, false, true);
    },
  });
  return imports;
}

const fileImports = new Map();
const getModuleImports = (p) => {
  if (!fileImports.has(p)) fileImports.set(p, extractModuleImports(p));
  return fileImports.get(p);
};

const matchesPackage = (spec, pkg) => spec === pkg || spec.startsWith(`${pkg}/`);

function ruleIds(source) {
  const ids = new Set();
  traverse(parse(source, { sourceType: 'module' }), {
    'CallExpression|OptionalCallExpression'(path) {
      const { callee, arguments: [id], loc } = path.node;
      if (callee.type === 'Identifier' && callee.name === 'report') {
        if (id?.type !== 'StringLiteral') {
          throw new Error(`report 缺少静态规则 ID（第 ${loc.start.line} 行）`);
        }
        ids.add(id.value);
      }
      if (
        isMember(callee, 'push') &&
        callee.object.type === 'Identifier' &&
        callee.object.name === 'problems' &&
        path.scope.getProgramParent().getBinding('report')?.path.node.init?.body !== path.node
      ) {
        throw new Error(`请通过 report 添加诊断（第 ${loc.start.line} 行）`);
      }
    },
  });
  return [...ids].sort();
}

if (process.argv[2] === '--rule-ids') {
  console.log(JSON.stringify(ruleIds(read(import.meta.path))));
  process.exit(0);
}

const webFiles = walk(join(ROOT, 'packages/web/src'), /\.(ts|tsx)$/);
const apiFiles = walk(join(ROOT, 'packages/api/src'), /\.(ts|tsx)$/);
const workerFiles = walk(join(ROOT, 'packages/worker/src'), /\.(ts|tsx)$/);
const coreFiles = walk(join(ROOT, 'packages/core/src'), /\.ts$/);
const sharedFiles = walk(join(ROOT, 'packages/shared/src'), /\.ts$/);
const contractFiles = walk(join(ROOT, 'packages/contract/src'), /\.ts$/);
const dbFiles = walk(join(ROOT, 'packages/db/src'), /\.ts$/);
const dbSchemaFiles = walk(join(ROOT, 'packages/db/src/schema'), /\.ts$/);
const sandboxFiles = walk(join(ROOT, 'packages/sandbox/src'), /\.(ts|tsx)$/);
const packagesDir = join(ROOT, 'packages');
const allSrcFiles = existsSync(packagesDir)
  ? readdirSync(packagesDir)
      .sort()
      .flatMap((name) => walk(join(packagesDir, name, 'src'), /\.(ts|tsx)$/))
  : [];

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

for (const file of webFiles) {
  for (const imp of getModuleImports(file)) {
    if (matchesPackage(imp.specifier, '@radix-ui') || matchesPackage(imp.specifier, '@base-ui')) {
      report(
        'web-banned-primitive',
        `${rel(file)}:${imp.line}: 引入 ${imp.specifier}（改用 @ui-sdk/react 或 packages/web/src/components/ui/）`,
      );
    }
    if (
      forbiddenWebPackages.some((pkg) => matchesPackage(imp.specifier, pkg)) ||
      (matchesPackage(imp.specifier, '@agentport/core') && !allowedWebCoreImports.has(imp.specifier))
    ) {
      report(
        'web-server-import',
        `${rel(file)}:${imp.line}: web 禁止引入 ${imp.specifier}（只允许 @agentport/core/workspace、@agentport/core/plugin-display、@agentport/core/record、@agentport/shared 与 @agentport/contract）`,
      );
    }
  }
}

for (const file of sharedFiles) {
  for (const imp of getModuleImports(file)) {
    if (
      imp.specifier.startsWith('node:') ||
      matchesPackage(imp.specifier, 'react') ||
      matchesPackage(imp.specifier, 'react-dom') ||
      imp.specifier.startsWith('@agentport/')
    ) {
      report(
        'shared-import',
        `${rel(file)}:${imp.line}: shared 禁止引入 ${imp.specifier}（packages/shared 只允许依赖 zod 与包内相对路径）`,
      );
    }
  }
}

function checkForbiddenImports(files, forbiddenPackages, onViolation) {
  for (const file of files) {
    for (const imp of getModuleImports(file)) {
      if (forbiddenPackages.some((pkg) => matchesPackage(imp.specifier, pkg))) {
        onViolation(file, imp);
      }
    }
  }
}

checkForbiddenImports(
  contractFiles,
  [
    '@agentport/db',
    '@agentport/api',
    '@agentport/worker',
    '@agentport/core',
    '@agentport/web',
    '@agentport/sandbox',
  ],
  (file, imp) =>
    report(
      'contract-import',
      `${rel(file)}:${imp.line}: contract 禁止引入 ${imp.specifier}（packages/contract 只允许依赖 @agentport/shared、zod 与 @orpc/contract）`,
    ),
);

checkForbiddenImports(
  dbFiles,
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
    report(
      'db-import',
      `${rel(file)}:${imp.line}: db 禁止引入 ${imp.specifier}（db 模块边界只使用 drizzle-orm/bun-sql，不引入路由、队列或 pg）`,
    ),
);

checkForbiddenImports(
  coreFiles,
  [
    '@agentport/db',
    '@agentport/api',
    '@agentport/worker',
    '@agentport/sandbox',
    '@agentport/contract',
    '@agentport/web',
  ],
  (file, imp) =>
    report(
      'core-import',
      `${rel(file)}:${imp.line}: core 禁止引入 ${imp.specifier}（packages/core 只允许依赖 @agentport/shared 与包内相对路径）`,
    ),
);

checkForbiddenImports(
  workerFiles,
  ['@agentport/api', '@agentport/contract', '@agentport/web', '@agentport/sandbox'],
  (file, imp) =>
    report(
      'worker-import',
      `${rel(file)}:${imp.line}: worker 禁止引入 ${imp.specifier}（packages/worker 只允许依赖 @agentport/core、@agentport/db 与 @agentport/shared）`,
    ),
);

checkForbiddenImports(
  sandboxFiles,
  [
    '@agentport/core',
    '@agentport/db',
    '@agentport/api',
    '@agentport/worker',
    '@agentport/contract',
    '@agentport/web',
  ],
  (file, imp) =>
    report(
      'sandbox-import',
      `${rel(file)}:${imp.line}: sandbox 禁止引入 ${imp.specifier}（packages/sandbox 只允许依赖 @agentport/shared）`,
    ),
);

checkForbiddenImports(
  apiFiles,
  ['@agentport/worker', '@agentport/sandbox', '@agentport/web'],
  (file, imp) =>
    report(
      'api-import',
      `${rel(file)}:${imp.line}: api 禁止引入 ${imp.specifier}（packages/api 只允许依赖 @agentport/contract、@agentport/core、@agentport/db 与 @agentport/shared）`,
    ),
);

const routerRe = /^packages\/api\/src\/modules\/[^/]+\/router\.ts$/;
const routerSafeParseRe = /\binput\.(params|query|body)\.safeParse\b/g;
for (const file of apiFiles) {
  if (!routerRe.test(rel(file))) continue;
  const code = readStripped(file);
  for (const m of code.matchAll(routerSafeParseRe)) {
    report(
      'router-safe-parse',
      `${rel(file)}:${lineAt(code, m.index)}: router 内对 input.${m[1]} 使用 safeParse（校验只在 @agentport/contract 的 input schema 完成，不在 router.ts 重复 safeParse）`,
    );
  }
}

for (const file of [...apiFiles, ...workerFiles]) {
  for (const imp of getModuleImports(file)) {
    if (!matchesPackage(imp.specifier, 'pino')) continue;
    if (imp.isDynamic) {
      report(
        'pino-dynamic',
        `${rel(file)}:${imp.line}: 动态引入 pino（改用 @agentport/core/logger 的 createServiceLogger / requestScopedLogger / runScopedLogger）`,
      );
    } else if (!imp.isTypeOnly) {
      report(
        'pino-static',
        `${rel(file)}:${imp.line}: 直接引入 pino 值（改用 @agentport/core/logger 的 createServiceLogger / requestScopedLogger / runScopedLogger）`,
      );
    }
  }
}

const apiInfraDirRe = /^packages\/api\/src\/(http|lib|queue)\//;
const apiRouterTargetRe = /^packages\/api\/src\/modules\/[^/]+\/router(?:\.(?:ts|js|tsx|jsx))?$/;

function resolveApiSpecPath(file, specifier) {
  const resolved = resolveModule(file, specifier);
  if (resolved) return rel(resolved);
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return rel(join(dirname(file), specifier));
  }
  const ws = /^@agentport\/api(?:\/(.+))?$/.exec(specifier);
  if (ws) return `packages/api/src/${ws[1] ?? 'index'}`;
  return null;
}

for (const file of apiFiles) {
  const displayPath = rel(file);
  const isInfra = apiInfraDirRe.test(displayPath);
  const isRoutesIndex = displayPath === 'packages/api/src/routes/index.ts';
  const isBodyLimitWrapper = displayPath === 'packages/api/src/http/body-limit.ts';

  for (const imp of getModuleImports(file)) {
    const targetRel = resolveApiSpecPath(file, imp.specifier);
    if (
      isInfra &&
      targetRel &&
      (targetRel === 'packages/api/src/modules' || targetRel.startsWith('packages/api/src/modules/'))
    ) {
      report(
        'api-http-no-module-import',
        `${displayPath}:${imp.line}: 基础设施层禁止引入业务模块 ${imp.specifier}（将共享能力下沉到 http/、lib/、@agentport/core 或 @agentport/db）`,
      );
    }
    if (!isRoutesIndex && targetRel && apiRouterTargetRe.test(targetRel)) {
      report(
        'api-no-cross-router-import',
        `${displayPath}:${imp.line}: 禁止在 routes/index.ts 之外导入 ${imp.specifier}（路由装配集中于 packages/api/src/routes/index.ts，共享逻辑抽取到同模块 helper 或 @agentport/core/@agentport/db）`,
      );
    }
    if (!isBodyLimitWrapper && matchesPackage(imp.specifier, 'hono/body-limit')) {
      report(
        'api-no-raw-hono-bodylimit',
        `${displayPath}:${imp.line}: 禁止直接导入 ${imp.specifier}（改用 packages/api/src/http/body-limit.ts 的 requestBodyLimit）`,
      );
    }
  }
}

const errorFiles = [
  ...apiFiles,
  ...workerFiles,
  ...coreFiles,
  ...sharedFiles,
  ...contractFiles,
].filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));

function resolveSourceTarget(base) {
  const extension = extname(base);
  const candidates =
    extension === '.js'
      ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`]
      : extension === '.jsx'
        ? [`${base.slice(0, -4)}.tsx`, `${base.slice(0, -4)}.ts`]
        : extension === '.ts' || extension === '.tsx'
          ? [base]
          : [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function resolveModule(file, specifier) {
  const workspace = /^@agentport\/([^/]+)(?:\/(.+))?$/.exec(specifier);
  if (workspace) {
    return resolveSourceTarget(
      join(ROOT, 'packages', workspace[1], 'src', workspace[2] ?? 'index'),
    );
  }
  if (specifier.startsWith('@/') && rel(file).startsWith('packages/web/src/')) {
    return resolveSourceTarget(join(ROOT, 'packages/web/src', specifier.slice(2)));
  }
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return;
  return resolveSourceTarget(join(dirname(file), specifier));
}

function findStronglyConnectedComponents(nodes, adj) {
  let nextIndex = 0;
  const indices = new Map();
  const lowlink = new Map();
  const stack = [];
  const onStack = new Set();
  const sccs = [];

  function strongConnect(v) {
    indices.set(v, nextIndex);
    lowlink.set(v, nextIndex);
    nextIndex += 1;
    stack.push(v);
    onStack.add(v);

    const neighbors = [...(adj.get(v) ?? [])].sort();
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const comp = [];
      while (true) {
        const w = stack.pop();
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      if (comp.length > 1) sccs.push(comp.sort());
    }
  }

  for (const node of [...nodes].sort()) {
    if (!indices.has(node)) strongConnect(node);
  }
  return sccs.sort((a, b) => a[0].localeCompare(b[0]));
}

function findCyclePath(comp, adj) {
  const members = new Set(comp);
  const start = comp[0];
  const parent = new Map([[start, null]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i += 1) {
    const cur = queue[i];
    const neighbors = [...(adj.get(cur) ?? [])].filter((n) => members.has(n)).sort();
    for (const next of neighbors) {
      if (next === start) {
        const cycle = [start];
        let cursor = cur;
        while (cursor !== null) {
          cycle.unshift(cursor);
          cursor = parent.get(cursor) ?? null;
        }
        return cycle;
      }
      if (!parent.has(next)) {
        parent.set(next, cur);
        queue.push(next);
      }
    }
  }
  return [...comp, start];
}

const srcFileSet = new Set(allSrcFiles);
const fileAdj = new Map(allSrcFiles.map((file) => [file, new Set()]));
const apiModuleAdj = new Map();
const workerDomainAdj = new Map();

const apiDomainOf = (displayPath) => /^packages\/api\/src\/modules\/([^/]+)\//.exec(displayPath)?.[1];
const workerSubdomainOf = (displayPath) => /^packages\/worker\/src\/([^/]+)\//.exec(displayPath)?.[1];

for (const file of allSrcFiles) {
  const displayPath = rel(file);
  const apiDomain = apiDomainOf(displayPath);
  if (apiDomain && !apiModuleAdj.has(apiDomain)) apiModuleAdj.set(apiDomain, new Set());
  const workerSubdomain = workerSubdomainOf(displayPath);
  if (workerSubdomain && !workerDomainAdj.has(workerSubdomain)) {
    workerDomainAdj.set(workerSubdomain, new Set());
  }

  for (const imp of getModuleImports(file)) {
    const target = resolveModule(file, imp.specifier);
    if (!target || target === file || !srcFileSet.has(target)) continue;
    fileAdj.get(file).add(target);
    const targetPath = rel(target);
    const targetApiDomain = apiDomainOf(targetPath);
    if (apiDomain && targetApiDomain && apiDomain !== targetApiDomain) {
      apiModuleAdj.get(apiDomain).add(targetApiDomain);
    }
    const targetWorkerSubdomain = workerSubdomainOf(targetPath);
    if (workerSubdomain && targetWorkerSubdomain && workerSubdomain !== targetWorkerSubdomain) {
      workerDomainAdj.get(workerSubdomain).add(targetWorkerSubdomain);
    }
  }
}

for (const comp of findStronglyConnectedComponents(allSrcFiles, fileAdj)) {
  const cycle = findCyclePath(comp, fileAdj).map(rel);
  report(
    'file-cycle',
    `发现文件级循环依赖：${cycle.join(' -> ')}（拆分共享类型/纯函数到独立文件或下沉至下层包以消除循环）`,
  );
}
for (const comp of findStronglyConnectedComponents([...apiModuleAdj.keys()], apiModuleAdj)) {
  const cycle = findCyclePath(comp, apiModuleAdj);
  report(
    'api-module-cycle',
    `发现 API 业务域循环依赖：${cycle.join(' -> ')}（将跨域共享逻辑下沉到 @agentport/db 或 @agentport/core，打破 modules/<domain> 环）`,
  );
}
for (const comp of findStronglyConnectedComponents([...workerDomainAdj.keys()], workerDomainAdj)) {
  const cycle = findCyclePath(comp, workerDomainAdj);
  report(
    'worker-domain-cycle',
    `发现 Worker 子域循环依赖：${cycle.join(' -> ')}（将跨子域共享逻辑下沉到 @agentport/core、@agentport/db 或公共模块，打破子域环）`,
  );
}

function resolveExports(file, name, active = new Set()) {
  if (!file) return [null];
  const key = `${file}:${name}`;
  if (active.has(key)) return [];
  const next = new Set(active).add(key);
  const { program } = readModule(file);
  const binding = program.scope.getOwnBinding(name);
  const stars = [];
  for (const statement of program.node.body) {
    if (statement.exportKind === 'type') continue;
    if (statement.type === 'ExportAllDeclaration') {
      stars.push(statement.source.value);
      continue;
    }
    if (statement.type !== 'ExportNamedDeclaration') continue;
    if (statement.declaration && binding?.path.findParent((path) => path.node === statement)) {
      return [binding];
    }
    const specifier = statement.specifiers.find(
      (entry) => entry.exportKind !== 'type' && nameOf(entry.exported) === name,
    );
    if (!specifier) continue;
    if (specifier.type !== 'ExportSpecifier') return [specifier];
    const local = nameOf(specifier.local);
    if (statement.source) {
      return resolveExports(resolveModule(file, statement.source.value), local, next);
    }
    const localBinding = program.scope.getOwnBinding(local);
    const imported = importedBinding(localBinding);
    if (imported) {
      return resolveExports(resolveModule(file, imported.source), imported.name, next);
    }
    return localBinding ? [localBinding] : [];
  }
  const declarations = stars.flatMap((source) => resolveExports(resolveModule(file, source), name, next));
  return [...new Set(declarations)];
}

function isPromiseShaped(node) {
  const type = unwrapExpression(node)?.type;
  return (
    type === 'CallExpression' || type === 'OptionalCallExpression' || type === 'NewExpression'
  );
}

function staticMemberName(node) {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : undefined;
  if (node.property.type === 'StringLiteral') return node.property.value;
  if (node.property.type === 'TemplateLiteral' && node.property.expressions.length === 0) {
    return node.property.quasis[0].value.cooked;
  }
  return undefined;
}

function receiverIdentity(path) {
  const segments = [];
  let node = unwrapExpression(path.node);
  while (node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression') {
    const name = staticMemberName(node);
    if (name === undefined) return { root: `expr:${path.toString()}`, pathKey: '' };
    segments.unshift(name);
    node = unwrapExpression(node.object);
  }
  if (node?.type !== 'Identifier') return { root: `expr:${path.toString()}`, pathKey: '' };
  return {
    root: path.scope.getBinding(node.name) ?? `id:${node.name}`,
    pathKey: JSON.stringify(segments),
  };
}

function isZodExpression(path, seen = new Set()) {
  if (path.isCallExpression() || path.isOptionalCallExpression()) {
    return isZodExpression(path.get('callee'), seen);
  }
  if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
    return isZodExpression(path.get('object'), seen);
  }
  if (!path.isIdentifier()) return false;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding) return false;
  const imported = importedBinding(binding);
  if (imported?.source === 'zod' && imported.name === 'z') return true;
  const declaration = binding.path;
  if (!binding.constant || !declaration.isVariableDeclarator() || !declaration.get('id').isIdentifier()) {
    return false;
  }
  if (seen.has(binding)) return false;
  seen.add(binding);
  return isZodExpression(declaration.get('init'), seen);
}

const callsByMessage = new Map();
const errorFunctions = new Set(['fail', 'notFound']);
const coreErrors = join(ROOT, 'packages/core/src/errors.ts');
const mcpErrors = join(ROOT, 'packages/api/src/lib/mcp.ts');
for (const file of errorFiles) {
  const displayPath = rel(file);
  const scheduler =
    displayPath.startsWith('packages/worker/src/') &&
    (displayPath.endsWith('scheduler.ts') ||
      displayPath.endsWith('reconcile.ts') ||
      displayPath === 'packages/worker/src/data-domains/build.ts' ||
      displayPath === 'packages/worker/src/data-domains/enrich.ts' ||
      displayPath === 'packages/worker/src/integrations/deliver.ts');
  const inFlightAssignments = new Map();
  const noteInFlight = (root, pathKey, rhs, line) => {
    const byPath = inFlightAssignments.get(root) ?? new Map();
    const entry = byPath.get(pathKey) ?? { hasNull: false, nonNullLine: undefined };
    if (unwrapExpression(rhs)?.type === 'NullLiteral') entry.hasNull = true;
    else if (isPromiseShaped(rhs)) {
      entry.nonNullLine =
        entry.nonNullLine === undefined ? line : Math.min(entry.nonNullLine, line);
    }
    byPath.set(pathKey, entry);
    inFlightAssignments.set(root, byPath);
  };
  traverse(readModule(file).ast, {
    'VariableDeclarator|AssignmentExpression'(path) {
      if (!scheduler) return;
      if (path.isVariableDeclarator()) {
        const id = path.node.id;
        if (id.type !== 'Identifier' || id.name !== 'inFlight') return;
        const binding = path.scope.getBinding('inFlight');
        if (!binding) return;
        if (path.node.init) noteInFlight(binding, '', path.node.init, id.loc.start.line);
        for (const violation of binding.constantViolations) {
          if (
            violation.isAssignmentExpression() &&
            violation.node.left.type === 'Identifier' &&
            violation.node.left.name === 'inFlight'
          ) {
            noteInFlight(binding, '', violation.node.right, violation.node.left.loc.start.line);
          }
        }
        return;
      }
      const target = path.node.left;
      if (!isMember(target, 'inFlight')) return;
      const { root, pathKey } = receiverIdentity(path.get('left.object'));
      noteInFlight(root, pathKey, path.node.right, target.loc.start.line);
    },
    'CallExpression|OptionalCallExpression|NewExpression'(path) {
      const { callee, arguments: args, loc } = path.node;
      const line = loc.start.line;
      const identifier = callee.type === 'Identifier' ? callee.name : undefined;
      if (
        scheduler &&
        ((identifier === 'setInterval' && !path.scope.getBinding(identifier)) ||
          (isMember(callee, 'setInterval') &&
            callee.object.type === 'Identifier' &&
            callee.object.name === 'globalThis' &&
            !path.scope.getBinding('globalThis')))
      ) {
        report(
          'worker-scheduler-setinterval',
          `${displayPath}:${line}: 调度器直接调用 setInterval（改用 packages/worker/src/interval-ticker.ts 的 startIntervalTicker 管理定时与关停，双入口 sync 通过 packages/worker/src/scheduling/single-flight.ts 的 startSingleFlight 共用单飞守卫）`,
        );
      }

      let message = unwrapExpression(args[1]);
      if (!message) return;
      const binding = identifier ? path.scope.getBinding(identifier) : undefined;
      const imported = importedBinding(binding);
      if (path.isNewExpression()) {
        if (!imported) {
          if (
            file !== coreErrors ||
            !binding?.scope.path.isProgram() ||
            !binding.path.isClassDeclaration() ||
            identifier !== 'AppError'
          ) return;
        } else if (imported.source !== '@agentport/core' || imported.name !== 'AppError') {
          const declarations = resolveExports(resolveModule(file, imported.source), imported.name);
          const declaration = declarations.length === 1 ? declarations[0]?.path : undefined;
          if (
            !declaration?.isClassDeclaration() ||
            declaration.node.id?.name !== 'AppError' ||
            declaration.node.loc.filename !== coreErrors
          ) return;
        }
      } else if (identifier) {
        if (imported?.name === 'toolError') {
          if (resolveModule(file, imported.source) !== mcpErrors) return;
          const declarations = resolveExports(mcpErrors, imported.name);
          const declaration = declarations.length === 1 ? declarations[0]?.path : undefined;
          if (
            !declaration?.isFunctionDeclaration() ||
            declaration.node.id?.name !== 'toolError' ||
            declaration.node.loc.filename !== mcpErrors
          ) return;
        } else if (imported) {
          if (!errorFunctions.has(imported.name)) return;
          if (
            imported.source !== '@agentport/core' &&
            !(displayPath.startsWith('packages/core/src/') &&
              resolveModule(file, imported.source) === coreErrors)
          ) return;
        } else if (
          !errorFunctions.has(identifier) ||
          file !== coreErrors ||
          !binding?.scope.path.isProgram() ||
          !binding.path.isFunctionDeclaration()
        ) return;
      } else if (!isMember(callee, 'refine') || !isZodExpression(path.get('callee.object'))) {
        return;
      }

      while (message.type === 'LogicalExpression' && (message.operator === '??' || message.operator === '||')) {
        message = unwrapExpression(message.right);
      }
      let constant;
      if (message.type === 'Identifier') {
        let binding = path.scope.getBinding(message.name);
        const imported = importedBinding(binding);
        if (imported) {
          const declarations = resolveExports(resolveModule(file, imported.source), imported.name);
          binding = declarations.length === 1 ? declarations[0] : undefined;
        }
        if (
          binding?.constant &&
          binding.path.isVariableDeclarator() &&
          binding.path.node.id.type === 'Identifier' &&
          (!imported || binding.kind === 'const')
        ) {
          constant = binding.path.node;
        }
      }
      const value = stringLiteral(constant ? constant.init : message);
      if (value == null) return;
      const calls = callsByMessage.get(value) ?? [];
      calls.push({ constant, path: displayPath, line });
      callsByMessage.set(value, calls);
    },
  });
  for (const byPath of inFlightAssignments.values()) {
    for (const { hasNull, nonNullLine } of byPath.values()) {
      if (!hasNull || nonNullLine === undefined) continue;
      report(
        'worker-handrolled-single-flight',
        `${displayPath}:${nonNullLine}: 调度器手写 inFlight（改用 packages/worker/src/scheduling/single-flight.ts 的 startSingleFlight，对应 formal/scheduler-sync/SchedulerSync.tla 的单飞守卫 InFlight = {}）`,
      );
    }
  }
}
for (const [value, calls] of callsByMessage) {
  if (new Set(calls.map(({ path }) => path)).size < 2) continue;
  const constant = calls[0].constant;
  if (constant && calls.every((call) => call.constant === constant)) continue;
  const locations = [...new Set(calls.map(({ path, line }) => `${path}:${line}`))].sort();
  report(
    'error-message-duplicate',
    `错误文案 ${JSON.stringify(value)} 在多个文件重复出现（${locations.join('、')}）；提取到 packages/core/src/errors.ts 或 packages/shared 的命名常量后再引用，API 内部可用 packages/api/src/http/errors.ts`,
  );
}

function envSourceOfModule(specifier) {
  if (specifier === 'node:process' || specifier === 'process') return 'process';
  if (specifier === 'bun') return 'Bun';
  return null;
}

function resolveEnvRootSource(path, seen = new Set()) {
  path = unwrapNodePath(path);
  if (path.isIdentifier()) {
    const name = path.node.name;
    const binding = path.scope.getBinding(name);
    if (!binding) return name === 'process' ? 'process' : name === 'Bun' ? 'Bun' : null;
    const impPath = binding.path;
    if (
      (impPath.isImportDefaultSpecifier() || impPath.isImportNamespaceSpecifier()) &&
      impPath.parent.importKind !== 'type'
    ) {
      return envSourceOfModule(impPath.parent.source.value);
    }
    const imp = importedBinding(binding);
    if (imp?.name === 'default') return envSourceOfModule(imp.source);
    if (
      binding.constant &&
      impPath.isVariableDeclarator() &&
      impPath.get('id').isIdentifier() &&
      impPath.node.init &&
      !seen.has(binding)
    ) {
      seen.add(binding);
      return resolveEnvRootSource(impPath.get('init'), seen);
    }
    return null;
  }
  if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
    if (isMember(path.node, 'default')) return resolveEnvRootSource(path.get('object'), seen);
    const target = isMember(path.node, 'process')
      ? 'process'
      : isMember(path.node, 'Bun')
        ? 'Bun'
        : null;
    if (!target) return null;
    const obj = unwrapNodePath(path.get('object'));
    return obj.isIdentifier() && obj.node.name === 'globalThis' && !obj.scope.getBinding('globalThis')
      ? target
      : null;
  }
  if (path.isAwaitExpression()) {
    const arg = unwrapNodePath(path.get('argument'));
    if (arg.isImportExpression()) {
      const spec = stringLiteral(arg.node.source);
      return spec ? envSourceOfModule(spec) : null;
    }
  }
  if (path.isImportExpression()) {
    const spec = stringLiteral(path.node.source);
    return spec ? envSourceOfModule(spec) : null;
  }
  if (
    (path.isCallExpression() || path.isOptionalCallExpression()) &&
    isUnboundGlobalOrMember(path.get('callee'), 'require')
  ) {
    const spec = stringLiteral(path.node.arguments[0]);
    return spec ? envSourceOfModule(spec) : null;
  }
  return null;
}

function isInTypePosition(path) {
  return Boolean(path.findParent((parent) => parent.isTSType() || parent.isTSTypeQuery()));
}

function isEnvObjectProperty(prop) {
  if (prop.type !== 'ObjectProperty') return false;
  if (!prop.computed && prop.key.type === 'Identifier') return prop.key.name === 'env';
  return stringLiteral(prop.key) === 'env';
}

function checkEnvAccess(files, excludeRelPath, onViolation) {
  for (const file of files) {
    const displayPath = rel(file);
    if (excludeRelPath && displayPath === excludeRelPath) continue;
    traverse(readModule(file).ast, {
      'MemberExpression|OptionalMemberExpression'(path) {
        if (!isMember(path.node, 'env') || isInTypePosition(path)) return;
        const source = resolveEnvRootSource(path.get('object'));
        if (source) onViolation(displayPath, path.node.loc.start.line, source);
      },
      'VariableDeclarator|AssignmentExpression'(path) {
        const pattern = path.isVariableDeclarator() ? path.node.id : path.node.left;
        const rhsPath = path.isVariableDeclarator() ? path.get('init') : path.get('right');
        if (pattern.type !== 'ObjectPattern' || !rhsPath.node) return;
        const source = resolveEnvRootSource(rhsPath);
        if (!source) return;
        for (const prop of pattern.properties) {
          if (isEnvObjectProperty(prop)) onViolation(displayPath, prop.loc.start.line, source);
        }
      },
      ImportSpecifier(path) {
        const binding = path.scope.getBinding(path.node.local.name);
        const imp = importedBinding(binding);
        const source = imp?.name === 'env' ? envSourceOfModule(imp.source) : null;
        if (!source) return;
        for (const refPath of binding.referencePaths) {
          if (isInTypePosition(refPath)) continue;
          const parent = refPath.parentPath;
          if (
            parent?.isExportSpecifier() &&
            (parent.node.exportKind === 'type' || parent.parent?.exportKind === 'type')
          ) {
            continue;
          }
          onViolation(displayPath, refPath.node.loc.start.line, source);
        }
      },
      ExportNamedDeclaration(path) {
        const { exportKind, specifiers, source } = path.node;
        if (!source || exportKind === 'type') return;
        const envSource = envSourceOfModule(source.value);
        if (!envSource) return;
        for (const spec of specifiers) {
          if (spec.exportKind !== 'type' && nameOf(spec.local) === 'env') {
            onViolation(displayPath, spec.loc.start.line, envSource);
          }
        }
      },
    });
  }
}

checkEnvAccess(apiFiles, 'packages/api/src/config.ts', (displayPath, line, source) =>
  report(
    'api-no-process-env',
    `${displayPath}:${line}: 禁止在 config.ts 之外直接访问 ${source}.env（通过 packages/api/src/config.ts 的 Config 注入依赖）`,
  ),
);

checkEnvAccess(dbFiles, null, (displayPath, line, source) =>
  report(
    'db-no-process-env',
    `${displayPath}:${line}: db 模块禁止直接访问 ${source}.env（连接串等配置由调用方经 createDb 或参数传入）`,
  ),
);

function isModuleNamespaceExpr(path, seen = new Set()) {
  path = unwrapNodePath(path);
  if (path.isImportExpression()) return true;
  if (path.isAwaitExpression()) return isModuleNamespaceExpr(path.get('argument'), seen);
  if (
    (path.isCallExpression() || path.isOptionalCallExpression()) &&
    isUnboundGlobalOrMember(path.get('callee'), 'require')
  ) {
    return true;
  }
  if (!path.isIdentifier()) return false;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding) return false;
  if (binding.path.isImportNamespaceSpecifier() && binding.path.parent.importKind !== 'type') {
    return true;
  }
  if (
    binding.constant &&
    binding.path.isVariableDeclarator() &&
    binding.path.get('id').isIdentifier() &&
    binding.path.node.init &&
    !seen.has(binding)
  ) {
    seen.add(binding);
    return isModuleNamespaceExpr(binding.path.get('init'), seen);
  }
  return false;
}

function destructuredPropertyName(pattern, identifierNode) {
  for (const prop of pattern.properties) {
    if (prop.type !== 'ObjectProperty') continue;
    const target = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
    if (target !== identifierNode) continue;
    if (!prop.computed && prop.key.type === 'Identifier') return prop.key.name;
    return stringLiteral(prop.key);
  }
}

function matchesCompositionTarget(path, targetName, seen = new Set()) {
  path = unwrapNodePath(path);
  if (isMember(path.node, targetName)) return true;
  if (!path.isIdentifier()) return false;
  const name = path.node.name;
  const binding = path.scope.getBinding(name);
  if (!binding) return name === targetName;
  if (importedBinding(binding)?.name === targetName) return true;
  if (binding.path.isImportDefaultSpecifier() && name === targetName) return true;
  if (binding.constant && binding.path.isVariableDeclarator() && binding.path.node.init) {
    if (binding.path.get('id').isIdentifier() && !seen.has(binding)) {
      seen.add(binding);
      return matchesCompositionTarget(binding.path.get('init'), targetName, seen);
    }
    if (binding.path.get('id').isObjectPattern()) {
      return (
        destructuredPropertyName(binding.path.node.id, binding.identifier) === targetName &&
        isModuleNamespaceExpr(binding.path.get('init'))
      );
    }
  }
  return false;
}

const workerCompositionRoots = new Set([
  'packages/worker/src/index.ts',
  'packages/worker/src/maintenance.ts',
]);
for (const file of workerFiles) {
  const displayPath = rel(file);
  if (workerCompositionRoots.has(displayPath)) continue;
  traverse(readModule(file).ast, {
    'CallExpression|OptionalCallExpression'(path) {
      if (matchesCompositionTarget(path.get('callee'), 'createDb')) {
        report(
          'worker-single-composition-root',
          `${displayPath}:${path.node.loc.start.line}: 禁止在组合根（index.ts / maintenance.ts）之外调用 createDb()（通过依赖注入传入 db）`,
        );
      }
    },
    NewExpression(path) {
      if (matchesCompositionTarget(path.get('callee'), 'DockerSandboxProvider')) {
        report(
          'worker-single-composition-root',
          `${displayPath}:${path.node.loc.start.line}: 禁止在组合根（index.ts / maintenance.ts）之外实例化 new DockerSandboxProvider()（通过依赖注入传入 sandbox provider）`,
        );
      }
    },
  });
}

const iconRe = /import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/;
for (const file of webFiles) {
  if (file.endsWith('App.tsx')) continue;
  const src = read(file);
  const m = src.match(iconRe);
  if (!m) continue;
  const names = m[1]
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/).pop())
    .filter(Boolean);
  for (const name of names) {
    const tag = new RegExp(`<${name}\\b[^>]*>`, 'g');
    for (const t of src.matchAll(tag)) {
      if (/\b(strokeWidth|size)=/.test(t[0])) {
        report('lucide-icon-size', `${rel(file)}:${lineAt(src, t.index)}: lucide 图标 ${name} 逐个传 strokeWidth/size`);
      }
    }
  }
}

const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
for (const file of webFiles) {
  if (file.includes('/components/ui/')) continue;
  const src = read(file);
  for (const m of src.matchAll(hexRe)) {
    report('web-hardcoded-hex', `${rel(file)}:${lineAt(src, m.index)}: 硬编码色值 ${m[0]}（用 @theme token）`);
  }
}

function skipBalancedParens(src, i) {
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(src, i, c);
      continue;
    }
    if (c === '`') {
      i = scanTemplateLiteral(src, i).end;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    i += 1;
  }
  return i;
}

const buttonVariantsFix = '改用 cn(buttonVariants(...), ...)（见 packages/web/src/lib/cn.ts）';
function findButtonVariantsConcatViolations(code) {
  const lines = new Set();
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(code, i, ch) - 1;
      continue;
    }
    if (ch === '`') {
      const tpl = scanTemplateLiteral(code, i);
      for (const expr of tpl.expressions) {
        if (/\bbuttonVariants\s*\(/.test(expr.expr)) {
          lines.add(lineAt(code, i));
        }
      }
      i = tpl.end - 1;
    }
  }
  for (const m of code.matchAll(/\+\s*buttonVariants\s*\(/g)) {
    lines.add(lineAt(code, m.index));
  }
  for (const m of code.matchAll(/\bbuttonVariants\s*\(/g)) {
    const afterParen = skipBalancedParens(code, m.index + m[0].length);
    if (/^\s*\+/.test(code.slice(afterParen))) {
      lines.add(lineAt(code, m.index));
    }
  }
  return [...lines].sort((a, b) => a - b);
}

for (const file of webFiles) {
  const code = stripComments(read(file));
  for (const line of findButtonVariantsConcatViolations(code)) {
    report('button-variants-concat', `${rel(file)}:${line}: 拼接 buttonVariants 类名（${buttonVariantsFix}）`);
  }
}

function findSqlLikeViolations(src) {
  const lines = [];
  const startRe = /(?<![\w$.])sql\s*`/g;
  for (const m of src.matchAll(startRe)) {
    const tpl = scanTemplateLiteral(src, m.index + m[0].length - 1);
    if (
      tpl.expressions.length > 0 &&
      /\b(?:i?like)\b/i.test(tpl.staticText) &&
      !/\b(?:containsPattern|prefixPattern|escapeLike)\b/.test(tpl.exprText)
    ) {
      lines.push(lineAt(src, m.index));
    }
  }
  return lines;
}

const likeFix = '改用 packages/db/src/repo/like.ts 的 ilikeContains / likePrefix / containsPattern';
const likeCallRe = /\b(?:i?like)\s*\(/g;
for (const file of dbFiles) {
  if (rel(file) === 'packages/db/src/repo/like.ts') continue;
  const src = read(file);
  for (const m of src.matchAll(likeCallRe)) {
    report(
      'db-like-call',
      `${rel(file)}:${lineAt(src, m.index)}: 直接调用 ${m[0].replace(/\($/, '')}（${likeFix}）`,
    );
  }
  for (const line of findSqlLikeViolations(src)) {
    report('db-like-sql', `${rel(file)}:${line}: sql 模板中未转义的 LIKE/ILIKE（${likeFix}）`);
  }
}

const DB_ENUM_CHECK_ALLOWLIST = new Set([
  'packages/db/src/schema/chat.ts:channel_wakes_status_check',
  'packages/db/src/schema/governance.ts:budget_limits_scope_metric_check',
  'packages/db/src/schema/integrations.ts:webhook_deliveries_status_check',
  'packages/db/src/schema/knowledge-bases.ts:knowledge_model_profiles_dimensions_check',
  'packages/db/src/schema/knowledge-documents.ts:knowledge_document_tags_origin_check',
]);

for (const file of dbSchemaFiles) {
  const code = stripComments(read(file));
  for (const m of code.matchAll(/\bcheck\s*\(\s*(['"])([^'"]+)\1\s*,/g)) {
    const checkName = m[2];
    const callEnd = skipBalancedParens(code, m.index + m[0].indexOf('(') + 1);
    const callBody = code.slice(m.index, callEnd);
    const sqlMatch = callBody.match(/(?<![\w$.])sql\s*`/);
    if (!sqlMatch) continue;
    const tpl = scanTemplateLiteral(callBody, sqlMatch.index + sqlMatch[0].length - 1);
    const hasInCheck = /\bin\s*\(/i.test(tpl.staticText);
    const hasArraySubsetCheck = /<@\s*array\s*\[/i.test(tpl.staticText);
    if (!hasInCheck && !hasArraySubsetCheck) continue;
    const hasHardcodedList =
      /\bin\s*\([^)]*'/i.test(tpl.staticText) || /<@\s*array\s*\[[^\]]*'/i.test(tpl.staticText);
    const derivesFromOptions = /\.options\b/.test(tpl.exprText);
    if (hasHardcodedList || !derivesFromOptions) {
      const key = `${rel(file)}:${checkName}`;
      if (!DB_ENUM_CHECK_ALLOWLIST.has(key)) {
        report(
          'db-enum-check',
          `${rel(file)}:${lineAt(code, m.index)}: DB check '${checkName}' 未从 @agentport/shared 的 *.options 派生（改用 ${'${schema}.options'} 派生枚举，或确认属 DB 内部约束后加入 DB_ENUM_CHECK_ALLOWLIST）`,
        );
      }
    }
  }
}

const storageRe = /\bwindow\.localStorage\b|\blocalStorage\./g;
for (const file of webFiles) {
  if (rel(file) === 'packages/web/src/lib/storage.ts') continue;
  const src = read(file);
  for (const m of src.matchAll(storageRe)) {
    report(
      'web-localstorage',
      `${rel(file)}:${lineAt(src, m.index)}: 直接访问 localStorage（改用 packages/web/src/lib/storage.ts 的 readStorage / writeStorage）`,
    );
  }
}

const coreBrowserEntrypoints = [
  'packages/core/src/workspace.ts',
  'packages/core/src/plugin-display.ts',
  'packages/core/src/record.ts',
];
for (const entry of coreBrowserEntrypoints) {
  const fullPath = join(ROOT, entry);
  const code = stripComments(read(fullPath));
  for (const imp of getModuleImports(fullPath)) {
    if (imp.specifier.startsWith('node:')) {
      report(
        'core-browser-node',
        `${entry}:${imp.line}: 浏览器可达子路径禁引 Node 内建或 Buffer（${imp.specifier}）`,
      );
    }
  }
  for (const m of code.matchAll(/\bBuffer\b/g)) {
    report('core-browser-node', `${entry}:${lineAt(code, m.index)}: 浏览器可达子路径禁引 Node 内建或 Buffer`);
  }
}

function stripCssComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(src, i, ch);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < src.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
const stylesCode = stripCssComments(read(join(ROOT, 'packages/web/src/styles.css')));

if (!stylesCode.includes('@custom-variant dark (&:where(.dark, .dark *));')) {
  report('styles-dark-variant', 'packages/web/src/styles.css: 缺少 @custom-variant dark (&:where(.dark, .dark *));');
}
for (const m of stylesCode.matchAll(/\.dark(?![\w-])[^;{}]*\{/g)) {
  report('styles-dark-block', `packages/web/src/styles.css:${lineAt(stylesCode, m.index)}: 禁止定义 .dark 主题块`);
}
const readCssToken = (css, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*:\\s*([^;]+);`));
  return match ? { value: match[1].trim(), line: lineAt(css, match.index) } : null;
};
for (const m of stylesCode.matchAll(/--color-muted\s*:\s*var\(\s*--color-muted-foreground\s*\)\s*;/g)) {
  report(
    'styles-muted-token',
    `packages/web/src/styles.css:${lineAt(stylesCode, m.index)}: --color-muted 不得等于 var(--color-muted-foreground)`,
  );
}
const radius4xl = readCssToken(stylesCode, '--radius-4xl');
if (!radius4xl || radius4xl.value !== 'var(--radius-tag)') {
  report(
    'styles-radius-4xl',
    `packages/web/src/styles.css:${radius4xl?.line ?? 1}: --radius-4xl 必须等于 var(--radius-tag)`,
  );
}
for (const shadowVar of ['--shadow-md', '--shadow-lg']) {
  const token = readCssToken(stylesCode, shadowVar);
  if (!token || token.value !== 'var(--shadow-overlay)') {
    report(
      'styles-shadow',
      `packages/web/src/styles.css:${token?.line ?? 1}: ${shadowVar} 必须等于 var(--shadow-overlay)`,
    );
  }
}

for (const file of walk(join(ROOT, 'packages/web/src'), /\.css$/)) {
  const css = stripCssComments(read(file));
  for (const m of css.matchAll(/[^{};]*collapsible-content[^{};]*\{/g)) {
    const blockStart = m.index + m[0].length;
    const blockEnd = skipBalancedBraces(css, blockStart);
    const blockBody = css.slice(blockStart, blockEnd);
    if (/\bcontent-visibility\s*:/.test(blockBody)) {
      report(
        'collapsible-content-visibility',
        `${rel(file)}:${lineAt(css, m.index)}: 禁止在 collapsible-content 上设置 content-visibility`,
      );
    }
  }
}

const node24VersionRe =
  /^(?:[\^~]?24(?:\.(?:\d+(?:\.(?:\d+|x|X|\*))?|x|X|\*))?|>=24(?:\.\d+){0,2}\s+<25(?:\.0){0,2})$/;
const dockerNodeFromRe = /^\s*FROM\s+(?:--\S+\s+)*(?:[^\s/]+\/)*node(?::|@|\s|$)/i;
const dockerNode24FromRe =
  /^\s*FROM\s+(?:--\S+\s+)*(?:[^\s/]+\/)*node:24(?:\.\d+)*(?:-|\s|@|$)/i;
const nodeLockReason = 'Node.js 与 @types/node 永久锁定 24.x，禁止升级到 26+';

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const checkDirectTypesNode = (manifestPath, manifest) => {
  for (const field of dependencyFields) {
    const version = manifest?.[field]?.['@types/node'];
    if (
      version !== undefined &&
      (typeof version !== 'string' || (version !== 'catalog:' && !node24VersionRe.test(version)))
    ) {
      report(
        'node-version-lock',
        `${rel(manifestPath)}: ${field}["@types/node"] 为 ${JSON.stringify(version)}（${nodeLockReason}，改为 catalog: 或 24.x 版本）`,
      );
    }
  }
};

const rootPackagePath = join(ROOT, 'package.json');
let rootPkg = null;
if (existsSync(rootPackagePath)) {
  rootPkg = JSON.parse(read(rootPackagePath));
  const nodeEngine = rootPkg?.engines?.node;
  if (typeof nodeEngine !== 'string' || !node24VersionRe.test(nodeEngine)) {
    report(
      'node-version-lock',
      `package.json: engines.node 为 ${JSON.stringify(nodeEngine)}（${nodeLockReason}，须锁定为 24.x 如 ">=24.22.2 <25"）`,
    );
  }
  const catalogTypesNode = rootPkg?.workspaces?.catalog?.['@types/node'];
  if (
    catalogTypesNode !== undefined &&
    (typeof catalogTypesNode !== 'string' || !node24VersionRe.test(catalogTypesNode))
  ) {
    report(
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
    report(
      'node-version-lock',
      `package.json: overrides["@types/node"] 为 ${JSON.stringify(overridesTypesNode)}（${nodeLockReason}，须锁定为 24.x）`,
    );
  }
  checkDirectTypesNode(rootPackagePath, rootPkg);
}

const sharedDepUses = new Map();
if (existsSync(packagesDir)) {
  for (const name of readdirSync(packagesDir).sort()) {
    const pkgJsonPath = join(packagesDir, name, 'package.json');
    if (existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(read(pkgJsonPath));
      const pkgNodeEngine = pkg?.engines?.node;
      if (
        pkgNodeEngine !== undefined &&
        (typeof pkgNodeEngine !== 'string' || !node24VersionRe.test(pkgNodeEngine))
      ) {
        report(
          'node-version-lock',
          `${rel(pkgJsonPath)}: engines.node 为 ${JSON.stringify(pkgNodeEngine)}（${nodeLockReason}，须锁定为 24.x）`,
        );
      }
      checkDirectTypesNode(pkgJsonPath, pkg);
      for (const field of dependencyFields) {
        const deps = pkg?.[field];
        if (!deps || typeof deps !== 'object') continue;
        for (const [dep, version] of Object.entries(deps)) {
          if (typeof version === 'string' && version.startsWith('workspace:')) continue;
          const uses = sharedDepUses.get(dep) ?? [];
          uses.push({ pkgDir: name, pkgPath: rel(pkgJsonPath), field, version });
          sharedDepUses.set(dep, uses);
        }
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
      report(
        'catalog-shared-deps',
        `${use.pkgPath}: ${use.field}["${dep}"] 为 ${JSON.stringify(use.version)}（共享依赖出现在 ${pkgCount} 个子包中，须在根 package.json workspaces.catalog 声明并在各子包统一使用 "catalog:"）`,
      );
    }
  }
  const catalogVersion = rootCatalog[dep];
  if (typeof catalogVersion !== 'string' || catalogVersion.trim() === '') {
    report(
      'catalog-shared-deps',
      `package.json: workspaces.catalog 缺少共享依赖 "${dep}"（已在 ${pkgCount} 个子包中使用，须在根 workspaces.catalog 中声明版本）`,
    );
  }
}

const dockerfilePath = join(ROOT, 'Dockerfile');
if (existsSync(dockerfilePath)) {
  const lines = read(dockerfilePath).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (dockerNodeFromRe.test(line) && !dockerNode24FromRe.test(line)) {
      report(
        'node-version-lock',
        `Dockerfile:${i + 1}: ${line.trim()}（${nodeLockReason}，须使用 node:24 镜像）`,
      );
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('project contract OK');
