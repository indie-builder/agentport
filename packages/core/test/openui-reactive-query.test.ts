import { describe, expect, mock, test } from 'bun:test';
import { createOpenUiDefinitions } from '@agentport/shared';
import {
  action,
  createLibrary,
  createParser,
  createQueryManager,
  createStore,
  type DefinedComponent,
  defineComponent,
  type EvaluationContext,
  evaluate,
  markReactive,
  type ParseResult,
} from '@openuidev/lang-core';
import { waitFor } from './fixtures/wait-for.js';

const reactive = <T extends object>(schema: T): T => {
  markReactive(schema);
  return schema;
};
const definitions = createOpenUiDefinitions({ defineComponent, action, reactive }, {});
const library = createLibrary({
  root: definitions.root,
  components: definitions.components as unknown as DefinedComponent[],
});
const parser = createParser(library.toJSONSchema(), 'Card');

const PROGRAM = [
  '$status = "open"',
  'root = Card([t])',
  't = Table([Col("Title", tickets.rows.title)])',
  'tickets = Query("list_tickets", { status: $status }, { rows: [] })',
].join('\n');

function queryNodes(result: ParseResult, ctx: EvaluationContext) {
  return result.queryStatements.map((statement) => ({
    statementId: statement.statementId,
    toolName: statement.toolAST ? String(evaluate(statement.toolAST, ctx)) : '',
    args: statement.argsAST ? evaluate(statement.argsAST, ctx) : null,
    defaults: statement.defaultsAST ? evaluate(statement.defaultsAST, ctx) : null,
    deps: undefined,
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

    const callTool = mock(async (name: string, args: Record<string, unknown>) => ({
      rows: [{ title: `${name}:${String(args.status)}` }],
    }));
    const manager = createQueryManager({ callTool } as never);
    manager.activate();

    const ctx = (): EvaluationContext => ({
      getState: (name) => store.get(name),
      resolveRef: (name) => manager.getResult(name),
    });

    manager.evaluateQueries(queryNodes(result, ctx()));
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    expect(callTool).toHaveBeenLastCalledWith('list_tickets', { status: 'open' });

    store.set('$status', 'closed');
    manager.evaluateQueries(queryNodes(result, ctx()));
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
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
