import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONTRACT_RULE_IDS, runContractCheck } from './index.js';

const SCRIPT = join(import.meta.dir, '..', 'check-project-contract.mjs');
const tempDirs: string[] = [];

function makeTempRepo(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'contract-cli-')));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function runCli(
  args: string[],
  cwd = process.cwd(),
): { code: number | null; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test('--list-rules 输出全部 44 条已排序契约规则并退出 0', () => {
  const res = runCli(['--list-rules']);
  expect(res.code).toBe(0);
  expect(res.stderr).toBe('');
  const listed = res.stdout.trim().split('\n');
  expect(listed).toEqual([...CONTRACT_RULE_IDS]);
  expect(listed).toHaveLength(44);
  expect(listed).toContain('dockerfile-workspace-sync');
  expect(listed).toContain('api-no-raw-dml');
});

test('CONTRACT_RULE_IDS 与 --rule-ids AST 扫描结果严格一致（44 条）', () => {
  const res = runCli(['--rule-ids']);
  expect(res.code).toBe(0);
  expect(res.stderr).toBe('');
  const scanned = JSON.parse(res.stdout) as string[];
  expect(scanned).toEqual([...CONTRACT_RULE_IDS]);
  expect(scanned).toHaveLength(44);
});

test('--rule 传入未知规则或未知参数时报错并退出 1', () => {
  const unknownRule = runCli(['--rule', 'unknown-rule']);
  expect(unknownRule.code).toBe(1);
  expect(unknownRule.stderr).toContain('unknown-rule');

  const unknownEq = runCli(['--rule=non-existent']);
  expect(unknownEq.code).toBe(1);
  expect(unknownEq.stderr).toContain('non-existent');

  const missingVal = runCli(['--rule']);
  expect(missingVal.code).toBe(1);
  expect(missingVal.stderr).toContain('--rule');

  const unknownFlag = runCli(['--unknown-flag']);
  expect(unknownFlag.code).toBe(1);
  expect(unknownFlag.stderr).toContain('--unknown-flag');
});

test('dockerfile-workspace-sync: Dockerfile 与子包和根文件完全一致时通过', () => {
  const dir = makeTempRepo({
    'package.json': JSON.stringify({ name: 'root', engines: { node: '>=24.22.2 <25' } }),
    'bun.lock': '',
    'packages/api/package.json': JSON.stringify({ name: '@agentport/api' }),
    'packages/shared/package.json': JSON.stringify({ name: '@agentport/shared' }),
    Dockerfile: [
      'FROM node:24-alpine AS base',
      'COPY package.json bun.lock ./',
      'COPY packages/api/package.json packages/api/',
      'COPY packages/shared/package.json packages/shared/',
      'COPY --from=build /repo/packages/api/dist packages/api/dist',
    ].join('\n'),
  });

  const problems = runContractCheck({ root: dir, rules: ['dockerfile-workspace-sync'] });
  expect(problems).toEqual([]);
});

test('dockerfile-workspace-sync: 新增子包缺少 COPY 声明时报错', () => {
  const dir = makeTempRepo({
    'package.json': JSON.stringify({ name: 'root', engines: { node: '>=24.22.2 <25' } }),
    'packages/api/package.json': JSON.stringify({ name: '@agentport/api' }),
    'packages/foo/package.json': JSON.stringify({ name: '@agentport/foo' }),
    Dockerfile: [
      'FROM node:24-alpine AS base',
      'COPY package.json ./',
      'COPY packages/api/package.json packages/api/',
    ].join('\n'),
  });

  const output = runContractCheck({ root: dir, rules: ['dockerfile-workspace-sync'] }).join('\n');
  expect(output).toContain('[dockerfile-workspace-sync]');
  expect(output).toContain('缺少子包 packages/foo/package.json 的 COPY 声明');
});

test('dockerfile-workspace-sync: 引用不存在的子包或根文件时报错', () => {
  const dir = makeTempRepo({
    'package.json': JSON.stringify({ name: 'root', engines: { node: '>=24.22.2 <25' } }),
    'packages/api/package.json': JSON.stringify({ name: '@agentport/api' }),
    Dockerfile: [
      'FROM node:24-alpine AS base',
      'COPY package.json missing.json ./',
      'COPY packages/api/package.json packages/api/',
      'COPY packages/ghost/package.json packages/ghost/',
      'COPY --from=build /repo/packages/phantom/dist packages/phantom/dist',
    ].join('\n'),
  });

  const output = runContractCheck({ root: dir, rules: ['dockerfile-workspace-sync'] }).join('\n');
  expect(output).toContain('Dockerfile:2: COPY 的根文件 missing.json 不存在');
  expect(output).toContain('Dockerfile:4: 引用了不存在的子包 packages/ghost');
  expect(output).toContain('Dockerfile:5: 引用了不存在的子包 packages/phantom');
});

test('dockerfile-workspace-sync: 无 manifest COPY 时仍捕获 --from 幽灵子包，且支持 --chown 多源与 . 目的路径', () => {
  const ghostDir = makeTempRepo({
    'package.json': JSON.stringify({ name: 'root', engines: { node: '>=24.22.2 <25' } }),
    'packages/api/package.json': JSON.stringify({ name: '@agentport/api' }),
    Dockerfile: [
      'FROM node:24-alpine AS base',
      'COPY packages ./packages',
      'COPY --from=build /repo/packages/ghost/scripts packages/ghost/scripts',
    ].join('\n'),
  });
  const ghostOutput = runContractCheck({
    root: ghostDir,
    rules: ['dockerfile-workspace-sync'],
  }).join('\n');
  expect(ghostOutput).toContain('Dockerfile:3: 引用了不存在的子包 packages/ghost');

  const multiValidDir = makeTempRepo({
    'package.json': JSON.stringify({ name: 'root', engines: { node: '>=24.22.2 <25' } }),
    'packages/a/package.json': JSON.stringify({ name: '@agentport/a' }),
    'packages/b/package.json': JSON.stringify({ name: '@agentport/b' }),
    Dockerfile: [
      'FROM node:24-alpine AS base',
      'COPY --chown=1000:1000 packages/a/package.json packages/b/package.json ./',
    ].join('\n'),
  });
  expect(runContractCheck({ root: multiValidDir, rules: ['dockerfile-workspace-sync'] })).toEqual(
    [],
  );

  const missingRootDir = makeTempRepo({
    'package.json': JSON.stringify({ name: 'root', engines: { node: '>=24.22.2 <25' } }),
    'packages/api/package.json': JSON.stringify({ name: '@agentport/api' }),
    Dockerfile: ['FROM node:24-alpine AS base', 'COPY --chown=1000:1000 missing.json .'].join('\n'),
  });
  const missingRootOutput = runContractCheck({
    root: missingRootDir,
    rules: ['dockerfile-workspace-sync'],
  }).join('\n');
  expect(missingRootOutput).toContain('Dockerfile:2: COPY 的根文件 missing.json 不存在');
});

test('--rule node-version-lock 过滤掉其他规则的违规，且支持逗号与重复参数', () => {
  const dir = makeTempRepo({
    'package.json': JSON.stringify({ name: 'root', engines: { node: '>=24.22.2 <25' } }),
    'packages/api/package.json': JSON.stringify({ name: '@agentport/api' }),
    'packages/foo/package.json': JSON.stringify({ name: '@agentport/foo' }),
    'packages/web/src/bad.ts': "const color = '#123456';\nexport default color;\n",
    Dockerfile: [
      'FROM node:24-alpine AS base',
      'COPY packages/api/package.json packages/api/',
    ].join('\n'),
  });

  const onlyNode = runCli(['--rule', 'node-version-lock'], dir);
  expect(onlyNode.code).toBe(0);
  expect(onlyNode.stdout).toContain('project contract OK');

  const multi = runCli(
    ['--rule', 'node-version-lock,web-hardcoded-hex', '--rule=dockerfile-workspace-sync'],
    dir,
  );
  expect(multi.code).toBe(1);
  expect(multi.stderr).toContain('[web-hardcoded-hex]');
  expect(multi.stderr).toContain('[dockerfile-workspace-sync]');

  const direct = runContractCheck({ root: dir, rules: ['node-version-lock'] });
  expect(direct).toEqual([]);
});
