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
  'components/ui/select.tsx',
  'components/ui/combobox.tsx',
  'components/ui/input-group.tsx',
]);

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
    if (INPUT_PRIMITIVES.has(rel) && /\bring-2\b/.test(line)) {
      violations.push(
        `${at}  输入类原语用边框表达焦点，不得叠 ring-2（规则 A）`,
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

if (violations.length > 0) {
  console.error('焦点/边框规约校验失败（见 docs/DESIGN-SYSTEM.md §9）：');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log('焦点/边框规约校验通过。');
