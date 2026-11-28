import traverse, { type Binding, type NodePath } from '@babel/traverse';
import { type AstNode, destructuredPropertyPath, staticMemberName } from './ast-utils.js';
import type { ContractContext, RuleModule } from './context.js';

const WORKER_RULES = [
  'worker-single-composition-root',
  'worker-scheduler-setinterval',
  'worker-handrolled-single-flight',
] as const;

const workerCompositionRoots = new Set([
  'packages/worker/src/index.ts',
  'packages/worker/src/maintenance.ts',
]);

function isPromiseShaped(ctx: ContractContext, node: AstNode | null | undefined): boolean {
  const type = ctx.unwrapExpression(node)?.type;
  return type === 'CallExpression' || type === 'OptionalCallExpression' || type === 'NewExpression';
}

function receiverIdentity(
  ctx: ContractContext,
  path: NodePath<AstNode | null>,
): { root: Binding | string; pathKey: string } {
  const segments: string[] = [];
  let node: AstNode | null | undefined = ctx.unwrapExpression(path.node);
  while (node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression') {
    const name = staticMemberName(node);
    if (name === undefined) return { root: `expr:${path.toString()}`, pathKey: '' };
    segments.unshift(name);
    node = ctx.unwrapExpression(node.object);
  }
  if (node?.type !== 'Identifier') return { root: `expr:${path.toString()}`, pathKey: '' };
  return {
    root: path.scope.getBinding(node.name) ?? `id:${node.name}`,
    pathKey: JSON.stringify(segments),
  };
}

function isModuleNamespaceExpr(
  ctx: ContractContext,
  path: NodePath<AstNode | null>,
  seen: Set<Binding> = new Set(),
): boolean {
  const unwrapped = ctx.unwrapNodePath(path);
  if (unwrapped.node === null) return false;
  if (unwrapped.isImportExpression()) return true;
  if (unwrapped.isAwaitExpression()) {
    return isModuleNamespaceExpr(ctx, unwrapped.get('argument'), seen);
  }
  if (
    (unwrapped.isCallExpression() || unwrapped.isOptionalCallExpression()) &&
    ctx.isUnboundGlobalOrMember(unwrapped.get('callee'), 'require')
  ) {
    return true;
  }
  if (!unwrapped.isIdentifier()) return false;
  const binding = unwrapped.scope.getBinding(unwrapped.node.name);
  if (!binding) return false;
  if (
    binding.path.isImportNamespaceSpecifier() &&
    binding.path.parent.type === 'ImportDeclaration' &&
    binding.path.parent.importKind !== 'type'
  ) {
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
    return isModuleNamespaceExpr(ctx, binding.path.get('init'), seen);
  }
  return false;
}

function matchesCompositionTarget(
  ctx: ContractContext,
  path: NodePath<AstNode | null>,
  targetName: string,
  seen: Set<Binding> = new Set(),
): boolean {
  const unwrapped = ctx.unwrapNodePath(path);
  if (unwrapped.node === null) return false;
  if (ctx.isMember(unwrapped.node, targetName)) return true;
  if (!unwrapped.isIdentifier()) return false;
  const name = unwrapped.node.name;
  const binding = unwrapped.scope.getBinding(name);
  if (!binding) return name === targetName;
  if (ctx.importedBinding(binding)?.name === targetName) return true;
  if (binding.path.isImportDefaultSpecifier() && name === targetName) return true;
  if (binding.constant && binding.path.isVariableDeclarator() && binding.path.node.init) {
    const initPath = binding.path.get('init');
    if (binding.path.get('id').isIdentifier() && !seen.has(binding)) {
      seen.add(binding);
      return matchesCompositionTarget(ctx, initPath, targetName, seen);
    }
    if (binding.path.get('id').isObjectPattern()) {
      const prop = destructuredPropertyPath(binding.path.node.id, binding.identifier);
      return prop?.length === 1 && prop[0] === targetName && isModuleNamespaceExpr(ctx, initPath);
    }
  }
  return false;
}

function isSchedulerFile(displayPath: string): boolean {
  return (
    displayPath.startsWith('packages/worker/src/') &&
    (displayPath.endsWith('scheduler.ts') ||
      displayPath.endsWith('reconcile.ts') ||
      displayPath === 'packages/worker/src/data-domains/build.ts' ||
      displayPath === 'packages/worker/src/data-domains/enrich.ts' ||
      displayPath === 'packages/worker/src/integrations/deliver.ts')
  );
}

export const workerRulesModule: RuleModule = {
  rules: WORKER_RULES,
  run(ctx) {
    const checkComposition = ctx.hasRule('worker-single-composition-root');
    const checkSetInterval = ctx.hasRule('worker-scheduler-setinterval');
    const checkSingleFlight = ctx.hasRule('worker-handrolled-single-flight');

    for (const file of ctx.workerFiles) {
      const displayPath = ctx.rel(file);
      const isRoot = workerCompositionRoots.has(displayPath);
      const scheduler = isSchedulerFile(displayPath);
      const needComposition = checkComposition && !isRoot;
      const needScheduler = scheduler && (checkSetInterval || checkSingleFlight);
      if (!needComposition && !needScheduler) continue;

      const inFlightAssignments = new Map<
        Binding | string,
        Map<string, { hasNull: boolean; nonNullLine: number | undefined }>
      >();
      const noteInFlight = (
        root: Binding | string,
        pathKey: string,
        rhs: AstNode,
        line: number,
      ): void => {
        const byPath = inFlightAssignments.get(root) ?? new Map();
        const entry = byPath.get(pathKey) ?? { hasNull: false, nonNullLine: undefined };
        if (ctx.unwrapExpression(rhs)?.type === 'NullLiteral') entry.hasNull = true;
        else if (isPromiseShaped(ctx, rhs)) {
          entry.nonNullLine =
            entry.nonNullLine === undefined ? line : Math.min(entry.nonNullLine, line);
        }
        byPath.set(pathKey, entry);
        inFlightAssignments.set(root, byPath);
      };

      traverse(ctx.readModule(file).ast, {
        'VariableDeclarator|AssignmentExpression'(path) {
          if (!needScheduler || !checkSingleFlight) return;
          if (path.isVariableDeclarator()) {
            const id = path.node.id;
            if (id.type !== 'Identifier' || id.name !== 'inFlight') return;
            const binding = path.scope.getBinding('inFlight');
            if (!binding) return;
            if (path.node.init) {
              noteInFlight(binding, '', path.node.init, id.loc?.start.line ?? 0);
            }
            for (const violation of binding.constantViolations) {
              if (
                violation.isAssignmentExpression() &&
                violation.node.left.type === 'Identifier' &&
                violation.node.left.name === 'inFlight'
              ) {
                noteInFlight(
                  binding,
                  '',
                  violation.node.right,
                  violation.node.left.loc?.start.line ?? 0,
                );
              }
            }
            return;
          }
          const target = path.node.left;
          if (!ctx.isMember(target, 'inFlight')) return;
          const leftObj = path.get('left.object');
          if (!leftObj || Array.isArray(leftObj)) return;
          const { root, pathKey } = receiverIdentity(ctx, leftObj);
          noteInFlight(root, pathKey, path.node.right, target.loc?.start.line ?? 0);
        },
        'CallExpression|OptionalCallExpression'(path) {
          const { callee, loc } = path.node;
          const line = loc?.start.line ?? 0;
          if (needComposition && matchesCompositionTarget(ctx, path.get('callee'), 'createDb')) {
            ctx.report(
              'worker-single-composition-root',
              `${displayPath}:${line}: 禁止在组合根（index.ts / maintenance.ts）之外调用 createDb()（通过依赖注入传入 db）`,
            );
          }
          if (needScheduler && checkSetInterval) {
            const identifier = callee.type === 'Identifier' ? callee.name : undefined;
            if (
              (identifier === 'setInterval' && !path.scope.getBinding(identifier)) ||
              (ctx.isMember(callee, 'setInterval') &&
                (callee.type === 'MemberExpression' ||
                  callee.type === 'OptionalMemberExpression') &&
                callee.object.type === 'Identifier' &&
                callee.object.name === 'globalThis' &&
                !path.scope.getBinding('globalThis'))
            ) {
              ctx.report(
                'worker-scheduler-setinterval',
                `${displayPath}:${line}: 调度器直接调用 setInterval（改用 packages/worker/src/interval-ticker.ts 的 startIntervalTicker 管理定时与关停，双入口 sync 通过 packages/worker/src/scheduling/single-flight.ts 的 startSingleFlight 共用单飞守卫）`,
              );
            }
          }
        },
        NewExpression(path) {
          if (
            needComposition &&
            matchesCompositionTarget(ctx, path.get('callee'), 'DockerSandboxProvider')
          ) {
            ctx.report(
              'worker-single-composition-root',
              `${displayPath}:${path.node.loc?.start.line ?? 0}: 禁止在组合根（index.ts / maintenance.ts）之外实例化 new DockerSandboxProvider()（通过依赖注入传入 sandbox provider）`,
            );
          }
        },
      });

      if (needScheduler && checkSingleFlight) {
        for (const byPath of inFlightAssignments.values()) {
          for (const { hasNull, nonNullLine } of byPath.values()) {
            if (!hasNull || nonNullLine === undefined) continue;
            ctx.report(
              'worker-handrolled-single-flight',
              `${displayPath}:${nonNullLine}: 调度器手写 inFlight（改用 packages/worker/src/scheduling/single-flight.ts 的 startSingleFlight，对应 formal/scheduler-sync/SchedulerSync.tla 的单飞守卫 InFlight = {}）`,
            );
          }
        }
      }
    }
  },
};
