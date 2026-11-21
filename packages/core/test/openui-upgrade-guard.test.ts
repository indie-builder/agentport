import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createOpenUiDefinitions } from '@agentport/shared';
import { action, createLibrary, defineComponent, markReactive } from '@openuidev/lang-core';
import { openuiChatLibrary } from '@openuidev/react-ui/genui-lib';
import spec from '../src/generated/openui.spec.json' with { type: 'json' };

const reactive = <T extends object>(schema: T): T => {
  markReactive(schema);
  return schema;
};
const definitions = createOpenUiDefinitions({ defineComponent, action, reactive }, {});
const shared = createLibrary({
  root: definitions.root,
  components: definitions.components,
  componentGroups: definitions.componentGroups,
});

describe('OpenUI spec guard', () => {
  test('committed spec matches the current shared definitions', () => {
    expect(spec.root).toBe(definitions.root);
    expect(Object.keys(spec.components)).toEqual(definitions.components.map((c) => c.name));
    expect(spec.schema).toEqual(shared.toJSONSchema());
  });

  test('committed spec matches the installed official library', () => {
    const official = openuiChatLibrary.toSpec();
    expect(Object.keys(spec.components)).toEqual(Object.keys(official.components));
    expect(spec.componentGroups).toEqual(official.componentGroups);
    expect(spec.schema).toEqual(openuiChatLibrary.toJSONSchema());
  });

  test('spec is loaded from the committed JSON, not rebuilt from web at build time', () => {
    const source = readFileSync(new URL('../src/openui-prompt.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports).toContain('./generated/openui.spec.json');
    expect(imports.filter((specifier) => specifier?.includes('web'))).toEqual([]);
  });
});
