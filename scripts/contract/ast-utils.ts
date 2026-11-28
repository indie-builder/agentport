import type { ParseResult } from '@babel/parser';
import type { Binding, NodePath } from '@babel/traverse';

export type AstNode = NodePath['node'];
type ProgramNode = ParseResult['program'];

export type ParsedModule = {
  ast: ParseResult;
  program: NodePath<ProgramNode>;
};

export type ImportedBindingInfo = {
  source: string;
  name: string;
};

export type PackageRef = {
  source: string;
  path: string[];
};

export type ResolvedExport = {
  file: string;
  binding?: Binding;
  path: NodePath;
};

export function nameOf(node: AstNode): string {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'StringLiteral') return node.value;
  return '';
}

export function importedBinding(binding: Binding | undefined): ImportedBindingInfo | undefined {
  const path = binding?.path;
  if (!path?.isImportSpecifier() || path.node.importKind === 'type') return undefined;
  const declaration = path.parent;
  if (declaration.type !== 'ImportDeclaration' || declaration.importKind === 'type') {
    return undefined;
  }
  return { source: declaration.source.value, name: nameOf(path.node.imported) };
}

export function unwrapExpression(node: AstNode | null | undefined): AstNode | null | undefined {
  let current = node;
  while (
    current?.type === 'TSAsExpression' ||
    current?.type === 'TSSatisfiesExpression' ||
    current?.type === 'TSNonNullExpression' ||
    current?.type === 'ParenthesizedExpression'
  ) {
    current = current.expression;
  }
  return current;
}

export function unwrapNodePath(path: NodePath<AstNode | null>): NodePath<AstNode | null> {
  let current: NodePath<AstNode | null> = path;
  while (
    current.isTSAsExpression() ||
    current.isTSSatisfiesExpression() ||
    current.isTSNonNullExpression() ||
    current.isParenthesizedExpression()
  ) {
    current = current.get('expression');
  }
  return current;
}

export function stringLiteral(node: AstNode | null | undefined): string | undefined {
  const unwrapped = unwrapExpression(node);
  if (unwrapped?.type === 'StringLiteral') return unwrapped.value;
  if (unwrapped?.type === 'TemplateLiteral' && unwrapped.expressions.length === 0) {
    return unwrapped.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

export function isMember(node: AstNode | null | undefined, name: string): boolean {
  if (!node || (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression')) {
    return false;
  }
  if (!node.computed) return node.property.type === 'Identifier' && node.property.name === name;
  if (node.property.type === 'StringLiteral') return node.property.value === name;
  return (
    node.property.type === 'TemplateLiteral' &&
    node.property.expressions.length === 0 &&
    node.property.quasis[0]?.value.cooked === name
  );
}

export function staticMemberName(node: AstNode): string | undefined {
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') {
    return undefined;
  }
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : undefined;
  if (node.property.type === 'StringLiteral') return node.property.value;
  if (node.property.type === 'TemplateLiteral' && node.property.expressions.length === 0) {
    return node.property.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

export function isUnboundGlobalOrMember(path: NodePath<AstNode | null>, name: string): boolean {
  const unwrapped = unwrapNodePath(path);
  if (unwrapped.node === null) return false;
  if (unwrapped.isIdentifier() && unwrapped.node.name === name) {
    return !unwrapped.scope.getBinding(name);
  }
  if (
    (unwrapped.isMemberExpression() || unwrapped.isOptionalMemberExpression()) &&
    isMember(unwrapped.node, name)
  ) {
    const obj = unwrapNodePath(unwrapped.get('object'));
    if (obj.node === null) return false;
    return (
      obj.isIdentifier() && obj.node.name === 'globalThis' && !obj.scope.getBinding('globalThis')
    );
  }
  return false;
}

export function isInTypePosition(path: NodePath): boolean {
  return Boolean(path.findParent((parent) => parent.isTSType() || parent.isTSTypeQuery()));
}

export function destructuredPropertyPath(
  pattern: AstNode | null | undefined,
  identifierNode: AstNode,
): string[] | null {
  if (pattern === identifierNode) return [];
  if (pattern?.type === 'AssignmentPattern') {
    return destructuredPropertyPath(pattern.left, identifierNode);
  }
  if (pattern?.type !== 'ObjectPattern') return null;
  for (const prop of pattern.properties) {
    if (prop.type !== 'ObjectProperty') continue;
    const subPath = destructuredPropertyPath(prop.value, identifierNode);
    if (!subPath) continue;
    const key =
      !prop.computed && prop.key.type === 'Identifier' ? prop.key.name : stringLiteral(prop.key);
    return key === undefined ? null : [key, ...subPath];
  }
  return null;
}

export function resolvePackageRef(
  path: NodePath<AstNode | null>,
  seen: Set<Binding> = new Set(),
): PackageRef | null {
  const unwrapped = unwrapNodePath(path);
  if (unwrapped.node === null) return null;
  if (unwrapped.isAwaitExpression()) {
    return resolvePackageRef(unwrapped.get('argument'), seen);
  }
  if (unwrapped.isImportExpression()) {
    const spec = stringLiteral(unwrapped.node.source);
    return spec ? { source: spec, path: [] } : null;
  }
  if (
    (unwrapped.isCallExpression() || unwrapped.isOptionalCallExpression()) &&
    isUnboundGlobalOrMember(unwrapped.get('callee'), 'require')
  ) {
    const spec = stringLiteral(unwrapped.node.arguments[0]);
    return spec ? { source: spec, path: [] } : null;
  }
  if (unwrapped.isMemberExpression() || unwrapped.isOptionalMemberExpression()) {
    const prop = staticMemberName(unwrapped.node);
    if (prop === undefined) return null;
    const base = resolvePackageRef(unwrapped.get('object'), seen);
    return base ? { source: base.source, path: [...base.path, prop] } : null;
  }
  if (!unwrapped.isIdentifier()) return null;
  const binding = unwrapped.scope.getBinding(unwrapped.node.name);
  if (!binding) return null;
  const impPath = binding.path;
  if (
    impPath.isImportNamespaceSpecifier() &&
    impPath.parent.type === 'ImportDeclaration' &&
    impPath.parent.importKind !== 'type'
  ) {
    return { source: impPath.parent.source.value, path: [] };
  }
  if (
    impPath.isImportDefaultSpecifier() &&
    impPath.parent.type === 'ImportDeclaration' &&
    impPath.parent.importKind !== 'type'
  ) {
    return { source: impPath.parent.source.value, path: ['default'] };
  }
  const imp = importedBinding(binding);
  if (imp) return { source: imp.source, path: [imp.name] };
  if (
    binding.constant &&
    impPath.isVariableDeclarator() &&
    impPath.node.init &&
    !seen.has(binding)
  ) {
    seen.add(binding);
    const initPath = impPath.get('init');
    if (impPath.get('id').isIdentifier()) {
      return resolvePackageRef(initPath, seen);
    }
    if (impPath.get('id').isObjectPattern()) {
      const prop = destructuredPropertyPath(impPath.node.id, binding.identifier);
      if (!prop) return null;
      const base = resolvePackageRef(initPath, seen);
      return base ? { source: base.source, path: [...base.path, ...prop] } : null;
    }
  }
  return null;
}

export function resolveExports(
  readModule: (file: string) => ParsedModule,
  resolveModule: (file: string, specifier: string) => string | undefined,
  file: string | undefined,
  name: string,
  active: Set<string> = new Set(),
): (ResolvedExport | null)[] {
  if (!file) return [null];
  const key = `${file}:${name}`;
  if (active.has(key)) return [];
  const next = new Set(active).add(key);
  const { program } = readModule(file);
  const binding = program.scope.getOwnBinding(name);
  const stars: string[] = [];
  const bodyPaths = program.get('body');
  for (const statementPath of bodyPaths) {
    const statement = statementPath.node;
    if (statement.type === 'ExportNamedDeclaration' && statement.exportKind === 'type') continue;
    if (statement.type === 'ExportAllDeclaration') {
      if (statement.exportKind === 'type') continue;
      stars.push(statement.source.value);
      continue;
    }
    if (statement.type !== 'ExportNamedDeclaration') continue;
    if (statement.declaration && binding?.path.findParent((p) => p.node === statement)) {
      return [{ file, binding, path: binding.path }];
    }
    const specPaths = statementPath.isExportNamedDeclaration()
      ? statementPath.get('specifiers')
      : [];
    const specPath = specPaths.find(
      (entry) =>
        (!entry.isExportSpecifier() || entry.node.exportKind !== 'type') &&
        nameOf(entry.node.exported) === name,
    );
    if (!specPath) continue;
    if (!specPath.isExportSpecifier()) return [{ file, path: specPath }];
    const local = nameOf(specPath.node.local);
    if (statement.source) {
      return resolveExports(
        readModule,
        resolveModule,
        resolveModule(file, statement.source.value),
        local,
        next,
      );
    }
    const localBinding = program.scope.getOwnBinding(local);
    const imported = importedBinding(localBinding);
    if (imported) {
      return resolveExports(
        readModule,
        resolveModule,
        resolveModule(file, imported.source),
        imported.name,
        next,
      );
    }
    return localBinding ? [{ file, binding: localBinding, path: localBinding.path }] : [];
  }
  const declarations = stars.flatMap((source) =>
    resolveExports(readModule, resolveModule, resolveModule(file, source), name, next),
  );
  const seenFiles = new Set<string>();
  const unique: (ResolvedExport | null)[] = [];
  for (const entry of declarations) {
    if (entry === null) {
      if (!seenFiles.has('null')) {
        seenFiles.add('null');
        unique.push(null);
      }
      continue;
    }
    const id = `${entry.file}:${entry.path.node.start ?? -1}:${entry.path.node.end ?? -1}`;
    if (!seenFiles.has(id)) {
      seenFiles.add(id);
      unique.push(entry);
    }
  }
  return unique;
}
