import { describe, expect, test } from 'bun:test';
import { createOpenUiDefinitions } from '@agentport/shared';
import {
  action,
  createLibrary,
  type DefinedComponent,
  defineComponent,
  type LibraryJSONSchema,
  markReactive,
} from '@openuidev/lang-core';
import { openuiChatLibrary } from '@openuidev/react-ui/genui-lib';
import spec from '../src/generated/openui.spec.json' with { type: 'json' };

const reactive = <T extends object>(schema: T): T => {
  markReactive(schema);
  return schema;
};
const definitions = createOpenUiDefinitions({ defineComponent, action, reactive }, {});
const shared = createLibrary({
  root: definitions.root,
  components: definitions.components as unknown as DefinedComponent[],
  componentGroups: definitions.componentGroups,
});

describe('OpenUI spec guard', () => {
  test('committed spec matches the current shared definitions', () => {
    expect(spec.root).toBe(definitions.root);
    expect(Object.keys(spec.components)).toEqual(definitions.components.map((c) => c.name));
    expect(spec.schema as unknown as LibraryJSONSchema).toEqual(shared.toJSONSchema());
  });

  test('committed spec matches the installed official library', () => {
    const official = openuiChatLibrary.toSpec();
    expect(Object.keys(spec.components)).toEqual(Object.keys(official.components));
    expect(spec.componentGroups).toEqual(official.componentGroups ?? []);
    expect(spec.schema as unknown as LibraryJSONSchema).toEqual(openuiChatLibrary.toJSONSchema());
  });
});
