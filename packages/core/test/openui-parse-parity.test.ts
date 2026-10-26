import { createOpenUiDefinitions } from '@agentport/shared';
import {
  action,
  createLibrary,
  createParser,
  defineComponent,
  markReactive,
} from '@openuidev/lang-core';
import { openuiChatLibrary } from '@openuidev/react-ui/genui-lib';
import { describe, expect, test } from 'vitest';

/**
 * 行为对照：同一段程序，用本地真实 Zod 定义解析与官方库解析必须得到同一棵树。
 * 这比「schema 文本相同」更强——它覆盖默认值填补、联合类型判定与绑定保留。
 */
const reactive = <T extends object>(schema: T): T => {
  markReactive(schema);
  return schema;
};
const definitions = createOpenUiDefinitions({ defineComponent, action, reactive }, {});
const ours = createParser(
  createLibrary({
    root: definitions.root,
    components: definitions.components,
    componentGroups: definitions.componentGroups,
  }).toJSONSchema(),
  'Card',
);
const official = createParser(openuiChatLibrary.toJSONSchema(), 'Card');

const PROGRAMS: Array<{ name: string; program: string }> = [
  {
    name: 'Text with defaults omitted',
    program: 'root = Card([t])\nt = Text("text", "hello")',
  },
  {
    name: 'Text with every argument',
    program: 'root = Card([t])\nt = Text("number", "42", "+3%", "metric", "lg")',
  },
  {
    name: 'minItems 2 card block',
    program: [
      'root = Card([b])',
      'b = SnippetCardBlock([i1, i2])',
      'i1 = SnippetCardItem("a", l1)',
      'l1 = IconText(ic, "neutral", "m", "A", "x", false, "horizontal")',
      'i2 = SnippetCardItem("b", l2)',
      'l2 = IconText(ic, "neutral", "m", "B", "y", false, "horizontal")',
      'ic = Icon("star")',
    ].join('\n'),
  },
  {
    name: 'checkbox group dictionary binding',
    program: [
      'root = Card([g])',
      'g = CheckBoxGroup("g", [c], null, $picked)',
      'c = CheckBoxItem("Label", "Desc", "one")',
      '$picked = { one: true }',
    ].join('\n'),
  },
  {
    name: 'reactive input bound to a variable',
    program: 'root = Card([i])\ni = Input("name", "ph", "text", null, $name)\n$name = "Ada"',
  },
  {
    name: 'query depending on a variable and table plumbing',
    program: [
      '$status = "open"',
      'root = Card([t])',
      't = Table([Col("Title", tickets.rows.title)])',
      'tickets = Query("list_tickets", { status: $status }, { rows: [] })',
    ].join('\n'),
  },
];

const summary = (parser: { parse: (input: string) => unknown }, program: string) => {
  const result = parser.parse(program) as {
    root: unknown;
    stateDeclarations: unknown;
    queryStatements: unknown;
    meta: { errors: unknown[]; incomplete: boolean; unresolved: string[] };
  };
  return {
    root: result.root,
    stateDeclarations: result.stateDeclarations,
    queryStatements: result.queryStatements,
    errors: result.meta.errors,
    incomplete: result.meta.incomplete,
    unresolved: result.meta.unresolved,
  };
};

describe('parser behavior: local Zod definitions vs official library', () => {
  for (const { name, program } of PROGRAMS) {
    test(name, () => {
      expect(summary(ours, program)).toEqual(summary(official, program));
    });
  }

  test('Text omitted defaults are filled exactly like the official library', () => {
    const tree = summary(ours, PROGRAMS[0]?.program ?? '').root as {
      props: { children: Array<{ props: Record<string, unknown> }> };
    };
    expect(tree.props.children[0]?.props).toEqual({
      variant: 'text',
      value: 'hello',
      subtextVariant: 'text',
      size: 'sm',
    });
  });

  test('card block below the two-item minimum behaves like the official library', () => {
    const program = [
      'root = Card([b])',
      'b = SnippetCardBlock([i1])',
      'i1 = SnippetCardItem("a", l1)',
      'l1 = IconText(ic, "neutral", "m", "A", "x", false, "horizontal")',
      'ic = Icon("star")',
    ].join('\n');
    // 官方解析器不在解析期强制 minItems；约束由 schema 携带（library 测试覆盖），
    // 这里锁住「本地定义的解析结果与官方一致」。
    expect(summary(ours, program)).toEqual(summary(official, program));
    expect(ours.parse(program).root === null ? 0 : 1).toBe(
      official.parse(program).root === null ? 0 : 1,
    );
  });

  test('checkbox dictionary with a non-boolean value behaves like the official library', () => {
    const program = [
      'root = Card([g])',
      'g = CheckBoxGroup("g", [c], null, $picked)',
      'c = CheckBoxItem("Label", "Desc", "one")',
      '$picked = { one: "yes" }',
    ].join('\n');
    expect(summary(ours, program)).toEqual(summary(official, program));
  });
});
