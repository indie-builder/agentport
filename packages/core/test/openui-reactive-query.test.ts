import { createOpenUiDefinitions } from '@agentport/shared';
import {
  action,
  createLibrary,
  createParser,
  createQueryManager,
  createStore,
  defineComponent,
  type EvaluationContext,
  evaluate,
  markReactive,
  type ParseResult,
} from '@openuidev/lang-core';
import { describe, expect, test, vi } from 'vitest';

/**
 * 原生绑定语义必须真的能跑：`reactive()` 标记的字段写入 `$变量` 后，
 * 依赖该变量的 Query 要按新参数重新执行。
 *
 * 这里用 lang-core 的 store/queryManager 复现渲染器的调用顺序，
 * 验证的是 shared 定义（而不是浏览器组件）提供的绑定能力。
 */
const reactive = <T extends object>(schema: T): T => {
  markReactive(schema);
  return schema;
};
const definitions = createOpenUiDefinitions({ defineComponent, action, reactive }, {});
const library = createLibrary({ root: definitions.root, components: definitions.components });
const parser = createParser(library.toJSONSchema(), 'Card');

const PROGRAM = [
  '$status = "open"',
  'root = Card([t])',
  't = Table([Col("Title", tickets.rows.title)])',
  'tickets = Query("list_tickets", { status: $status }, { rows: [] })',
].join('\n');

/** 复现渲染器的求值顺序：Query 的 toolName/args 都基于当前 store 快照求值。 */
function queryNodes(result: ParseResult, ctx: EvaluationContext) {
  return result.queryStatements.map((statement) => ({
    statementId: statement.statementId,
    toolName: statement.toolAST ? String(evaluate(statement.toolAST, ctx)) : '',
    args: statement.argsAST ? evaluate(statement.argsAST, ctx) : null,
    defaults: statement.defaultsAST ? evaluate(statement.defaultsAST, ctx) : null,
    complete: statement.complete,
  }));
}

describe('reactive bindings drive Query re-execution', () => {
  test('changing a $variable re-runs the Query with the new argument', async () => {
    const result = parser.parse(PROGRAM);
    expect(result.meta.errors).toEqual([]);
    expect(result.stateDeclarations).toEqual({ $status: 'open' });

    const store = createStore();
    store.initialize(result.stateDeclarations, {});

    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      rows: [{ title: `${name}:${String(args.status)}` }],
    }));
    const manager = createQueryManager({ callTool } as never);
    manager.activate();

    const ctx = (): EvaluationContext => ({
      getState: (name) => store.get(name),
      resolveRef: (name) => manager.getResult(name),
      functions: undefined,
      actions: undefined,
    });

    manager.evaluateQueries(queryNodes(result, ctx()));
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    expect(callTool).toHaveBeenLastCalledWith('list_tickets', { status: 'open' });

    // 用户改了 Select/Input：store 里写入新的 $status，渲染器会重新求值并调用 evaluateQueries。
    store.set('$status', 'closed');
    manager.evaluateQueries(queryNodes(result, ctx()));
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
    expect(callTool).toHaveBeenLastCalledWith('list_tickets', { status: 'closed' });
    expect(manager.getResult('tickets')).toEqual({
      rows: [{ title: 'list_tickets:closed' }],
    });

    manager.dispose();
    store.dispose();
  });

  test('Input.value is retained as a binding reference, not flattened at parse time', () => {
    const result = parser.parse(
      'root = Card([i])\ni = Input("name", "ph", "text", null, $name)\n$name = "Ada"',
    );
    expect(result.meta.errors).toEqual([]);
    expect(result.stateDeclarations).toEqual({ $name: 'Ada' });
    const child = result.root?.props.children as unknown;
    expect(JSON.stringify(child)).toContain('"k":"StateRef"');
  });
});
