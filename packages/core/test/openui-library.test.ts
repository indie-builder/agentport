import { createOpenUiDefinitions, OPENUI_COMPONENT_NAMES } from '@agentport/shared';
import {
  action,
  createLibrary,
  defineComponent,
  isReactiveSchema,
  markReactive,
} from '@openuidev/lang-core';
import { openuiChatLibrary } from '@openuidev/react-ui/genui-lib';
import { describe, expect, test } from 'vitest';

/**
 * shared 的真实 Zod 定义必须与官方 chat 库逐字节等价——默认值、约束、
 * record 值类型、refine 语义与响应式绑定都在其中。
 *
 * 服务端没有 react-lang；用 lang-core 的 markReactive 注入等价的 reactive 原语
 * （web 侧由 react-lang 的 reactive 提供，实现相同）。
 */
const reactive = <T extends object>(schema: T): T => {
  markReactive(schema);
  return schema;
};
const kit = { defineComponent, action, reactive };

const definitions = createOpenUiDefinitions(kit, {});
const ours = createLibrary({
  root: definitions.root,
  components: definitions.components,
  componentGroups: definitions.componentGroups,
});

describe('shared Zod definitions vs official chat library', () => {
  test('registers the same components in the official order', () => {
    expect(Object.keys(ours.components)).toEqual(Object.keys(openuiChatLibrary.components));
    expect(Object.keys(ours.components)).toEqual([...OPENUI_COMPONENT_NAMES]);
    expect(OPENUI_COMPONENT_NAMES).toHaveLength(84);
    expect(ours.root).toBe('Card');
  });

  test('JSON Schema is identical: defaults, minItems, record value types, refines', () => {
    expect(ours.toJSONSchema()).toEqual(openuiChatLibrary.toJSONSchema());
  });

  test('Text defaults survive (variant/subtextVariant/size stay required with defaults)', () => {
    const text = ours.toJSONSchema().$defs?.Text;
    expect(text?.properties?.variant).toMatchObject({ default: 'text' });
    expect(text?.properties?.subtextVariant).toMatchObject({ default: 'text' });
    expect(text?.properties?.size).toMatchObject({ default: 'sm' });
    // 有 default 的字段在官方签名里仍是可选参数，但 schema 里 required。
    expect(text?.required).toEqual(['variant', 'value', 'subtextVariant', 'size']);
    expect(ours.prompt()).toContain(
      'Text(variant?: "text" | "number", value: string, subtext?: string, subtextVariant?: "text" | "number" | "metric", size?: "xs" | "sm" | "md" | "lg")',
    );
  });

  test('card blocks keep minItems: 2', () => {
    for (const name of [
      'SnippetCardBlock',
      'OverviewCardBlock',
      'ContextCardBlock',
      'CompositeCardBlock',
      'VisualCardBlock',
    ]) {
      expect(ours.toJSONSchema().$defs?.[name]?.properties?.items).toMatchObject({ minItems: 2 });
    }
  });

  test('CheckBoxGroup value stays a boolean dictionary', () => {
    expect(ours.toJSONSchema().$defs?.CheckBoxGroup?.properties?.value).toMatchObject({
      type: 'object',
      additionalProperties: { type: 'boolean' },
    });
    expect(ours.prompt()).toContain('value?: $binding<Record<string, boolean>>');
  });

  test('Input.value is a reactive binding, not a plain string', () => {
    expect(ours.prompt()).toContain('Input(name: string, placeholder?: string');
    expect(ours.prompt()).toContain('value?: $binding<string>');
    // 普通字符串字段不应带 $binding。
    expect(ours.prompt()).not.toContain('placeholder?: $binding');
  });

  test('every reactive field matches the official library field by field', () => {
    // JSON Schema 不带 reactive 标记，只能直接问 Zod 对象；少一个就是运行时绑定失效。
    const reactiveFields = (props: unknown) =>
      Object.entries((props as { shape?: Record<string, object> }).shape ?? {})
        .filter(([, field]) => isReactiveSchema(field))
        .map(([name]) => name)
        .sort();
    for (const name of Object.keys(openuiChatLibrary.components)) {
      expect(reactiveFields(ours.components[name]?.props), name).toEqual(
        reactiveFields(openuiChatLibrary.components[name]?.props),
      );
    }
  });

  test('EntityList keeps its semantic refinement (small has no header/footer)', () => {
    const schema = ours.components.EntityList?.props;
    const parse = (value: unknown) => schema?.safeParse(value).success;
    expect(parse({ rows: [], size: 'small' })).toBe(true);
    expect(
      parse({ rows: [], size: 'small', header: { left: 'a', right: 'b', rightVariant: 'text' } }),
    ).toBe(false);
    expect(
      parse({ rows: [], size: 'default', header: { left: 'a', right: 'b', rightVariant: 'text' } }),
    ).toBe(true);
  });

  test('component groups and prompt options come from the official library unchanged', () => {
    const spec = ours.toSpec();
    expect(spec.componentGroups).toEqual(openuiChatLibrary.toSpec().componentGroups);
    expect(spec.componentGroups).toHaveLength(12);
  });

  test('a component missing from the definitions throws instead of shipping a partial library', () => {
    // 顺序与集合都由 meta.ts 控制；删掉一个名字必须显式失败。
    expect(() => createOpenUiDefinitions(kit, {})).not.toThrow();
    expect(ours.components.Card).toBeDefined();
  });

  test('props.parse fills omitted defaults exactly like the official library', () => {
    // JSON Schema 里 default 只是元数据；这里真正执行 Zod parse，确认省略字段
    // 被填成什么值。两边默认值不同（或本地把 default 删成 optional）都会红。
    const cases: Array<[string, Record<string, unknown>]> = [
      ['Text', { value: 'hello' }],
      ['BoldText', { value: 'hi', variant: 'number' }],
      ['Chips', { name: 'c' }],
      ['OptionCards', { name: 'o' }],
      ['IconText', { icon: { name: 'star' }, title: 't' }],
      ['EntityList', {}],
      ['EditableTable', {}],
      ['Form', { name: 'f', buttons: { buttons: [] } }],
      [
        'SnippetCardBlock',
        {
          items: [
            { lhs: { icon: { name: 'star' }, title: 'A' } },
            { lhs: { icon: { name: 'star' }, title: 'B' } },
          ],
        },
      ],
      ['OverviewCardBlock', { items: [{ top: { value: 'a' } }, { top: { value: 'b' } }] }],
    ];
    for (const [name, input] of cases) {
      expect(ours.components[name]?.props.parse(input), name).toEqual(
        openuiChatLibrary.components[name]?.props.parse(input),
      );
    }
    // 锁住代表性默认值本身，避免两边同时丢了 default 时对照仍然通过。
    expect(ours.components.Text?.props.parse({ value: 'x' })).toMatchObject({
      variant: 'text',
      subtextVariant: 'text',
      size: 'sm',
    });
    expect(ours.components.Chips?.props.parse({ name: 'c' })).toMatchObject({
      type: 'multiple',
      items: [],
    });
    expect(ours.components.EntityList?.props.parse({})).toMatchObject({
      rows: [],
      size: 'default',
    });
    expect(
      ours.components.IconText?.props.parse({ icon: { name: 'star' }, title: 't' }),
    ).toMatchObject({ iconVariant: 'neutral', iconSize: 'm', bold: false, layout: 'horizontal' });
  });
});
