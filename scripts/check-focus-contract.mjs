import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 焦点/边框统一规约的守卫（docs/DESIGN-SYSTEM.md §9、CLAUDE.md 前端规则）：
// A. 以边框表达焦点的输入类原语不得再叠 ring-2。
// B. 可聚焦元素的 focus-visible:ring-2 必须同时带 focus-visible:outline-none，
//    否则会和全局 :focus-visible 的 2px outline 叠成两层。
const WEB_SRC = join(process.cwd(), 'packages/web/src');
const INPUT_PRIMITIVES = new Set([
  'components/ui/input.tsx',
  'components/ui/textarea.tsx',
  'components/ui/radio-group.tsx',
  'components/ui/select.tsx',
  'components/ui/combobox.tsx',
  'components/ui/input-group.tsx',
]);
const SLIDER = 'components/ui/slider.tsx';

/** @param {string} dir */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(WEB_SRC)) {
  const rel = file.slice(WEB_SRC.length + 1).replaceAll('\\', '/');
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    // 规则 A 只适用于 INPUT_PRIMITIVES：这些原语以边框表达焦点，
    // 焦点与错误态都不得再叠 ring（含 aria-invalid 错误环）。
    if (INPUT_PRIMITIVES.has(rel) && /\bring-[23]\b/.test(line)) {
      violations.push(
        `${at}  输入类原语用边框表达焦点，不得叠 ring-2/ring-3（规则 A）`,
      );
    }
    // 基类 outline-none 与 focus-visible:outline-none 都能压掉全局 :focus-visible 外轮廓。
    if (
      /focus-visible:ring-2/.test(line) &&
      !/outline-none/.test(line)
    ) {
      violations.push(`${at}  focus-visible:ring-2 必须带 outline-none（规则 B）`);
    }
  });
}

// C. slider 手柄不在 INPUT_PRIMITIVES 里（它用光环而非边框表达焦点）：hover/焦点/按下
//    统一单层 ring-2，且环出现时边框透明，避免 §9 禁止的「边框 + 光环」两层。
//    键盘焦点实际落在手柄内部的原生 range input 上，thumb 自身不聚焦，因此焦点态必须写成
//    has-[:focus-visible]，并压掉内部 input 的全局 outline；写成 focus-visible:* 会永远不命中。
//    aria-invalid:/dark: 等错误态可另加，不参与这三态的检查。
const sliderText = readFileSync(join(WEB_SRC, SLIDER), 'utf8');
const thumbAt = sliderText.indexOf('data-slot="slider-thumb"');
const thumbJsx =
  thumbAt < 0 ? '' : sliderText.slice(thumbAt, sliderText.indexOf('/>', thumbAt));
const thumbClassName = thumbJsx.match(/className="([^"]+)"/)?.[1];
if (!thumbClassName) {
  violations.push(`${SLIDER}  slider 手柄缺少可检查的 className（规则 C）`);
} else {
  const tokens = new Set(thumbClassName.split(/\s+/));
  for (const state of ['hover', 'active']) {
    const ringTokens = [...tokens].filter(
      (t) => t.startsWith(`${state}:ring-`) && /:ring-\d+$/.test(t),
    );
    if (ringTokens.length !== 1 || ringTokens[0] !== `${state}:ring-2`) {
      violations.push(`${SLIDER}  slider 手柄 ${state} 态必须且只能用 ring-2（规则 C）`);
    }
    if (!tokens.has(`${state}:border-transparent`)) {
      violations.push(`${SLIDER}  slider 手柄 ${state} 态环出现时边框须透明（规则 C）`);
    }
  }
  // 焦点落在内部 input：has-[:focus-visible]:ring-2 + border-transparent + 内部 outline-none。
  const focusRingTokens = [...tokens].filter(
    (t) => t.startsWith('has-[:focus-visible]:ring-') && /:ring-\d+$/.test(t),
  );
  if (focusRingTokens.length !== 1 || focusRingTokens[0] !== 'has-[:focus-visible]:ring-2') {
    violations.push(`${SLIDER}  slider 手柄焦点态必须用 has-[:focus-visible]:ring-2（规则 C）`);
  }
  if (!tokens.has('has-[:focus-visible]:border-transparent')) {
    violations.push(`${SLIDER}  slider 手柄焦态环出现时边框须透明（规则 C）`);
  }
  const staleSelfFocus = [...tokens].some(
    (t) => t.startsWith('focus-visible:ring-') || t.startsWith('focus-visible:border-'),
  );
  if (staleSelfFocus) {
    violations.push(`${SLIDER}  slider 手柄焦点在内部 input，thumb 自身 focus-visible 不会命中（规则 C）`);
  }
  const suppressesInputOutline = [...tokens].some((t) =>
    /^\[&[^\]]*input[^\]]*:focus-visible\]:outline-none$/.test(t),
  );
  if (!suppressesInputOutline) {
    violations.push(`${SLIDER}  slider 手柄焦点在内部 input 时必须压掉其 outline（规则 C）`);
  }
}

if (violations.length > 0) {
  console.error('焦点/边框规约校验失败（见 docs/DESIGN-SYSTEM.md §9）：');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log('焦点/边框规约校验通过。');
