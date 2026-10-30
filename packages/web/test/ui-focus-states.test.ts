import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from 'tailwindcss';
import { beforeAll, describe, expect, it } from 'vitest';

import { Button, buttonVariants } from '../src/components/ui/button.js';
import { Checkbox } from '../src/components/ui/checkbox.js';
import { RadioGroup, RadioGroupItem } from '../src/components/ui/radio-group.js';
import { Switch } from '../src/components/ui/switch.js';
import { Toggle } from '../src/components/ui/toggle.js';

// 错误态与焦点态必须落入同一条边框/环，且错误色优先于选中色。
// 这里用 Tailwind 4 实际编译组件真实 class，再按选择器优先级取最终声明，
// 避免只检查 class 名或源码顺序。

const require = createRequire(import.meta.url);
// 直接编译生产主题，避免测试复制一份会过期的色值表；dark 变体与生产一致绑定 .dark。
const productionCss = await readFile(
  join(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
  'utf8',
);
const productionTheme = [...productionCss.matchAll(/@theme\b[^{]*\{[\s\S]*?\n\}/g)]
  .map(([block]) => block)
  .join('\n');
const THEME = `@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));
${productionTheme}`;

type Rule = {
  selector: string;
  declarations: Map<string, string>;
  specificity: number;
  order: number;
};

const classes = new Map<string, string[]>();

function classList(markup: string, probe: string): string[] {
  const match = [...markup.matchAll(/class="([^"]*)"/g)]
    .map((entry) => entry[1])
    .find((value) => value.split(/\s+/).includes(probe));
  if (!match) throw new Error(`missing ${probe}`);
  return match.split(/\s+/);
}

function probeClasses(name: string): string[] {
  const value = classes.get(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function probe(name: string, element: Parameters<typeof renderToStaticMarkup>[0]): void {
  classes.set(name, classList(renderToStaticMarkup(element), `probe-${name}`));
}

function specificity(selector: string): number {
  const attrs = selector.match(/\[[^\]]*\]/g) ?? [];
  const core = selector.replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  // 只统计类、属性与伪类；本组断言不涉及 id/标签选择器。
  return (core.match(/\./g) ?? []).length + attrs.length + (core.match(/:(?!:)/g) ?? []).length;
}

function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  let order = 0;
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (!selector.startsWith('.') || /:is\(|:where\(|:has\(|,/.test(selector)) continue;
    const declarations = new Map<string, string>();
    for (const entry of match[2].split(';')) {
      const colon = entry.indexOf(':');
      if (colon > 0) declarations.set(entry.slice(0, colon).trim(), entry.slice(colon + 1).trim());
    }
    rules.push({ selector, declarations, specificity: specificity(selector), order: order++ });
  }
  return rules;
}

function matches(rule: Rule, classNames: string[], attrs: Record<string, string>, focus: boolean) {
  let selector = rule.selector;
  if (/(?<!\\):focus-visible/.test(selector)) {
    if (!focus) return false;
    selector = selector.replace(/(?<!\\):focus-visible/g, '');
  }
  const element = dom.window.document.createElement('div');
  element.className = classNames.join(' ');
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

function winning(
  rules: Rule[],
  classNames: string[],
  attrs: Record<string, string>,
  focus: boolean,
  property: string,
): string | undefined {
  let best: { value: string; specificity: number; order: number } | undefined;
  for (const rule of rules) {
    const value = rule.declarations.get(property);
    if (value === undefined || !matches(rule, classNames, attrs, focus)) continue;
    if (
      !best ||
      rule.specificity > best.specificity ||
      (rule.specificity === best.specificity && rule.order > best.order)
    ) {
      best = { value, specificity: rule.specificity, order: rule.order };
    }
  }
  return best?.value;
}

function ringVisible(
  rules: Rule[],
  classNames: string[],
  attrs: Record<string, string>,
  focus: boolean,
) {
  const shadow = winning(rules, classNames, attrs, focus, '--tw-ring-shadow');
  if (!shadow || shadow.includes('calc(0px')) return false;
  return winning(rules, classNames, attrs, focus, '--tw-ring-color') !== 'transparent';
}

function outlineVisible(
  rules: Rule[],
  classNames: string[],
  attrs: Record<string, string>,
  focus: boolean,
) {
  const width = winning(rules, classNames, attrs, focus, 'outline-width');
  if (!width || width === '0px') return false;
  return winning(rules, classNames, attrs, focus, 'outline-style') !== 'none';
}

const checked = { 'aria-checked': 'true', 'data-checked': '' };
const invalid = { 'aria-invalid': 'true' };
const dom = new JSDOM('<!doctype html><div></div>');
let rules: Rule[] = [];

beforeAll(async () => {
  probe(
    'checkbox',
    createElement(Checkbox, {
      className: 'probe-checkbox',
      defaultChecked: true,
      'aria-invalid': true,
    }),
  );
  probe(
    'radio',
    createElement(
      RadioGroup,
      { defaultValue: 'a' },
      createElement(RadioGroupItem, { value: 'a', className: 'probe-radio', 'aria-invalid': true }),
    ),
  );
  probe(
    'switch',
    createElement(Switch, {
      className: 'probe-switch',
      defaultChecked: true,
      'aria-invalid': true,
    }),
  );
  for (const variant of ['default', 'outline', 'ghost', 'solid'] as const) {
    probe(
      `button-${variant}`,
      createElement(
        Button,
        { className: `probe-button-${variant}`, variant, 'aria-invalid': true },
        'x',
      ),
    );
  }
  for (const variant of ['default', 'outline'] as const) {
    probe(
      `toggle-${variant}`,
      createElement(Toggle, { className: `probe-toggle-${variant}`, variant }, 'x'),
    );
  }
  // Link 等场景直接使用 helper，不经过 Button 的 cn，helper 自身必须已合并。
  for (const variant of ['default', 'outline', 'ghost', 'solid'] as const) {
    classes.set(`button-helper-${variant}`, buttonVariants({ variant, size: 'sm' }).split(/\s+/));
  }

  const candidates = [...new Set([...classes.values()].flat())];
  const compiler = await compile(THEME, {
    base: dirname(require.resolve('tailwindcss/index.css')),
    loadStylesheet: async (id: string) => {
      const file = require.resolve(id === 'tailwindcss' ? 'tailwindcss/index.css' : id);
      return { base: dirname(file), content: await readFile(file, 'utf8') };
    },
  });
  rules = parseRules(compiler.build(candidates));
}, 20_000);

describe('error and focus states share one border/ring signal', () => {
  it('keeps the control boundary for unchecked boxes and brands the checked state', () => {
    for (const name of ['radio', 'checkbox']) {
      const classNames = probeClasses(name);
      expect(winning(rules, classNames, {}, false, 'border-color')).toBe(
        'var(--color-control-boundary)',
      );
      expect(winning(rules, classNames, checked, false, 'border-color')).toBe(
        'var(--color-primary)',
      );
    }
  });

  it('shows one visible outer outline when the checked radio is keyboard focused', () => {
    const classNames = probeClasses('radio');
    // 未选中：聚焦只把边框换成环色，不额外画轮廓或环。
    expect(winning(rules, classNames, {}, true, 'border-color')).toBe('var(--color-ring)');
    expect(outlineVisible(rules, classNames, {}, true)).toBe(false);
    expect(ringVisible(rules, classNames, {}, true)).toBe(false);
    // 选中未聚焦：主色填充，无轮廓、无环。
    expect(outlineVisible(rules, classNames, checked, false)).toBe(false);
    expect(ringVisible(rules, classNames, checked, false)).toBe(false);
    // 选中聚焦：填充保持主色，只在填充外画 2px 轮廓，并以背景留出间隔。
    expect(winning(rules, classNames, checked, true, 'border-color')).toBe('var(--color-primary)');
    expect(ringVisible(rules, classNames, checked, true)).toBe(false);
    expect(winning(rules, classNames, checked, true, 'outline-width')).toBe('2px');
    expect(winning(rules, classNames, checked, true, 'outline-color')).toBe('var(--color-ring)');
    expect(winning(rules, classNames, checked, true, 'outline-offset')).toBe('2px');
  });

  it('keeps destructive border on checked + invalid radio and checkbox', () => {
    for (const name of ['radio', 'checkbox']) {
      const classNames = probeClasses(name);
      expect(winning(rules, classNames, { ...checked, ...invalid }, false, 'border-color')).toBe(
        'var(--color-destructive)',
      );
      expect(winning(rules, classNames, { ...checked, ...invalid }, true, 'border-color')).toBe(
        'var(--color-destructive)',
      );
    }
  });

  it('drops the focus ring on invalid checkbox, switch and all buttons', () => {
    for (const name of [
      'checkbox',
      'switch',
      'button-default',
      'button-outline',
      'button-ghost',
      'button-solid',
    ]) {
      const classNames = probeClasses(name);
      expect(winning(rules, classNames, invalid, true, 'border-color')).toBe(
        'var(--color-destructive)',
      );
      expect(ringVisible(rules, classNames, invalid, true)).toBe(false);
    }
  });

  it('shows one visible focus ring on every button variant and keeps the default on a solid fill', () => {
    for (const name of ['button-default', 'button-outline', 'button-ghost', 'button-solid']) {
      const classNames = probeClasses(name);
      // 未聚焦不画环。
      expect(ringVisible(rules, classNames, {}, false)).toBe(false);
      // 键盘聚焦必须有一层真实可见的环，而不是全透明的 2px 阴影。
      expect(ringVisible(rules, classNames, {}, true)).toBe(true);
      expect(winning(rules, classNames, {}, true, '--tw-ring-color')).toBe('var(--color-ring)');
    }
    // default 与 solid 都是深色实底：透明 1px 边框只占位，聚焦时用背景色间隔把环推到填充之外。
    for (const name of ['button-default', 'button-solid']) {
      const classNames = probeClasses(name);
      expect(winning(rules, classNames, {}, false, 'background-color')).toBe(
        'var(--color-button-primary)',
      );
      expect(winning(rules, classNames, {}, false, 'border-color')).toBe('transparent');
      expect(winning(rules, classNames, {}, true, 'border-color')).toBe('transparent');
      expect(winning(rules, classNames, {}, true, '--tw-ring-offset-width')).toBe('2px');
      expect(winning(rules, classNames, {}, true, '--tw-ring-offset-color')).toBe(
        'var(--color-background)',
      );
    }
    // outline 的边框保持中性色，不参与焦点表达；dark 绑定 .dark 后不会在亮色下生效。
    expect(winning(rules, probeClasses('button-outline'), {}, true, 'border-color')).toBe(
      'var(--color-border)',
    );
  });

  it('merges the shared helper so Links match the solid default', () => {
    // helper 直接输出 cva 时，调用方追加的 className 仍要按 Tailwind 冲突规则覆盖。
    const primary = probeClasses('button-helper-default');
    expect(winning(rules, primary, {}, false, 'background-color')).toBe(
      'var(--color-button-primary)',
    );
    expect(winning(rules, primary, {}, false, 'border-color')).toBe('transparent');
    expect(winning(rules, primary, {}, true, 'border-color')).toBe('transparent');
    expect(ringVisible(rules, primary, {}, true)).toBe(true);
    expect(winning(rules, primary, {}, true, '--tw-ring-offset-width')).toBe('2px');
    expect(winning(rules, primary, {}, true, '--tw-ring-offset-color')).toBe(
      'var(--color-background)',
    );

    for (const variant of ['outline', 'ghost', 'solid'] as const) {
      expect(ringVisible(rules, probeClasses(`button-helper-${variant}`), {}, true)).toBe(true);
    }
    expect(winning(rules, probeClasses('button-helper-outline'), {}, false, 'border-color')).toBe(
      'var(--color-border)',
    );
    expect(winning(rules, probeClasses('button-helper-ghost'), {}, false, 'border-color')).toBe(
      'transparent',
    );
    expect(winning(rules, probeClasses('button-helper-solid'), {}, false, 'border-color')).toBe(
      'transparent',
    );
  });

  it('keeps one signal per toggle variant', () => {
    const normal = probeClasses('toggle-default');
    const outline = probeClasses('toggle-outline');
    // default：无边框，只保留环；正常态不得因错误态修复而多出边框。
    expect(winning(rules, normal, {}, false, 'border-width')).toBeUndefined();
    expect(ringVisible(rules, normal, {}, true)).toBe(true);
    // outline：边框表达焦点，环不可见。
    expect(winning(rules, outline, {}, true, 'border-color')).toBe('var(--color-ring)');
    expect(ringVisible(rules, outline, {}, true)).toBe(false);
    // 错误态（含聚焦）：两种变体都必须有真实 1px 边框，只留危险色，不叠环/轮廓。
    for (const classNames of [normal, outline]) {
      expect(winning(rules, classNames, invalid, false, 'border-width')).toBe('1px');
      expect(winning(rules, classNames, invalid, true, 'border-width')).toBe('1px');
      expect(winning(rules, classNames, invalid, true, 'border-color')).toBe(
        'var(--color-destructive)',
      );
      expect(winning(rules, classNames, invalid, true, 'outline-style')).toBe('none');
      expect(ringVisible(rules, classNames, invalid, true)).toBe(false);
    }
  });
});
