import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const FILE_LINES_SCRIPT = join(import.meta.dir, 'check-file-lines.mjs');
const RATCHETS_SCRIPT = join(import.meta.dir, 'check-ratchets.mjs');

const tempDirs: string[] = [];

function makeTempRoot(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ratchet-test-')));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function runScript(
  scriptPath: string,
  root: string,
  extraArgs: string[] = [],
): { code: number | null; stdout: string; stderr: string; output: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath, '--root', root, ...extraArgs],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = result.stdout.toString('utf8');
  const stderr = result.stderr.toString('utf8');
  return {
    code: result.exitCode,
    stdout,
    stderr,
    output: `${stdout}\n${stderr}`,
  };
}

function repeatLines(count: number, line = 'export const x = 1;'): string {
  return `${Array.from({ length: count }, () => line).join('\n')}\n`;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('check-file-lines.mjs', () => {
  test('passes src <= 800, test <= 1500, and json <= 3000', () => {
    const root = makeTempRoot({
      'packages/core/src/a.ts': repeatLines(800),
      'packages/core/test/a.test.ts': repeatLines(1500),
      'packages/core/data.json': repeatLines(2999, '"a"'),
    });
    const res = runScript(FILE_LINES_SCRIPT, root);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('file lines OK');
  });

  test('fails new src file at 801 lines and new test file at 1501 lines', () => {
    const root = makeTempRoot({
      'packages/core/src/over.ts': repeatLines(801),
      'packages/core/test/over.test.ts': repeatLines(1501),
    });
    const res = runScript(FILE_LINES_SCRIPT, root);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(
      '[file-lines] packages/core/src/over.ts: 801 行，超过默认上限 800 行',
    );
    expect(res.stderr).toContain(
      '[file-lines] packages/core/test/over.test.ts: 1501 行，超过默认上限 1500 行',
    );
  });

  test('fails baseline growth and allows exact baseline match', () => {
    const root = makeTempRoot({
      'scripts/baselines/file-lines.json': JSON.stringify(
        {
          'packages/core/src/exact.ts': 900,
          'packages/core/src/grew.ts': 900,
        },
        null,
        2,
      ),
      'packages/core/src/exact.ts': repeatLines(900),
      'packages/core/src/grew.ts': repeatLines(901),
    });
    const res = runScript(FILE_LINES_SCRIPT, root);
    expect(res.code).toBe(1);
    expect(res.stderr).not.toContain('exact.ts');
    expect(res.stderr).toContain(
      '[file-lines] packages/core/src/grew.ts: 901 行，超过棘轮基线 900 行（默认上限 800 行）',
    );
  });

  test('fails >3000 even if baseline allows 3500, and fails JSON >3000', () => {
    const root = makeTempRoot({
      'scripts/baselines/file-lines.json': JSON.stringify(
        { 'packages/core/src/huge.ts': 3500 },
        null,
        2,
      ),
      'packages/core/src/huge.ts': repeatLines(3001),
      'packages/core/huge.json': repeatLines(3001, '"a"'),
    });
    const res = runScript(FILE_LINES_SCRIPT, root);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(
      '[file-lines] packages/core/src/huge.ts: 3001 行，超过 3000 行硬上限',
    );
    expect(res.stderr).toContain(
      '[file-lines] packages/core/huge.json: 3001 行，超过 3000 行硬上限',
    );
  });

  test('fails converged and deleted zombie baseline entries in normal mode', () => {
    const root = makeTempRoot({
      'scripts/baselines/file-lines.json': JSON.stringify(
        {
          'packages/core/src/converged.ts': 950,
          'packages/core/src/deleted.ts': 900,
        },
        null,
        2,
      ),
      'packages/core/src/converged.ts': repeatLines(750),
    });
    const res = runScript(FILE_LINES_SCRIPT, root);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(
      '[file-lines] packages/core/src/converged.ts: 已降至 750 行（<= 默认上限 800 行），请运行 bun run ratchet:tighten 从基线移除',
    );
    expect(res.stderr).toContain(
      '[file-lines] packages/core/src/deleted.ts: 基线中的文件已不存在，请运行 bun run ratchet:tighten 清理僵尸条目',
    );
  });

  test('--tighten shrinks lowered entries and removes converged/deleted entries without ratifying regressions', () => {
    const root = makeTempRoot({
      'scripts/baselines/file-lines.json': JSON.stringify(
        {
          'packages/core/src/shrunk.ts': 1000,
          'packages/core/src/converged.ts': 950,
          'packages/core/src/deleted.ts': 900,
          'packages/core/src/grew.ts': 850,
        },
        null,
        2,
      ),
      'packages/core/src/shrunk.ts': repeatLines(880),
      'packages/core/src/converged.ts': repeatLines(700),
      'packages/core/src/grew.ts': repeatLines(860),
      'packages/core/src/new-over.ts': repeatLines(805),
    });
    const res = runScript(FILE_LINES_SCRIPT, root, ['--tighten']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('packages/core/src/grew.ts: 860 行，超过棘轮基线 850 行');
    expect(res.stderr).toContain('packages/core/src/new-over.ts: 805 行，超过默认上限 800 行');

    const updated = JSON.parse(
      readFileSync(join(root, 'scripts/baselines/file-lines.json'), 'utf8'),
    ) as Record<string, number>;
    expect(updated).toEqual({
      'packages/core/src/grew.ts': 850,
      'packages/core/src/shrunk.ts': 880,
    });
  });

  test('--tighten succeeds cleanly when no violations remain', () => {
    const root = makeTempRoot({
      'scripts/baselines/file-lines.json': JSON.stringify(
        {
          'packages/core/src/shrunk.ts': 1000,
          'packages/core/src/converged.ts': 950,
        },
        null,
        2,
      ),
      'packages/core/src/shrunk.ts': repeatLines(850),
      'packages/core/src/converged.ts': repeatLines(800),
    });
    const res = runScript(FILE_LINES_SCRIPT, root, ['--tighten']);
    expect(res.code).toBe(0);
    const updated = JSON.parse(
      readFileSync(join(root, 'scripts/baselines/file-lines.json'), 'utf8'),
    ) as Record<string, number>;
    expect(updated).toEqual({
      'packages/core/src/shrunk.ts': 850,
    });
  });
});

describe('check-ratchets.mjs', () => {
  test('fails @ts-ignore, @ts-nocheck, and eslint-disable unconditionally', () => {
    const root = makeTempRoot({
      'packages/core/src/bad.ts': [
        '// @ts-ignore',
        '/* @ts-nocheck */',
        '// eslint-disable-next-line no-console',
        'export const a = 1;',
      ].join('\n'),
    });
    const res = runScript(RATCHETS_SCRIPT, root);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(
      '[suppression-forbidden] packages/core/src/bad.ts:1: 禁止使用 @ts-ignore',
    );
    expect(res.stderr).toContain(
      '[suppression-forbidden] packages/core/src/bad.ts:2: 禁止使用 @ts-nocheck',
    );
    expect(res.stderr).toContain(
      '[suppression-forbidden] packages/core/src/bad.ts:3: 禁止使用 eslint-disable-next-line',
    );
  });

  test('fails missing or too-short suppression reasons', () => {
    const root = makeTempRoot({
      'scripts/baselines/suppressions.json': JSON.stringify(
        {
          suppressions: { 'packages/core/src/reasons.ts': 4 },
          doubleCasts: {},
        },
        null,
        2,
      ),
      'packages/core/src/reasons.ts': [
        '// biome-ignore lint/suspicious/noExplicitAny',
        '// biome-ignore lint/suspicious/noExplicitAny:   ',
        '// oxlint-disable-next-line no-console',
        '// @ts-expect-error: ok',
      ].join('\n'),
    });
    const res = runScript(RATCHETS_SCRIPT, root);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(
      '[suppression-reason] packages/core/src/reasons.ts:1: biome-ignore',
    );
    expect(res.stderr).toContain(
      '[suppression-reason] packages/core/src/reasons.ts:2: biome-ignore',
    );
    expect(res.stderr).toContain(
      '[suppression-reason] packages/core/src/reasons.ts:3: oxlint-disable-next-line',
    );
    expect(res.stderr).toContain(
      '[suppression-reason] packages/core/src/reasons.ts:4: @ts-expect-error',
    );
  });

  test('passes valid suppression reasons within baseline and ignores directives inside strings/regexes', () => {
    const root = makeTempRoot({
      'scripts/baselines/suppressions.json': JSON.stringify(
        {
          suppressions: { 'packages/web/src/ok.tsx': 3 },
          doubleCasts: {},
        },
        null,
        2,
      ),
      'packages/web/src/ok.tsx': [
        '// biome-ignore lint/suspicious/noExplicitAny: third-party callback',
        '// oxlint-disable-next-line no-console -- diagnostic log',
        '// @ts-expect-error: upstream type omits field',
        'const s = "// @ts-ignore";',
        'const r = /\\/\\/ @ts-nocheck/;',
        'export const View = () => <a href="https://example.com">https://example.com</a>;',
      ].join('\n'),
    });
    const res = runScript(RATCHETS_SCRIPT, root);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('ratchets OK');
  });

  test('fails increased suppression count and new as unknown as in packages/*/src/', () => {
    const root = makeTempRoot({
      'scripts/baselines/suppressions.json': JSON.stringify(
        {
          suppressions: { 'packages/api/src/a.ts': 1 },
          doubleCasts: { 'packages/api/src/a.ts': 1 },
        },
        null,
        2,
      ),
      'packages/api/src/a.ts': [
        '// biome-ignore lint/suspicious/noExplicitAny: first reason',
        '// biome-ignore lint/suspicious/noExplicitAny: second reason',
        'export const a = 1 as unknown as string;',
        'export const b = 2 as unknown as number;',
      ].join('\n'),
      'packages/api/src/new-cast.ts': 'export const c = 3 as unknown as boolean;\n',
    });
    const res = runScript(RATCHETS_SCRIPT, root);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(
      '[suppression-ratchet] packages/api/src/a.ts: 发现 2 处抑制注释，超过基线允许的 1 处（行号: 1, 2）',
    );
    expect(res.stderr).toContain(
      '[double-cast-ratchet] packages/api/src/a.ts: 发现 2 处 as unknown as，超过基线允许的 1 处（行号: 3, 4）',
    );
    expect(res.stderr).toContain(
      '[double-cast-ratchet] packages/api/src/new-cast.ts: 发现 1 处 as unknown as，超过基线允许的 0 处（行号: 1）',
    );
  });

  test('ignores as unknown as in test dirs, comments, and string literals', () => {
    const root = makeTempRoot({
      'packages/api/test/ok.test.ts': 'export const t = 1 as unknown as string;\n',
      'packages/api/src/ok.ts': [
        '// const a = 1 as unknown as string;',
        '/* const b = 2 as unknown as number; */',
        'const s = "x as unknown as y";',
        'const tpl = `x as unknown as y`;',
        'export const ok = s + tpl;',
      ].join('\n'),
    });
    const res = runScript(RATCHETS_SCRIPT, root);
    expect(res.code).toBe(0);
  });

  test('fails zombie baseline entries in normal mode', () => {
    const root = makeTempRoot({
      'scripts/baselines/suppressions.json': JSON.stringify(
        {
          suppressions: {
            'packages/api/src/gone.ts': 1,
            'packages/api/src/zero.ts': 1,
          },
          doubleCasts: {
            'packages/api/src/zero.ts': 2,
          },
        },
        null,
        2,
      ),
      'packages/api/src/zero.ts': 'export const clean = 1;\n',
    });
    const res = runScript(RATCHETS_SCRIPT, root);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(
      '[suppression-ratchet] packages/api/src/gone.ts: 基线中的文件已不存在',
    );
    expect(res.stderr).toContain('[suppression-ratchet] packages/api/src/zero.ts: 抑制注释已归零');
    expect(res.stderr).toContain(
      '[double-cast-ratchet] packages/api/src/zero.ts: as unknown as 已归零',
    );
  });

  test('--tighten shrinks downward only without ratifying regressions', () => {
    const root = makeTempRoot({
      'scripts/baselines/suppressions.json': JSON.stringify(
        {
          suppressions: {
            'packages/api/src/shrunk.ts': 3,
            'packages/api/src/zero.ts': 1,
            'packages/api/src/grew.ts': 1,
          },
          doubleCasts: {
            'packages/api/src/shrunk.ts': 2,
            'packages/api/src/zero.ts': 1,
          },
        },
        null,
        2,
      ),
      'packages/api/src/shrunk.ts': [
        '// biome-ignore lint/suspicious/noExplicitAny: kept one',
        'export const x = 1 as unknown as string;',
      ].join('\n'),
      'packages/api/src/zero.ts': 'export const ok = 1;\n',
      'packages/api/src/grew.ts': [
        '// biome-ignore lint/suspicious/noExplicitAny: one',
        '// biome-ignore lint/suspicious/noExplicitAny: two',
      ].join('\n'),
    });
    const res = runScript(RATCHETS_SCRIPT, root, ['--tighten']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(
      '[suppression-ratchet] packages/api/src/grew.ts: 发现 2 处抑制注释，超过基线允许的 1 处',
    );

    const updated = JSON.parse(
      readFileSync(join(root, 'scripts/baselines/suppressions.json'), 'utf8'),
    ) as { suppressions: Record<string, number>; doubleCasts: Record<string, number> };
    expect(updated).toEqual({
      suppressions: {
        'packages/api/src/grew.ts': 1,
        'packages/api/src/shrunk.ts': 1,
      },
      doubleCasts: {
        'packages/api/src/shrunk.ts': 1,
      },
    });
  });
});
