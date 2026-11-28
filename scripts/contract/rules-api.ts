import { dirname, join } from 'node:path';
import traverse, { type NodePath } from '@babel/traverse';
import { type AstNode, type PackageRef, resolveExports, resolvePackageRef } from './ast-utils.js';
import { type ContractContext, matchesPackage, type RuleModule } from './context.js';

const API_RULES = [
  'router-safe-parse',
  'pino-static',
  'pino-dynamic',
  'api-http-no-module-import',
  'api-no-cross-router-import',
  'api-no-raw-hono-bodylimit',
  'api-no-process-env',
  'api-no-orpc-zod-throw',
  'api-no-raw-dml',
  'error-message-duplicate',
] as const;

const routerRe = /^packages\/api\/src\/modules\/[^/]+\/router\.ts$/;
const routerSafeParseRe = /\binput\.(params|query|body)\.safeParse\b/g;
const apiInfraDirRe = /^packages\/api\/src\/(http|lib|queue)\//;
const apiRouterTargetRe = /^packages\/api\/src\/modules\/[^/]+\/router(?:\.(?:ts|js|tsx|jsx))?$/;

const errorFunctions = new Set(['fail', 'notFound']);
const dbNonTableExports = new Set([
  'createDb',
  'newId',
  'idSuffix',
  'idPrefixes',
  'repo',
  'schema',
  'isCanonicalTimestamp',
  'isPgCode',
  'default',
]);
const sqlIdent = '(?:[a-z_][\\w$]*|"[^"]+"|__expr__)';
const sqlInsertRe = /(?<![.\w$])insert\s+into\b/i;
const sqlDeleteRe = /(?<![.\w$])delete\s+from\b/i;
const sqlUpdateSetRe = new RegExp(
  `(?<![.\\w$])update\\s+(?:only\\s+)?${sqlIdent}(?:\\s*\\.\\s*${sqlIdent})?(?:\\s+(?:as\\s+)?${sqlIdent})?\\s+set\\b`,
  'i',
);
const dmlMethods = ['insert', 'update', 'delete'];

function resolveApiSpecPath(ctx: ContractContext, file: string, specifier: string): string | null {
  const resolved = ctx.resolveModule(file, specifier);
  if (resolved) return ctx.rel(resolved);
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return ctx.rel(join(dirname(file), specifier));
  }
  const ws = /^@agentport\/api(?:\/(.+))?$/.exec(specifier);
  if (ws) return `packages/api/src/${ws[1] ?? 'index'}`;
  return null;
}

function isZodExpression(
  ctx: ContractContext,
  path: NodePath<AstNode | null>,
  seen = new Set<unknown>(),
): boolean {
  if (path.node === null) return false;
  if (path.isCallExpression() || path.isOptionalCallExpression()) {
    return isZodExpression(ctx, path.get('callee'), seen);
  }
  if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
    return isZodExpression(ctx, path.get('object'), seen);
  }
  if (!path.isIdentifier()) return false;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding) return false;
  const imported = ctx.importedBinding(binding);
  if (imported?.source === 'zod' && imported.name === 'z') return true;
  const declaration = binding.path;
  if (
    !binding.constant ||
    !declaration.isVariableDeclarator() ||
    !declaration.get('id').isIdentifier()
  ) {
    return false;
  }
  if (seen.has(binding)) return false;
  seen.add(binding);
  return isZodExpression(ctx, declaration.get('init'), seen);
}

function bannedThrownErrorKind(ref: PackageRef | null): 'ORPCError' | 'ZodError' | null {
  if (!ref) return null;
  if (
    ref.source.startsWith('@orpc/') &&
    ((ref.path.length === 1 && ref.path[0] === 'ORPCError') ||
      (ref.path.length === 2 && ref.path[0] === 'default' && ref.path[1] === 'ORPCError'))
  ) {
    return 'ORPCError';
  }
  if (
    matchesPackage(ref.source, 'zod') &&
    ref.path.at(-1) === 'ZodError' &&
    (ref.path.length === 1 ||
      (ref.path.length === 2 && (ref.path[0] === 'z' || ref.path[0] === 'default')) ||
      (ref.path.length === 3 && ref.path[0] === 'default' && ref.path[1] === 'z'))
  ) {
    return 'ZodError';
  }
  return null;
}

function isDbSchemaTableRef(ref: PackageRef | null): boolean {
  if (!ref) return false;
  if (ref.source === '@agentport/db') {
    return (
      (ref.path.length === 2 && ref.path[0] === 'schema') ||
      (ref.path.length === 1 && ref.path[0] !== undefined && !dbNonTableExports.has(ref.path[0]))
    );
  }
  if (matchesPackage(ref.source, '@agentport/db/schema')) {
    return ref.path.length === 1 && ref.path[0] !== 'default';
  }
  return false;
}

function isDbRepoRef(ref: PackageRef | null): boolean {
  return ref?.source === '@agentport/db' && ref.path[0] === 'repo';
}

function isDrizzleSqlRef(ref: PackageRef | null): boolean {
  if (!ref || !matchesPackage(ref.source, 'drizzle-orm')) return false;
  return (
    (ref.path.length === 1 && ref.path[0] === 'sql') ||
    (ref.path.length === 2 && ref.path[0] === 'default' && ref.path[1] === 'sql')
  );
}

function stripSqlCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '-' && next === '-') {
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
    if (ch === "'") {
      out += ' ';
      i += 1;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (src[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch ?? '';
    i += 1;
  }
  return out;
}

function findSqlDmlStatement(rawSqlText: string): string | null {
  const stripped = stripSqlCommentsAndStrings(rawSqlText);
  if (sqlInsertRe.test(stripped)) return 'INSERT INTO';
  if (sqlDeleteRe.test(stripped)) return 'DELETE FROM';
  if (sqlUpdateSetRe.test(stripped)) return 'UPDATE ... SET';
  return null;
}

function checkApiStaticRules(ctx: ContractContext): void {
  if (ctx.hasRule('router-safe-parse')) {
    for (const file of ctx.apiFiles) {
      const displayPath = ctx.rel(file);
      if (!routerRe.test(displayPath)) continue;
      const code = ctx.readStripped(file);
      for (const m of code.matchAll(routerSafeParseRe)) {
        if (m.index !== undefined && m[1]) {
          ctx.report(
            'router-safe-parse',
            `${displayPath}:${ctx.lineAt(code, m.index)}: router 内对 input.${m[1]} 使用 safeParse（校验只在 @agentport/contract 的 input schema 完成，不在 router.ts 重复 safeParse）`,
          );
        }
      }
    }
  }

  if (ctx.hasAnyRule(['pino-static', 'pino-dynamic'])) {
    for (const file of [...ctx.apiFiles, ...ctx.workerFiles]) {
      for (const imp of ctx.getModuleImports(file)) {
        if (!ctx.matchesPackage(imp.specifier, 'pino')) continue;
        if (imp.isDynamic) {
          ctx.report(
            'pino-dynamic',
            `${ctx.rel(file)}:${imp.line}: 动态引入 pino（改用 @agentport/core/logger 的 createServiceLogger / requestScopedLogger / runScopedLogger）`,
          );
        } else if (!imp.isTypeOnly) {
          ctx.report(
            'pino-static',
            `${ctx.rel(file)}:${imp.line}: 直接引入 pino 值（改用 @agentport/core/logger 的 createServiceLogger / requestScopedLogger / runScopedLogger）`,
          );
        }
      }
    }
  }

  if (
    ctx.hasAnyRule([
      'api-http-no-module-import',
      'api-no-cross-router-import',
      'api-no-raw-hono-bodylimit',
    ])
  ) {
    for (const file of ctx.apiFiles) {
      const displayPath = ctx.rel(file);
      const isInfra = apiInfraDirRe.test(displayPath);
      const isRoutesIndex = displayPath === 'packages/api/src/routes/index.ts';
      const isBodyLimitWrapper = displayPath === 'packages/api/src/http/body-limit.ts';

      for (const imp of ctx.getModuleImports(file)) {
        const targetRel = resolveApiSpecPath(ctx, file, imp.specifier);
        if (
          isInfra &&
          targetRel &&
          (targetRel === 'packages/api/src/modules' ||
            targetRel.startsWith('packages/api/src/modules/'))
        ) {
          ctx.report(
            'api-http-no-module-import',
            `${displayPath}:${imp.line}: 基础设施层禁止引入业务模块 ${imp.specifier}（将共享能力下沉到 http/、lib/、@agentport/core 或 @agentport/db）`,
          );
        }
        if (!isRoutesIndex && targetRel && apiRouterTargetRe.test(targetRel)) {
          ctx.report(
            'api-no-cross-router-import',
            `${displayPath}:${imp.line}: 禁止在 routes/index.ts 之外导入 ${imp.specifier}（路由装配集中于 packages/api/src/routes/index.ts，共享逻辑抽取到同模块 helper 或 @agentport/core/@agentport/db）`,
          );
        }
        if (!isBodyLimitWrapper && ctx.matchesPackage(imp.specifier, 'hono/body-limit')) {
          ctx.report(
            'api-no-raw-hono-bodylimit',
            `${displayPath}:${imp.line}: 禁止直接导入 ${imp.specifier}（改用 packages/api/src/http/body-limit.ts 的 requestBodyLimit）`,
          );
        }
      }
    }
  }

  if (ctx.hasRule('api-no-process-env')) {
    ctx.checkEnvAccess(ctx.apiFiles, 'packages/api/src/config.ts', (displayPath, line, source) =>
      ctx.report(
        'api-no-process-env',
        `${displayPath}:${line}: 禁止在 config.ts 之外直接访问 ${source}.env（通过 packages/api/src/config.ts 的 Config 注入依赖）`,
      ),
    );
  }
}

function checkApiAstRules(ctx: ContractContext): void {
  if (!ctx.hasAnyRule(['api-no-orpc-zod-throw', 'api-no-raw-dml'])) return;

  for (const file of ctx.apiFiles) {
    const displayPath = ctx.rel(file);
    const isApiModule = displayPath.startsWith('packages/api/src/modules/');
    traverse(ctx.readModule(file).ast, {
      NewExpression(path) {
        if (!isApiModule) return;
        const kind = bannedThrownErrorKind(resolvePackageRef(path.get('callee')));
        if (!kind) return;
        ctx.report(
          'api-no-orpc-zod-throw',
          `${displayPath}:${path.node.loc?.start.line ?? 0}: 业务模块禁止直接抛出 new ${kind}()（统一使用 @agentport/core 的 AppError / fail()（含 extra 扩展负载）走 http/orpc.ts 唯一错误与日志管道）`,
        );
      },
      'CallExpression|OptionalCallExpression'(path) {
        const { callee, arguments: args, loc } = path.node;
        const line = loc?.start.line ?? 0;
        if (
          ctx.isMember(callee, 'raw') &&
          isDrizzleSqlRef(resolvePackageRef(path.get('callee.object')))
        ) {
          const rawSql = ctx.stringLiteral(args[0]);
          const stmt = rawSql === undefined ? null : findSqlDmlStatement(rawSql);
          if (stmt) {
            ctx.report(
              'api-no-raw-dml',
              `${displayPath}:${line}: 禁止在 API 层 sql.raw() 中直接执行 ${stmt}（全部写操作收口至 @agentport/db/src/repo/）`,
            );
          }
          return;
        }
        const method = dmlMethods.find((name) => ctx.isMember(callee, name));
        if (!method || args.length === 0) return;
        const calleeObj = path.get('callee.object');
        if (!Array.isArray(calleeObj) && isDbRepoRef(resolvePackageRef(calleeObj))) return;
        const arg0 = path.get('arguments.0');
        if (!arg0 || Array.isArray(arg0) || !isDbSchemaTableRef(resolvePackageRef(arg0))) return;
        ctx.report(
          'api-no-raw-dml',
          `${displayPath}:${line}: 禁止在 API 层直接调用 Drizzle 表 DML .${method}()（全部写操作收口至 @agentport/db/src/repo/）`,
        );
      },
      TaggedTemplateExpression(path) {
        if (!isDrizzleSqlRef(resolvePackageRef(path.get('tag')))) return;
        const rawSql = path.node.quasi.quasis
          .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
          .join(' __expr__ ');
        const stmt = findSqlDmlStatement(rawSql);
        if (!stmt) return;
        ctx.report(
          'api-no-raw-dml',
          `${displayPath}:${path.node.loc?.start.line ?? 0}: 禁止在 API 层 sql 模板中直接执行 ${stmt}（全部写操作收口至 @agentport/db/src/repo/）`,
        );
      },
    });
  }
}

function checkDuplicateErrorMessages(ctx: ContractContext): void {
  if (!ctx.hasRule('error-message-duplicate')) return;

  const errorFiles = [
    ...ctx.apiFiles,
    ...ctx.workerFiles,
    ...ctx.coreFiles,
    ...ctx.sharedFiles,
    ...ctx.contractFiles,
  ].filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));

  const callsByMessage = new Map<
    string,
    { constant: AstNode | undefined; path: string; line: number }[]
  >();
  const coreErrors = join(ctx.root, 'packages/core/src/errors.ts');
  const mcpErrors = join(ctx.root, 'packages/api/src/lib/mcp.ts');

  for (const file of errorFiles) {
    const displayPath = ctx.rel(file);
    traverse(ctx.readModule(file).ast, {
      'CallExpression|OptionalCallExpression|NewExpression'(path) {
        const { callee, arguments: args, loc } = path.node;
        const line = loc?.start.line ?? 0;
        const identifier = callee.type === 'Identifier' ? callee.name : undefined;
        let message = ctx.unwrapExpression(args[1]);
        if (!message) return;
        const binding = identifier ? path.scope.getBinding(identifier) : undefined;
        const imported = ctx.importedBinding(binding);

        if (path.isNewExpression()) {
          if (!imported) {
            if (
              file !== coreErrors ||
              !binding?.scope.path.isProgram() ||
              !binding.path.isClassDeclaration() ||
              identifier !== 'AppError'
            ) {
              return;
            }
          } else if (imported.source !== '@agentport/core' || imported.name !== 'AppError') {
            const declarations = resolveExports(
              ctx.readModule,
              ctx.resolveModule,
              ctx.resolveModule(file, imported.source),
              imported.name,
            );
            const entry = declarations.length === 1 ? declarations[0] : null;
            if (
              !entry?.path.isClassDeclaration() ||
              entry?.path.node.id?.name !== 'AppError' ||
              entry?.file !== coreErrors
            ) {
              return;
            }
          }
        } else if (identifier) {
          if (imported?.name === 'toolError') {
            if (ctx.resolveModule(file, imported.source) !== mcpErrors) return;
            const declarations = resolveExports(
              ctx.readModule,
              ctx.resolveModule,
              mcpErrors,
              imported.name,
            );
            const entry = declarations.length === 1 ? declarations[0] : null;
            if (
              !entry?.path.isFunctionDeclaration() ||
              entry?.path.node.id?.name !== 'toolError' ||
              entry?.file !== mcpErrors
            ) {
              return;
            }
          } else if (imported) {
            if (!errorFunctions.has(imported.name)) return;
            if (
              imported.source !== '@agentport/core' &&
              !(
                displayPath.startsWith('packages/core/src/') &&
                ctx.resolveModule(file, imported.source) === coreErrors
              )
            ) {
              return;
            }
          } else if (
            !errorFunctions.has(identifier) ||
            file !== coreErrors ||
            !binding?.scope.path.isProgram() ||
            !binding.path.isFunctionDeclaration()
          ) {
            return;
          }
        } else if (
          !ctx.isMember(callee, 'refine') ||
          !isZodExpression(ctx, path.get('callee.object'))
        ) {
          return;
        }

        while (
          message.type === 'LogicalExpression' &&
          (message.operator === '??' || message.operator === '||')
        ) {
          message = ctx.unwrapExpression(message.right);
          if (!message) return;
        }

        let constant: AstNode | undefined;
        if (message.type === 'Identifier') {
          let resolvedBinding = path.scope.getBinding(message.name);
          const importedConst = ctx.importedBinding(resolvedBinding);
          if (importedConst) {
            const declarations = resolveExports(
              ctx.readModule,
              ctx.resolveModule,
              ctx.resolveModule(file, importedConst.source),
              importedConst.name,
            );
            resolvedBinding = declarations.length === 1 ? declarations[0]?.binding : undefined;
          }
          if (
            resolvedBinding?.constant &&
            resolvedBinding.path.isVariableDeclarator() &&
            resolvedBinding.path.node.id.type === 'Identifier' &&
            (!importedConst || resolvedBinding.kind === 'const')
          ) {
            constant = resolvedBinding.path.node;
          }
        }
        const value = ctx.stringLiteral(
          constant && constant.type === 'VariableDeclarator' ? constant.init : message,
        );
        if (value == null) return;
        const calls = callsByMessage.get(value) ?? [];
        calls.push({ constant, path: displayPath, line });
        callsByMessage.set(value, calls);
      },
    });
  }

  for (const [value, calls] of callsByMessage) {
    if (new Set(calls.map(({ path }) => path)).size < 2) continue;
    const firstCall = calls[0];
    if (!firstCall) continue;
    const constant = firstCall.constant;
    if (constant && calls.every((call) => call.constant === constant)) continue;
    const locations = [...new Set(calls.map(({ path, line }) => `${path}:${line}`))].sort();
    ctx.report(
      'error-message-duplicate',
      `错误文案 ${JSON.stringify(value)} 在多个文件重复出现（${locations.join('、')}）；提取到 packages/core/src/errors.ts 或 packages/shared 的命名常量后再引用，API 内部可用 packages/api/src/http/errors.ts`,
    );
  }
}

export const apiRulesModule: RuleModule = {
  rules: API_RULES,
  run(ctx) {
    checkApiStaticRules(ctx);
    checkApiAstRules(ctx);
    checkDuplicateErrorMessages(ctx);
  },
};
