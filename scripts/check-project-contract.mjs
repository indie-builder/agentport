import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';

const ROOT = process.cwd();
const problems = [];
const report = (rule, message) => problems.push(`[${rule}] ${message}`);

/** @param {string} dir @param {RegExp} ext */
function walk(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, ext));
    else if (ext.test(name)) out.push(full);
  }
  return out;
}

const rel = (p) => relative(ROOT, p);
const read = (p) => readFileSync(p, 'utf8');
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

const moduleStmtRe =
  /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:(?:\*(?:\s+as\s+\w+)?|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?))?)\s+from\s+)?['"]([^'"]+)['"]/g;

function isTypeOnlyImportStatement(stmt, typeKeyword) {
  if (typeKeyword) return true;
  const fromMatch = stmt.match(/^\s*(?:import|export)\s+([\s\S]*?)\s+from\s+['"]/);
  if (!fromMatch) return false;
  const clause = fromMatch[1].trim();
  if (!clause.startsWith('{') || !clause.endsWith('}')) return false;
  const parts = clause
    .slice(1, -1)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((part) => /^type\s+/.test(part));
}

function extractModuleImports(code) {
  const imports = [];
  for (const m of code.matchAll(moduleStmtRe)) {
    imports.push({
      specifier: m[3],
      line: lineAt(code, m.index + (m[0].startsWith('\n') ? 1 : 0)),
      isTypeOnly: isTypeOnlyImportStatement(m[0], m[2]),
    });
  }
  return imports;
}

const matchesPackage = (spec, pkg) => spec === pkg || spec.startsWith(`${pkg}/`);

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

const allowedWebCoreImports = new Set([
  '@agentport/core/workspace',
  '@agentport/core/plugin-display',
  '@agentport/core/record',
]);
const forbiddenWebPackages = ['@agentport/db', '@agentport/api', '@agentport/worker'];

for (const file of webFiles) {
  const code = stripComments(read(file));
  for (const imp of extractModuleImports(code)) {
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
  const code = stripComments(read(file));
  for (const imp of extractModuleImports(code)) {
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

const forbiddenContractPackages = [
  '@agentport/db',
  '@agentport/api',
  '@agentport/worker',
  '@agentport/core',
];
for (const file of contractFiles) {
  const code = stripComments(read(file));
  for (const imp of extractModuleImports(code)) {
    if (forbiddenContractPackages.some((pkg) => matchesPackage(imp.specifier, pkg))) {
      report(
        'contract-import',
        `${rel(file)}:${imp.line}: contract 禁止引入 ${imp.specifier}（packages/contract 只允许依赖 @agentport/shared、zod 与 @orpc/contract）`,
      );
    }
  }
}

const forbiddenDbPackages = ['@agentport/api', '@agentport/worker', 'hono', 'bullmq', 'pg'];
for (const file of dbFiles) {
  const code = stripComments(read(file));
  for (const imp of extractModuleImports(code)) {
    if (forbiddenDbPackages.some((pkg) => matchesPackage(imp.specifier, pkg))) {
      report(
        'db-import',
        `${rel(file)}:${imp.line}: db 禁止引入 ${imp.specifier}（db 模块边界只使用 drizzle-orm/bun-sql，不引入路由、队列或 pg）`,
      );
    }
  }
}

const routerRe = /^packages\/api\/src\/modules\/[^/]+\/router\.ts$/;
const routerSafeParseRe = /\binput\.(params|query|body)\.safeParse\b/g;
for (const file of apiFiles) {
  if (!routerRe.test(rel(file))) continue;
  const code = stripComments(read(file));
  for (const m of code.matchAll(routerSafeParseRe)) {
    report(
      'router-safe-parse',
      `${rel(file)}:${lineAt(code, m.index)}: router 内对 input.${m[1]} 使用 safeParse（校验只在 @agentport/contract 的 input schema 完成，不在 router.ts 重复 safeParse）`,
    );
  }
}

const dynamicPinoRe = /\b(?:import|require)\s*\(\s*['"]pino(?:\/[^'"]*)?['"]\s*\)/g;
for (const file of [...apiFiles, ...workerFiles]) {
  const code = stripComments(read(file));
  for (const imp of extractModuleImports(code)) {
    if (matchesPackage(imp.specifier, 'pino') && !imp.isTypeOnly) {
      report(
        'pino-static',
        `${rel(file)}:${imp.line}: 直接引入 pino 值（改用 @agentport/core/logger 的 createServiceLogger / requestScopedLogger / runScopedLogger）`,
      );
    }
  }
  for (const m of code.matchAll(dynamicPinoRe)) {
    report(
      'pino-dynamic',
      `${rel(file)}:${lineAt(code, m.index)}: 动态引入 pino（改用 @agentport/core/logger 的 createServiceLogger / requestScopedLogger / runScopedLogger）`,
    );
  }
}

const errorFiles = [
  ...apiFiles,
  ...workerFiles,
  ...coreFiles,
  ...sharedFiles,
  ...contractFiles,
].filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
const modules = new Map();

function readModule(file) {
  if (!modules.has(file)) {
    const ast = parse(read(file), {
      sourceFilename: file,
      sourceType: 'module',
      plugins: ['typescript'],
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

function resolveModule(file, specifier) {
  const workspace = /^@agentport\/([^/]+)(?:\/(.+))?$/.exec(specifier);
  if (workspace) {
    const target = join(ROOT, 'packages', workspace[1], 'src', `${workspace[2] ?? 'index'}.ts`);
    return existsSync(target) ? target : undefined;
  }
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return;
  const target = join(dirname(file), specifier);
  const extension = extname(target);
  const candidates =
    extension === '.js'
      ? [`${target.slice(0, -3)}.ts`]
      : extension === '.ts'
        ? [target]
        : [`${target}.ts`, join(target, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate));
}

const nameOf = (node) => (node.type === 'Identifier' ? node.name : node.value);

function importedBinding(binding) {
  const path = binding?.path;
  if (!path?.isImportSpecifier() || path.node.importKind === 'type') return;
  const declaration = path.parent;
  if (declaration.importKind === 'type') return;
  return { source: declaration.source.value, name: nameOf(path.node.imported) };
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

function stringLiteral(node) {
  node = unwrapExpression(node);
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
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
      displayPath === 'packages/worker/src/data-domains/enrich.ts');
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
          `${displayPath}:${line}: 调度器直接调用 setInterval（改用 packages/worker/src/scheduling/interval-ticker.ts 的 startIntervalTicker 管理定时与关停，双入口 sync 通过 packages/worker/src/scheduling/single-flight.ts 的 startSingleFlight 共用单飞守卫）`,
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
    if (!/\bin\s*\(/i.test(tpl.staticText)) continue;
    const hasHardcodedInList = /\bin\s*\(\s*'/i.test(tpl.staticText);
    const derivesFromOptions = /\.options\b/.test(tpl.exprText);
    if (hasHardcodedInList || !derivesFromOptions) {
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
  const code = stripComments(read(join(ROOT, entry)));
  for (const imp of extractModuleImports(code)) {
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

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('project contract OK');
