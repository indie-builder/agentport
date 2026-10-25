import { readFileSync } from 'node:fs';
import { createOpenUiDefinitions } from '@agentport/shared';
import { action, createLibrary, defineComponent, markReactive } from '@openuidev/lang-core';
import { openuiChatLibrary } from '@openuidev/react-ui/genui-lib';
import { describe, expect, test } from 'vitest';
import spec from '../src/generated/openui.spec.json' with { type: 'json' };

/**
 * 升级护栏：core 的提示词只读 `src/generated/openui.spec.json`。
 * 这条测试守住「生成物 = 真实 shared 定义 = 官方库」三者一致，
 * 而不是让 manifest 自比。
 *
 * 失败时按 docs/OPENUI-UPGRADE.md：
 * 1. `pnpm openui:spec` 重新生成；
 * 2. 按报告补齐/修正 shared/definitions.ts；
 * 3. web 渲染器缺失会由 web 的覆盖测试指出。
 */
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
    // 主构建不循环依赖 web：core 只 import 这份 JSON。
    const source = readFileSync(new URL('../src/openui-prompt.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports).toContain('./generated/openui.spec.json');
    expect(imports.filter((specifier) => specifier?.includes('web'))).toEqual([]);
  });
});
