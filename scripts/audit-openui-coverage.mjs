#!/usr/bin/env node
/**
 * OpenUI 覆盖缺口报告。只读，不跑测试、不改文件。
 *
 * 契约真相是 core 提交的 openui.spec.json；证据登记在
 * packages/web/test/openui-coverage-registry.json，与 openui-component-coverage.test.ts 共用。
 * 只有「契约与登记对不上」才 exit 1；缺口（render/missing）只是报告，exit 0。
 *
 * nestedInteractive 的语义：嵌套且有交互、尚无行为证据。父组件已有行为测试覆盖的
 * 交互组件留在 nestedOnly，不重复登记在 nestedInteractive；纯结构/纯数据组件两者都不进。
 *
 * 用法：pnpm openui:audit
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const spec = readJson(resolve(root, 'packages/core/src/generated/openui.spec.json'));
const registry = readJson(resolve(root, 'packages/web/test/openui-coverage-registry.json'));

const contract = Object.keys(spec.components);
const samples = Object.keys(registry.samples ?? {});
const nested = registry.nestedOnly ?? [];
const nestedInteractive = registry.nestedInteractive ?? [];
const specialized = registry.specialized ?? [];

const registered = new Set([
  ...samples,
  ...nested,
  ...specialized.map((entry) => entry.name),
]);
const unknownToRegistry = contract.filter((name) => !registered.has(name));
const unknownToContract = [...registered].filter((name) => !contract.includes(name));

const KINDS = ['behavior', 'render', 'missing'];
const problems = [];
if (unknownToRegistry.length > 0) {
  problems.push(`契约有、registry 未登记：${unknownToRegistry.join(', ')}`);
}
if (unknownToContract.length > 0) {
  problems.push(`registry 有、契约没有：${unknownToContract.join(', ')}`);
}

const bucket = (label, names) => names.map((name) => [name, label]);
const buckets = new Map();
for (const [name, label] of [
  ...bucket('samples', samples),
  ...bucket('nestedOnly', nested),
  ...bucket('specialized', specialized.map((entry) => entry.name)),
]) {
  buckets.set(name, [...(buckets.get(name) ?? []), label]);
}
for (const [name, labels] of buckets) {
  if (labels.length > 1) problems.push(`${name} 同时登记在 ${labels.join(' / ')}（应只属一类）`);
}

for (const entry of specialized) {
  if (!KINDS.includes(entry.kind)) {
    problems.push(`specialized ${entry.name} 的 kind 非法：${String(entry.kind)}`);
  }
  if (entry.evidence) {
    const file = resolve(root, 'packages/web/test', entry.evidence);
    if (!existsSync(file)) {
      problems.push(`specialized ${entry.name} 的 evidence 不存在：${entry.evidence}`);
    }
  }
}

const notNested = nestedInteractive.filter((name) => !nested.includes(name));
if (notNested.length > 0) {
  problems.push(`nestedInteractive 不在 nestedOnly 里：${notNested.join(', ')}`);
}

if (problems.length > 0) {
  console.error('OpenUI 覆盖登记不一致：');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('先更新 packages/web/test/openui-coverage-registry.json 再跑。');
  process.exit(1);
}

const behavior = specialized
  .filter((entry) => entry.kind === 'behavior')
  .map((entry) => entry.name);
const render = [
  ...samples,
  ...specialized.filter((entry) => entry.kind === 'render').map((entry) => entry.name),
];
const missing = specialized.filter((entry) => entry.kind === 'missing').map((entry) => entry.name);

const sorted = (names) => [...names].sort((a, b) => a.localeCompare(b, 'en'));
const section = (title, names) => {
  console.log(`\n${title}（${names.length}）`);
  for (const name of sorted(names)) console.log(`  ${name}`);
};

console.log('OpenUI 覆盖审计');
console.log(
  `组件总数 ${contract.length}：behavior ${behavior.length} / render ${render.length} / nested ${nested.length}（其中嵌套有交互、尚无行为证据 ${nestedInteractive.length}）/ missing ${missing.length}`,
);
section('嵌套且有交互、尚无行为证据', nestedInteractive);
section('missing 无专项', missing);
section('render 仅渲染断言', render);
