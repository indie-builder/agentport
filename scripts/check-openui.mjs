#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(Bun.fileURLToPath(import.meta.url)), '..');
const committedSpecPath = resolve(root, 'packages/core/src/generated/openui.spec.json');
const entry = resolve(root, 'packages/web/src/openui/library.tsx');
const cli = resolve(root, 'node_modules/@openuidev/cli/dist/index.js');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const formatRunStatus = (run) =>
  run.signalCode ? `signal ${run.signalCode}` : `exit ${run.exitCode}`;

const results = [];
const check = (label, detail, ok) => results.push({ label, ok, detail });

function installedPackage(name) {
  const candidates = ['packages/web', 'packages/core', '.'];
  for (const base of candidates) {
    try {
      return readJson(resolve(root, base, 'node_modules', name, 'package.json'));
    } catch {
    }
  }
  return null;
}

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

const tsc = resolve(root, 'node_modules/typescript/bin/tsc');
let dry = '';
try {
  const tscRun = Bun.spawnSync(
    ['node', tsc, '-b', 'packages/shared', 'packages/core', '--dry'],
    { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  if (!tscRun.success) {
    const detail = [tscRun.stdout?.toString('utf8'), tscRun.stderr?.toString('utf8')]
      .map((text) => text?.trim())
      .filter(Boolean)
      .join('\n');
    console.error(`FAIL  shared/core 构建检查执行失败：${detail || formatRunStatus(tscRun)}`);
    console.error('先运行 bun run build，再重跑 bun run openui:check。');
    process.exit(1);
  }
  dry = tscRun.stdout.toString('utf8');
} catch (error) {
  console.error(
    `FAIL  shared/core 构建检查执行失败：${error instanceof Error ? error.message : String(error)}`,
  );
  console.error('先运行 bun run build，再重跑 bun run openui:check。');
  process.exit(1);
}
if (dry.includes('would build')) {
  console.error('FAIL  shared/core 构建产物过期；后续校验会读旧 dist。');
  console.error('先运行 bun run build，再重跑 bun run openui:check。');
  process.exit(1);
}
check('shared/core 构建产物是当前源码', '最新', true);

const committed = readJson(committedSpecPath);
let regenerated = null;
const scratch = mkdtempSync(join(tmpdir(), 'openui-check-'));
try {
  const genRun = Bun.spawnSync(
    ['node', cli, 'generate', entry, '--spec', '--out', join(scratch, 'spec.json'), '--no-telemetry'],
    { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  if (!genRun.success) {
    const detail = genRun.stderr?.toString('utf8').trim() || genRun.stdout?.toString('utf8').trim();
    check('现场重生成 spec', `官方 CLI 生成失败：${detail || formatRunStatus(genRun)}`, false);
  } else {
    regenerated = readJson(join(scratch, 'spec.json'));
  }
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
      : `差异：${drift.join(', ')}；运行 bun run openui:spec`,
    drift.length === 0,
  );
}

const official = await import(
  Bun.pathToFileURL(resolve(root, 'node_modules/@openuidev/react-ui/dist/genui-lib/index.mjs')).href
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

const behaviorTests = [
  'packages/core/test/openui-library.test.ts',
  'packages/core/test/openui-reactive-query.test.ts',
  'packages/core/test/openui-upgrade-guard.test.ts',
];
const backendRunner = resolve(root, 'scripts/test-backend.ts');
try {
  const testRun = Bun.spawnSync([process.execPath, backendRunner, ...behaviorTests], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (testRun.success) {
    check('Zod/reactive 行为契约测试', `${behaviorTests.length} 个文件`, true);
  } else {
    const stdout = testRun.stdout?.toString('utf8') ?? '';
    const failed = stdout
      .split('\n')
      .filter((line) => line.includes('FAIL') || line.includes('AssertionError'))
      .slice(0, 6)
      .join(' | ');
    check(
      'Zod/reactive 行为契约测试',
      `未通过：${failed || testRun.stderr?.toString('utf8').trim() || formatRunStatus(testRun)}`,
      false,
    );
  }
} catch (error) {
  check(
    'Zod/reactive 行为契约测试',
    `未通过：${error instanceof Error ? error.message : String(error)}`,
    false,
  );
}

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
