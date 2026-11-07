import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WEB_SRC = join(process.cwd(), 'packages/web/src');
const INPUT_PRIMITIVES = new Set([
  'components/ui/input.tsx',
  'components/ui/textarea.tsx',
  'components/source-editor.tsx',
  'components/ui/select.tsx',
  'components/ui/combobox.tsx',
  'components/ui/input-group.tsx',
]);
const FOCUS_COMPONENTS = [
  ...INPUT_PRIMITIVES,
  'components/ui/button.tsx',
  'components/ui/checkbox.tsx',
  'components/ui/radio-group.tsx',
  'components/ui/switch.tsx',
  'components/ui/toggle.tsx',
  'components/ui/tabs.tsx',
  'components/ui/badge.tsx',
  'components/ui/slider.tsx',
  'components/ui/field.tsx',
  'openui/components/forms.tsx',
  'openui/components/data.tsx',
  'openui/components/layout.tsx',
  'openui/components/shared.tsx',
  'openui/components/charts.tsx',
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.tsx') ? [full] : [];
  });
}

const violations = [];
const sources = new Map();
for (const file of walk(WEB_SRC)) {
  const rel = file.slice(WEB_SRC.length + 1).replaceAll('\\', '/');
  const text = readFileSync(file, 'utf8');
  sources.set(rel, text);
  text.split('\n').forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    if (/\bshadow-content-overlay\b/.test(line) && /\bring-(?:[1-9]\d*|\[)/.test(line)) {
      violations.push(`${at}  内容浮层只保留一道轻投影，不得叠加装饰 ring`);
    }
    const focusTokens = line.split(/\s+/).filter((token) => token.includes('focus'));
    const menuRing = rel === 'components/app-shell.tsx' && focusTokens.includes('focus-visible:ring-2');
    if (
      menuRing &&
      (!focusTokens.includes('focus-visible:outline-none') ||
        !focusTokens.includes('focus-visible:not-aria-invalid:border-transparent') ||
        !focusTokens.includes('focus-visible:aria-invalid:border-transparent'))
    ) {
      violations.push(`${at}  菜单保留 ring 时须关闭 outline，并覆盖共享按钮的正常/错误焦点边框`);
    }
    for (const token of focusTokens) {
      if (/:outline-offset-(?:[1-9]\d*|\[(?!-))/.test(token)) {
        violations.push(`${at}  不得用分离 outline 外圈重复表达焦点`);
      }
      if (/:ring-(?:[1-9]\d*|\[)/.test(token) && !(menuRing && token === 'focus-visible:ring-2')) {
        violations.push(`${at}  内容控件不得添加焦点 ring/光晕`);
      }
      if (/:shadow-(?!none\b)[\w[(-]/.test(token)) {
        violations.push(`${at}  内容控件不得叠加焦点阴影`);
      }
      if (INPUT_PRIMITIVES.has(rel) && /:(?:outline|ring)-[1-9]\d*\b/.test(token)) {
        violations.push(`${at}  输入族只换现有边框，内部控制器不得重复画框`);
      }
    }
    if (/focus-within:|has-\[:focus(?:-visible)?\]:/.test(line) && INPUT_PRIMITIVES.has(rel)) {
      violations.push(`${at}  复合输入必须只代理文本控制器焦点，不能代理所有内部操作`);
    }
    if (
      /(?:^|\s)border(?:\s|-[12]\b)/.test(line) &&
      focusTokens.some((token) => /:outline-[1-9]\d*\b/.test(token)) &&
      !focusTokens.some((token) => /:border-transparent\b/.test(token))
    ) {
      violations.push(`${at}  已有边框控件须复用同一条边，不得同时再画焦点 outline`);
    }
  });
}

for (const rel of FOCUS_COMPONENTS) {
  const text = sources.get(rel) ?? '';
  if (!/focus[^\s"']*(?:border-ring|outline-ring)/.test(text)) {
    violations.push(`${rel}  缺少可见的单层焦点边界`);
  }
}

for (const [rel, selector] of [
  ['components/ui/input-group.tsx', '[data-slot=input-group-control]:focus'],
  ['components/ui/combobox.tsx', '[data-slot=combobox-chip-input]:focus'],
  ['components/source-editor.tsx', '.cm-content:focus,>textarea:focus'],
]) {
  const text = sources.get(rel) ?? '';
  if (!text.includes(selector) || !text.includes('outline-none')) {
    violations.push(`${rel}  外框须代理指定文本控制器，并关闭重复 outline`);
  }
}

for (const rel of ['components/ui/input-group.tsx', 'components/ui/combobox.tsx']) {
  const text = sources.get(rel) ?? '';
  for (const match of text.matchAll(
    /data-slot="(?:input-group-control|combobox-chip-input)"[\s\S]*?className=\{cn\(\s*(['"])(.*?)\1/gs,
  )) {
    const tokens = new Set(match[2].split(/\s+/));
    if (
      !tokens.has('border-0') ||
      !tokens.has('shadow-none') ||
      !(tokens.has('outline-none') || tokens.has('focus-visible:outline-none')) ||
      [...tokens].some((token) => /(?:^|:)(?:border|ring|outline)-[1-9]\d*\b/.test(token))
    ) {
      violations.push(`${rel}  被代理文本输入必须无边框、无轮廓、无阴影`);
    }
  }
}

for (const rel of ['components/ui/tabs.tsx', 'components/ui/badge.tsx']) {
  const text = sources.get(rel) ?? '';
  for (const line of text.split('\n').filter((line) => /focus-visible:[^\s]*border-ring/.test(line))) {
    if (!/(?:^|[\s"'])outline-none(?:\s|["'])/.test(line)) {
      violations.push(`${rel}  聚焦换边须关闭全局 base outline`);
    }
  }
  if (/data-active:(?!not-focus-visible:)[^\s"']*border-(?:input|transparent)/.test(text)) {
    violations.push(`${rel}  选中边框不得覆盖键盘焦点边框`);
  }
}

for (const rel of [
  'components/agent-picker.tsx',
  'openui/components/forms.tsx',
  'openui/components/data.tsx',
]) {
  const text = sources.get(rel) ?? '';
  for (const line of text.split('\n').filter((line) => line.includes('focus:not-aria-invalid:border-ring'))) {
    if (/focus-visible:aria-invalid:(?:border(?:\s|["'])|p[xyrl]?-[\d.]+)/.test(line)) {
      violations.push(`${rel}  无文本光标的字段须保留 Button 的 invalid 2px 焦点边与内边距补偿`);
    }
    if (rel === 'components/agent-picker.tsx' && !line.includes('focus-visible:aria-invalid:pr-[calc(--spacing(2)-1px)]')) {
      violations.push(`${rel}  字段右侧 8px 内边距须随 invalid 焦点边加粗减为 7px`);
    }
  }
}
for (const [rel, padding] of [
  ['components/ui/button.tsx', ['px-[calc(--spacing(2.5)-1px)]']],
  ['components/ui/select.tsx', ['pr-[calc(--spacing(2)-1px)]', 'pl-[calc(--spacing(2.5)-1px)]']],
  ['components/ui/badge.tsx', ['px-[calc(--spacing(2)-1px)]', 'py-[calc(--spacing(0.5)-1px)]', 'has-data-[icon=inline-end]:pr-[calc(--spacing(1.5)-1px)]', 'has-data-[icon=inline-start]:pl-[calc(--spacing(1.5)-1px)]']],
]) {
  const text = sources.get(rel) ?? '';
  if (!text.includes('focus-visible:aria-invalid:border-2') || padding.some((value) => !text.includes(`focus-visible:aria-invalid:${value}`))) {
    violations.push(`${rel}  无文本光标控件须将 invalid 焦点边向内加粗为 2px 并补偿内边距`);
  }
}
const optionCards = sources.get('openui/components/forms.tsx')?.split('export function OptionCardsRenderer')[1]?.split('export function OptionCardRenderer')[0] ?? '';
if (
  !optionCards.includes('focus-visible:aria-invalid:border-2') ||
  !optionCards.includes('focus-visible:aria-invalid:p-[calc(--spacing(3)-1px)]')
) {
  violations.push('openui/components/forms.tsx  OptionCards 错误焦点须将原边向内加粗并补偿内边距');
}

const calendarDay = sources.get('components/ui/calendar.tsx')?.split('function CalendarDayButton(')[1] ?? '';
if (/\bborder-0\b/.test(calendarDay) || !sources.get('components/ui/button.tsx')?.includes('border border-transparent')) {
  violations.push('components/ui/calendar.tsx  日期按钮须保留共享 Button 的 1px 边框，供键盘焦点换色');
}
for (const state of ['selected-single', 'range-start', 'range-middle', 'range-end']) {
  if (!calendarDay.includes(`data-[${state}=true]:not-focus-visible:border-selected`)) {
    violations.push(`components/ui/calendar.tsx  ${state} 静止态边色须与选中填充同色，且不得覆盖键盘焦点边`);
  }
}

const slider = sources.get('components/ui/slider.tsx') ?? '';
if (
  !/has-\[:focus-visible\][^\s"']*:border-ring/.test(slider) ||
  !/\[&_input:focus-visible\]:outline-none/.test(slider)
) {
  violations.push('components/ui/slider.tsx  thumb 须代理 range 焦点，内部 input 不得重复画框');
}
if (/(?:hover|active):(?:ring-[1-9]|shadow-(?!none))/.test(slider)) {
  violations.push('components/ui/slider.tsx  hover/active/focus 必须共用手柄边界，不能叠 ring/shadow');
}

const css = readFileSync(join(WEB_SRC, 'styles.css'), 'utf8');
const cardFocus = css.match(/@layer utilities\s*\{\s*\.cds-card-surface:focus-visible\s*\{([^}]+)\}/)?.[1] ?? '';
if (
  !sources.get('components/ui/card.tsx')?.includes('cds-card-surface') ||
  !/box-shadow:\s*none\s*;/.test(cardFocus) ||
  !/outline:\s*var\(--hairline\) solid var\(--color-ring\)\s*;/.test(cardFocus) ||
  !/outline-offset:\s*0\s*;/.test(cardFocus)
) {
  violations.push('styles.css  Card 须在 utilities 层撤掉模拟边线的 shadow，以同宽焦点轮廓替换');
}
const menuForced = css.match(/\.bg-sidebar button:focus-visible\s*\{([^}]+)\}/)?.[1] ?? '';
if (
  !/border-color:\s*transparent !important/.test(menuForced) ||
  !/outline:\s*2px solid Highlight !important/.test(menuForced)
) {
  violations.push('styles.css  forced-colors 菜单按钮须只保留系统轮廓，不得同时显露边框');
}
const overlay = css.match(/--shadow-overlay:\s*([^;]+);/)?.[1] ?? '';
if (!overlay || /\)\s*,/.test(overlay) || /^0\s+0\s+0\b/.test(overlay)) {
  violations.push('styles.css  菜单投影同样只允许一道软阴影，不得重复描边或叠影');
}
const fallback = css.match(/\n  :focus-visible\s*\{([^}]+)\}/)?.[1] ?? '';
if (!/outline-offset:\s*-2px/.test(fallback) || /box-shadow:/.test(fallback)) {
  violations.push('styles.css  全局焦点兜底须贴边且不得添加阴影');
}
const forced = css.match(/@media \(forced-colors: active\)\s*\{([\s\S]*?)\n  \}/)?.[1] ?? '';
if (!forced.includes('Highlight') || /outline-offset:\s*[1-9]/.test(forced)) {
  violations.push('styles.css  forced-colors 须保留系统焦点，不得恢复分离外圈');
}
const search = sources.get('components/source-editor-inner.tsx') ?? '';
if (
  !search.includes("'.cm-panel.cm-search button:focus-visible'") ||
  !search.includes("'.cm-panel.cm-search input[type=checkbox]:focus-visible'") ||
  /outlineOffset:\s*'[1-9]/.test(search)
) {
  violations.push('components/source-editor-inner.tsx  搜索按钮须换边，原生 checkbox 焦点须贴边');
}

const searchButtons = search.match(/'\.cm-panel\.cm-search button':\s*\{([^}]+)\}/)?.[1] ?? '';
const searchFocus = search.match(/'\.cm-panel\.cm-search button:focus-visible':\s*\{([^}]+)\}/)?.[1] ?? '';
if (
  !searchButtons.includes("outline: 'none'") ||
  !searchButtons.includes("boxShadow: 'none'") ||
  !searchFocus.includes("borderColor: 'var(--color-ring)'") ||
  /outline:|boxShadow:/.test(searchFocus)
) {
  violations.push('components/source-editor-inner.tsx  搜索按钮只换已有边框，不得增加 outline/shadow');
}

if (violations.length > 0) {
  console.error('焦点/边框规约校验失败（见 docs/DESIGN-SYSTEM.md §9）：');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}
console.log('焦点/边框规约校验通过。');
