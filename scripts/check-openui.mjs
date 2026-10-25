#!/usr/bin/env node
/**
 * OpenUI 升级自检。只读 + 临时目录，不改仓库文件。
 *
 * 四件事，缺一不可：
 * 1. **可重生成**：用官方 CLI 从真实的浏览器库（packages/web/src/openui/library.tsx）
 *    现场生成一份临时 spec，与提交的 core/src/generated/openui.spec.json 逐项比对；
 *    不一致说明忘了 `pnpm openui:spec`。
 * 2. **与官方一致**：把提交的 spec 与已安装 `@openuidev/react-ui` 的真实元数据
 *    （组件签名、描述、分组、JSON Schema、提示词样例）逐项比对。官方升级后，
 *    这里会精确指出哪个组件漂了。
 * 3. **行为对照**：跑 core 的定向契约测试，真正执行 shared 的 Zod 与 reactive 绑定
 *    （默认值、refine、Query 重跑）。JSON Schema 反映不出 reactive 标记，
 *    所以第 1、2 项都替代不了这一条。
 * 4. **兼容范围**：只校验 `react-ui` 声明的 peer 范围覆盖实装 `react-lang`；
 *    不要求两个包的版本号相等——那是上游的发布策略，不是我们的约束。
 *
 * 用法：pnpm openui:check
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const committedSpecPath = resolve(root, 'packages/core/src/generated/openui.spec.json');
const entry = resolve(root, 'packages/web/src/openui/library.tsx');
const cli = resolve(root, 'node_modules/@openuidev/cli/dist/index.js');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const results = [];
const check = (label, detail, ok) => results.push({ label, ok, detail });

function installedPackage(name) {
  const candidates = ['packages/web', 'packages/core', '.'];
  for (const base of candidates) {
    try {
      return readJson(resolve(root, base, 'node_modules', name, 'package.json'));
    } catch {
      // 下一个位置。
    }
  }
  return null;
}

/** 只处理本仓库实际出现的 `>=x <y` 形式；其他范围宁可报不通过，也不假装兼容。 */
function satisfiesRange(version, range) {
  const match = /^>=\s*([\d.]+)\s+<\s*([\d.]+)$/.exec((range ?? '').trim());
  if (!match || !version) return false;
  const atLeast = (v, min) => {
    const [a, b, c] = v.split('.').map(Number);
    const [x, y, z] = min.split('.').map(Number);
    return a > x || (a === x && (b > y || (b === y && c >= z)));
  };
  const belowMax = (v, max) => {
    const [a, b] = v.split('.').map(Number);
    const [x, y] = max.split('.').map(Number);
    return a < x || (a === x && b < y);
  };
  return atLeast(version, match[1]) && belowMax(version, match[2]);
}

// ── 0. 产物新鲜度 ────────────────────────────────────────────────────────────
// 后面每一步（spec 重生成、行为测试）都通过包入口读 dist；旧产物会让自检
// 验的是上一次构建，所以这里先失败退出，且绝不把「检查本身报错」当成最新。
const tsc = resolve(root, 'node_modules/typescript/bin/tsc');
let dry = '';
try {
  dry = execFileSync(
    process.execPath,
    [tsc, '-b', 'packages/shared', 'packages/core', '--dry'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (error) {
  const detail = [error?.stdout, error?.stderr]
    .filter(Boolean)
    .map(String)
    .join('\n')
    .trim();
  console.error(`FAIL  shared/core 构建检查执行失败：${detail || error.message}`);
  console.error('先运行 pnpm -r build，再重跑 pnpm openui:check。');
  process.exit(1);
}
if (dry.includes('would build')) {
  console.error('FAIL  shared/core 构建产物过期；后续校验会读旧 dist。');
  console.error('先运行 pnpm -r build，再重跑 pnpm openui:check。');
  process.exit(1);
}
check('shared/core 构建产物是当前源码', '最新', true);

// ── 1. 现场重生成 ────────────────────────────────────────────────────────────
const committed = readJson(committedSpecPath);
let regenerated = null;
const scratch = mkdtempSync(join(tmpdir(), 'openui-check-'));
try {
  execFileSync(
    process.execPath,
    [cli, 'generate', entry, '--spec', '--out', join(scratch, 'spec.json'), '--no-telemetry'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  regenerated = readJson(join(scratch, 'spec.json'));
} catch (error) {
  check(
    '现场重生成 spec',
    `官方 CLI 生成失败：${error instanceof Error ? error.message : String(error)}`,
    false,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (regenerated) {
  const drift = [];
  if (!same(Object.keys(regenerated.components), Object.keys(committed.components))) {
    drift.push('组件集合或顺序');
  }
  for (const [name, component] of Object.entries(regenerated.components)) {
    if (!same(component, committed.components[name])) drift.push(name);
  }
  if (!same(regenerated.componentGroups, committed.componentGroups)) drift.push('componentGroups');
  if (!same(regenerated.schema, committed.schema)) drift.push('schema');
  if (!same(regenerated.promptOptions, committed.promptOptions)) drift.push('promptOptions');
  check(
    '提交的 spec 与当前库重生成结果一致',
    drift.length === 0
      ? `${Object.keys(committed.components).length} 个组件`
      : `差异：${drift.join(', ')}；运行 pnpm openui:spec`,
    drift.length === 0,
  );
}

// ── 2. 与已安装官方库逐项比对 ────────────────────────────────────────────────
const official = await import(
  pathToFileURL(resolve(root, 'node_modules/@openuidev/react-ui/dist/genui-lib/index.mjs')).href
);
const officialLibrary = official.openuiChatLibrary;
const officialSpec = officialLibrary.toSpec();

const namesDiffer = !same(Object.keys(officialSpec.components), Object.keys(committed.components));
check(
  '组件名与注册顺序与官方 chat 库一致',
  namesDiffer
    ? `官方 ${Object.keys(officialSpec.components).length} 个 / 本地 ${Object.keys(committed.components).length} 个`
    : `${Object.keys(committed.components).length} 个`,
  !namesDiffer,
);

const signatureDrift = Object.keys(officialSpec.components).filter(
  (name) => !same(officialSpec.components[name]?.signature, committed.components[name]?.signature),
);
check(
  '组件签名与官方一致',
  signatureDrift.length === 0 ? '全部一致' : `漂移：${signatureDrift.join(', ')}`,
  signatureDrift.length === 0,
);

const descriptionDrift = Object.keys(officialSpec.components).filter(
  (name) => officialSpec.components[name]?.description !== committed.components[name]?.description,
);
check(
  '组件描述与官方一致',
  descriptionDrift.length === 0 ? '全部一致' : `漂移：${descriptionDrift.join(', ')}`,
  descriptionDrift.length === 0,
);

check(
  '官方 12 个组件分组原样保留',
  same(officialSpec.componentGroups, committed.componentGroups)
    ? `${committed.componentGroups.length} 个分组`
    : '分组不一致；官方调整分组后需同步 meta.ts',
  same(officialSpec.componentGroups, committed.componentGroups),
);

check(
  'JSON Schema（default/min/record 值类型/refine）与官方一致',
  same(officialLibrary.toJSONSchema(), committed.schema)
    ? '一致'
    : 'schema 不一致：shared/definitions.ts 与官方 Zod 已漂移',
  same(officialLibrary.toJSONSchema(), committed.schema),
);

const officialPrompt = official.openuiChatPromptOptions;
const promptOk =
  same(officialPrompt.examples, committed.promptOptions?.examples) &&
  same(officialPrompt.additionalRules, committed.promptOptions?.additionalRules);
check(
  '提示词示例与 40 条规则与官方一致',
  promptOk ? '原样保留' : '示例或规则被改动；平台追加项应走 extraRules',
  promptOk,
);

// ── 3. 行为对照 ──────────────────────────────────────────────────────────────
// 只跑定向契约测试，不手写第二套验证器；默认值被改、refine 失效、reactive 丢失都会红。
// 测试通过包入口读 dist，新鲜度已在上一步保证，旧产物不会走到这里。
const behaviorTests = [
  'packages/core/test/openui-library.test.ts',
  'packages/core/test/openui-reactive-query.test.ts',
  'packages/core/test/openui-upgrade-guard.test.ts',
];
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs');
try {
  execFileSync(process.execPath, [vitest, 'run', ...behaviorTests], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  check('Zod/reactive 行为契约测试', `${behaviorTests.length} 个文件`, true);
} catch (error) {
  const stdout = error?.stdout?.toString() ?? '';
  const failed = stdout
    .split('\n')
    .filter((line) => line.includes('FAIL') || line.includes('AssertionError'))
    .slice(0, 6)
    .join(' | ');
  check(
    'Zod/reactive 行为契约测试',
    `未通过：${failed || (error instanceof Error ? error.message : String(error))}`,
    false,
  );
}

// ── 4. 兼容范围 ──────────────────────────────────────────────────────────────
const reactUi = installedPackage('@openuidev/react-ui');
const reactLang = installedPackage('@openuidev/react-lang');
const langCore = installedPackage('@openuidev/lang-core');
const peerRange = reactUi?.peerDependencies?.['@openuidev/react-lang'];
check(
  'react-ui 的 peer 范围覆盖实装 react-lang',
  `react-ui ${reactUi?.version ?? '缺失'} 要求 ${peerRange ?? '未声明'}，实装 ${reactLang?.version ?? '缺失'}`,
  Boolean(peerRange && satisfiesRange(reactLang?.version, peerRange)),
);
check(
  'lang-core 与 react-lang 同版本（运行时对）',
  `lang-core ${langCore?.version ?? '缺失'} / react-lang ${reactLang?.version ?? '缺失'}`,
  Boolean(langCore && reactLang && langCore.version === reactLang.version),
);

let failed = 0;
for (const item of results) {
  if (!item.ok) failed += 1;
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}  —  ${item.detail}`);
}
if (failed > 0) {
  console.log(`\n${failed} 项未通过：按 docs/OPENUI-UPGRADE.md 处理。`);
  process.exit(1);
}
console.log('\nspec、官方元数据与兼容范围一致。');
