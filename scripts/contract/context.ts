import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { parse } from '@babel/parser';
import traverse, { type Binding, type NodePath } from '@babel/traverse';
import {
  type AstNode,
  importedBinding,
  isInTypePosition,
  isMember,
  isUnboundGlobalOrMember,
  nameOf,
  type ParsedModule,
  stringLiteral,
  unwrapExpression,
  unwrapNodePath,
} from './ast-utils.js';
import { findCycles } from './cycles.js';
import {
  lineAt,
  scanTemplateLiteral,
  skipBalancedBraces,
  skipBalancedParens,
  skipQuoted,
  stripComments,
  stripCssComments,
} from './scanner.js';

type ModuleImport = {
  specifier: string;
  line: number;
  isTypeOnly: boolean;
  isDynamic: boolean;
};

export type ContractContext = {
  root: string;
  problems: string[];
  hasRule: (rule: string) => boolean;
  hasAnyRule: (rules: readonly string[]) => boolean;
  report: (rule: string, message: string) => void;
  walk: (dir: string, ext: RegExp) => string[];
  rel: (file: string) => string;
  read: (file: string) => string;
  readStripped: (file: string) => string;
  readModule: (file: string) => ParsedModule;
  getModuleImports: (file: string) => ModuleImport[];
  extractModuleImports: (file: string) => ModuleImport[];
  lineAt: (src: string, index: number) => number;
  stripComments: (src: string) => string;
  stripCssComments: (src: string) => string;
  scanTemplateLiteral: typeof scanTemplateLiteral;
  skipBalancedBraces: typeof skipBalancedBraces;
  skipBalancedParens: typeof skipBalancedParens;
  skipQuoted: typeof skipQuoted;
  importedBinding: typeof importedBinding;
  unwrapExpression: typeof unwrapExpression;
  unwrapNodePath: typeof unwrapNodePath;
  stringLiteral: typeof stringLiteral;
  isMember: typeof isMember;
  isUnboundGlobalOrMember: typeof isUnboundGlobalOrMember;
  matchesPackage: (spec: string, pkg: string) => boolean;
  checkForbiddenImports: (
    files: readonly string[],
    forbiddenPackages: readonly string[],
    onViolation: (file: string, imp: ModuleImport) => void,
  ) => void;
  checkEnvAccess: (
    files: readonly string[],
    excludeRelPath: string | null,
    onViolation: (displayPath: string, line: number, source: string) => void,
  ) => void;
  resolveModule: (file: string, specifier: string) => string | undefined;
  findCycles: typeof findCycles;
  packagesDir: string;
  webFiles: string[];
  apiFiles: string[];
  workerFiles: string[];
  coreFiles: string[];
  sharedFiles: string[];
  contractFiles: string[];
  dbFiles: string[];
  dbSchemaFiles: string[];
  sandboxFiles: string[];
  allSrcFiles: string[];
};

export type RuleModule = {
  rules: readonly string[];
  run: (ctx: ContractContext) => void;
};

export function matchesPackage(spec: string, pkg: string): boolean {
  return spec === pkg || spec.startsWith(`${pkg}/`);
}

function walkDir(dir: string, ext: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkDir(full, ext));
    else if (ext.test(name)) out.push(full);
  }
  return out;
}

function envSourceOfModule(specifier: string): 'process' | 'Bun' | null {
  if (specifier === 'node:process' || specifier === 'process') return 'process';
  if (specifier === 'bun') return 'Bun';
  return null;
}

function resolveEnvRootSource(
  path: NodePath<AstNode | null>,
  seen: Set<Binding> = new Set(),
): 'process' | 'Bun' | null {
  const unwrapped = unwrapNodePath(path);
  if (unwrapped.node === null) return null;
  if (unwrapped.isIdentifier()) {
    const name = unwrapped.node.name;
    const binding = unwrapped.scope.getBinding(name);
    if (!binding) return name === 'process' ? 'process' : name === 'Bun' ? 'Bun' : null;
    const impPath = binding.path;
    if (
      (impPath.isImportDefaultSpecifier() || impPath.isImportNamespaceSpecifier()) &&
      impPath.parent.type === 'ImportDeclaration' &&
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
  if (unwrapped.isMemberExpression() || unwrapped.isOptionalMemberExpression()) {
    if (isMember(unwrapped.node, 'default')) {
      return resolveEnvRootSource(unwrapped.get('object'), seen);
    }
    const target = isMember(unwrapped.node, 'process')
      ? 'process'
      : isMember(unwrapped.node, 'Bun')
        ? 'Bun'
        : null;
    if (!target) return null;
    const obj = unwrapNodePath(unwrapped.get('object'));
    if (obj.node === null) return null;
    return obj.isIdentifier() &&
      obj.node.name === 'globalThis' &&
      !obj.scope.getBinding('globalThis')
      ? target
      : null;
  }
  if (unwrapped.isAwaitExpression()) {
    const arg = unwrapNodePath(unwrapped.get('argument'));
    if (arg.isImportExpression()) {
      const spec = stringLiteral(arg.node.source);
      return spec ? envSourceOfModule(spec) : null;
    }
  }
  if (unwrapped.isImportExpression()) {
    const spec = stringLiteral(unwrapped.node.source);
    return spec ? envSourceOfModule(spec) : null;
  }
  if (
    (unwrapped.isCallExpression() || unwrapped.isOptionalCallExpression()) &&
    isUnboundGlobalOrMember(unwrapped.get('callee'), 'require')
  ) {
    const spec = stringLiteral(unwrapped.node.arguments[0]);
    return spec ? envSourceOfModule(spec) : null;
  }
  return null;
}

function isEnvObjectProperty(prop: AstNode): boolean {
  if (prop.type !== 'ObjectProperty') return false;
  if (!prop.computed && prop.key.type === 'Identifier') return prop.key.name === 'env';
  return stringLiteral(prop.key) === 'env';
}

export function createContractContext(
  root: string,
  activeRules: ReadonlySet<string> | null,
): ContractContext {
  const problems: string[] = [];
  const fileSources = new Map<string, string>();
  const strippedSources = new Map<string, string>();
  const modules = new Map<string, ParsedModule>();
  const fileImports = new Map<string, ModuleImport[]>();

  const hasRule = (rule: string): boolean => !activeRules || activeRules.has(rule);
  const hasAnyRule = (rules: readonly string[]): boolean =>
    !activeRules || rules.some((rule) => activeRules.has(rule));

  const report = (rule: string, message: string): void => {
    if (activeRules && !activeRules.has(rule)) return;
    problems.push(`[${rule}] ${message}`);
  };

  const rel = (file: string): string => relative(root, file);

  const read = (file: string): string => {
    const cached = fileSources.get(file);
    if (cached !== undefined) return cached;
    const text = readFileSync(file, 'utf8');
    fileSources.set(file, text);
    return text;
  };

  const readStripped = (file: string): string => {
    const cached = strippedSources.get(file);
    if (cached !== undefined) return cached;
    const stripped = stripComments(read(file));
    strippedSources.set(file, stripped);
    return stripped;
  };

  const readModule = (file: string): ParsedModule => {
    const cached = modules.get(file);
    if (cached) return cached;
    const ast = parse(read(file), {
      sourceFilename: file,
      sourceType: 'module',
      plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
    });
    let parsed: ParsedModule | undefined;
    traverse(ast, {
      Program(path) {
        parsed = { ast, program: path };
        modules.set(file, parsed);
        path.stop();
      },
    });
    if (!parsed) throw new Error(`Failed to traverse program: ${file}`);
    return parsed;
  };

  const extractModuleImports = (file: string): ModuleImport[] => {
    const imports: ModuleImport[] = [];
    const push = (
      specifier: string | undefined,
      line: number,
      isTypeOnly: boolean,
      isDynamic: boolean,
    ): void => {
      if (specifier !== undefined) imports.push({ specifier, line, isTypeOnly, isDynamic });
    };
    traverse(readModule(file).ast, {
      ImportDeclaration(path) {
        const { importKind, specifiers, source, loc } = path.node;
        const isTypeOnly =
          importKind === 'type' ||
          (specifiers.length > 0 &&
            specifiers.every(
              (spec) => spec.type === 'ImportSpecifier' && spec.importKind === 'type',
            ));
        push(source.value, loc?.start.line ?? 0, isTypeOnly, false);
      },
      ExportNamedDeclaration(path) {
        const { exportKind, specifiers, source, loc } = path.node;
        if (!source) return;
        const isTypeOnly =
          exportKind === 'type' ||
          (specifiers.length > 0 &&
            specifiers.every(
              (spec) => spec.type === 'ExportSpecifier' && spec.exportKind === 'type',
            ));
        push(source.value, loc?.start.line ?? 0, isTypeOnly, false);
      },
      ExportAllDeclaration(path) {
        const { exportKind, source, loc } = path.node;
        push(source.value, loc?.start.line ?? 0, exportKind === 'type', false);
      },
      TSImportEqualsDeclaration(path) {
        const { importKind, moduleReference, loc } = path.node;
        if (moduleReference.type === 'TSExternalModuleReference') {
          push(
            moduleReference.expression.value,
            loc?.start.line ?? 0,
            importKind === 'type',
            false,
          );
        }
      },
      ImportExpression(path) {
        push(stringLiteral(path.node.source), path.node.loc?.start.line ?? 0, false, true);
      },
      TSImportType(path) {
        push(stringLiteral(path.node.source), path.node.loc?.start.line ?? 0, true, false);
      },
      'CallExpression|OptionalCallExpression'(path) {
        if (!isUnboundGlobalOrMember(path.get('callee'), 'require')) return;
        push(stringLiteral(path.node.arguments[0]), path.node.loc?.start.line ?? 0, false, true);
      },
    });
    return imports;
  };

  const getModuleImports = (file: string): ModuleImport[] => {
    const cached = fileImports.get(file);
    if (cached) return cached;
    const computed = extractModuleImports(file);
    fileImports.set(file, computed);
    return computed;
  };

  const checkForbiddenImports = (
    files: readonly string[],
    forbiddenPackages: readonly string[],
    onViolation: (file: string, imp: ModuleImport) => void,
  ): void => {
    for (const file of files) {
      for (const imp of getModuleImports(file)) {
        if (forbiddenPackages.some((pkg) => matchesPackage(imp.specifier, pkg))) {
          onViolation(file, imp);
        }
      }
    }
  };

  const checkEnvAccess = (
    files: readonly string[],
    excludeRelPath: string | null,
    onViolation: (displayPath: string, line: number, source: string) => void,
  ): void => {
    for (const file of files) {
      const displayPath = rel(file);
      if (excludeRelPath && displayPath === excludeRelPath) continue;
      traverse(readModule(file).ast, {
        'MemberExpression|OptionalMemberExpression'(path) {
          if (!isMember(path.node, 'env') || isInTypePosition(path)) return;
          const source = resolveEnvRootSource(path.get('object'));
          if (source) onViolation(displayPath, path.node.loc?.start.line ?? 0, source);
        },
        'VariableDeclarator|AssignmentExpression'(path) {
          const pattern = path.isVariableDeclarator() ? path.node.id : path.node.left;
          const rhsPath = path.isVariableDeclarator() ? path.get('init') : path.get('right');
          if (pattern.type !== 'ObjectPattern' || !rhsPath.hasNode()) return;
          const source = resolveEnvRootSource(rhsPath);
          if (!source) return;
          for (const prop of pattern.properties) {
            if (isEnvObjectProperty(prop)) {
              onViolation(displayPath, prop.loc?.start.line ?? 0, source);
            }
          }
        },
        ImportSpecifier(path) {
          const binding = path.scope.getBinding(path.node.local.name);
          const imp = importedBinding(binding);
          const source = imp?.name === 'env' ? envSourceOfModule(imp.source) : null;
          if (!source || !binding) return;
          for (const refPath of binding.referencePaths) {
            if (isInTypePosition(refPath)) continue;
            const parent = refPath.parentPath;
            if (
              parent?.isExportSpecifier() &&
              (parent.node.exportKind === 'type' ||
                (parent.parent.type === 'ExportNamedDeclaration' &&
                  parent.parent.exportKind === 'type'))
            ) {
              continue;
            }
            onViolation(displayPath, refPath.node.loc?.start.line ?? 0, source);
          }
        },
        ExportNamedDeclaration(path) {
          const { exportKind, specifiers, source } = path.node;
          if (!source || exportKind === 'type') return;
          const envSource = envSourceOfModule(source.value);
          if (!envSource) return;
          for (const spec of specifiers) {
            if (
              spec.type === 'ExportSpecifier' &&
              spec.exportKind !== 'type' &&
              nameOf(spec.local) === 'env'
            ) {
              onViolation(displayPath, spec.loc?.start.line ?? 0, envSource);
            }
          }
        },
      });
    }
  };

  const resolveSourceTarget = (base: string): string | undefined => {
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
  };

  const resolveModule = (file: string, specifier: string): string | undefined => {
    const workspace = /^@agentport\/([^/]+)(?:\/(.+))?$/.exec(specifier);
    if (workspace?.[1]) {
      return resolveSourceTarget(
        join(root, 'packages', workspace[1], 'src', workspace[2] ?? 'index'),
      );
    }
    if (specifier.startsWith('@/') && rel(file).startsWith('packages/web/src/')) {
      return resolveSourceTarget(join(root, 'packages/web/src', specifier.slice(2)));
    }
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;
    return resolveSourceTarget(join(dirname(file), specifier));
  };

  const packagesDir = join(root, 'packages');
  const webFiles = walkDir(join(root, 'packages/web/src'), /\.(ts|tsx)$/);
  const apiFiles = walkDir(join(root, 'packages/api/src'), /\.(ts|tsx)$/);
  const workerFiles = walkDir(join(root, 'packages/worker/src'), /\.(ts|tsx)$/);
  const coreFiles = walkDir(join(root, 'packages/core/src'), /\.ts$/);
  const sharedFiles = walkDir(join(root, 'packages/shared/src'), /\.ts$/);
  const contractFiles = walkDir(join(root, 'packages/contract/src'), /\.ts$/);
  const dbFiles = walkDir(join(root, 'packages/db/src'), /\.ts$/);
  const dbSchemaFiles = walkDir(join(root, 'packages/db/src/schema'), /\.ts$/);
  const sandboxFiles = walkDir(join(root, 'packages/sandbox/src'), /\.(ts|tsx)$/);
  const allSrcFiles = existsSync(packagesDir)
    ? readdirSync(packagesDir)
        .sort()
        .flatMap((name) => walkDir(join(packagesDir, name, 'src'), /\.(ts|tsx)$/))
    : [];

  return {
    root,
    problems,
    hasRule,
    hasAnyRule,
    report,
    walk: walkDir,
    rel,
    read,
    readStripped,
    readModule,
    getModuleImports,
    extractModuleImports,
    lineAt,
    stripComments,
    stripCssComments,
    scanTemplateLiteral,
    skipBalancedBraces,
    skipBalancedParens,
    skipQuoted,
    importedBinding,
    unwrapExpression,
    unwrapNodePath,
    stringLiteral,
    isMember,
    isUnboundGlobalOrMember,
    matchesPackage,
    checkForbiddenImports,
    checkEnvAccess,
    resolveModule,
    findCycles,
    packagesDir,
    webFiles,
    apiFiles,
    workerFiles,
    coreFiles,
    sharedFiles,
    contractFiles,
    dbFiles,
    dbSchemaFiles,
    sandboxFiles,
    allSrcFiles,
  };
}
