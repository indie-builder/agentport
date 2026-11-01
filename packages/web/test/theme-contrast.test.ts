import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 直接读生产 styles.css，校验 CDS 亮色契约；
// 只解析 @theme 里的 --color-* 声明与 var() 别名，不复制第二份颜色表。

const css = await readFile(
  join(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
  'utf8',
);
const declarations = new Map<string, string>();
for (const match of css.matchAll(/(--color-[a-z-]+):\s*([^;]+);/g)) {
  declarations.set(match[1], match[2].trim());
}

function value(name: string): string {
  const declared = declarations.get(name);
  if (!declared) throw new Error(`missing ${name}`);
  const alias = /^var\((--color-[a-z-]+)\)$/.exec(declared);
  return alias ? value(alias[1]) : declared;
}

type Rgba = { r: number; g: number; b: number; a: number };
type Rgb = [number, number, number];

function parse(raw: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16)) as Rgb;
    return { r, g, b, a: 1 };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(raw);
  if (rgba) {
    const [r, g, b] = rgba.slice(1, 4).map(Number) as Rgb;
    return { r, g, b, a: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  }
  throw new Error(`not a hex or rgb(a) color: ${raw}`);
}

const token = (name: string): Rgba => parse(value(name));

function composite(fg: Rgba, bg: Rgb): Rgb {
  return [
    fg.r * fg.a + bg[0] * (1 - fg.a),
    fg.g * fg.a + bg[1] * (1 - fg.a),
    fg.b * fg.a + bg[2] * (1 - fg.a),
  ];
}

const white: Rgb = [255, 255, 255];

function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function ratio(foreground: string, background: string): number {
  const bg = composite(token(background), white);
  const fg = composite(token(foreground), bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('CDS light theme token contract', () => {
  it('keeps the warm-gray surface ladder', () => {
    expect(token('--color-surface')).toEqual(parse('#ffffff'));
    expect(token('--color-canvas')).toEqual(parse('#fcfcfb'));
    expect(token('--color-sunken')).toEqual(parse('#f9f9f7'));
    expect(token('--color-selected')).toEqual(parse('#eae9e4'));
  });

  it('keeps body and helper text readable on every surface', () => {
    for (const background of [
      '--color-surface',
      '--color-canvas',
      '--color-selected',
      '--color-sunken',
    ] as const) {
      for (const foreground of ['--color-fg', '--color-muted-foreground'] as const) {
        expect(
          ratio(foreground, background),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps status colors readable on surface and canvas', () => {
    for (const background of ['--color-surface', '--color-canvas'] as const) {
      for (const foreground of [
        '--color-success',
        '--color-warning',
        '--color-danger',
      ] as const) {
        expect(
          ratio(foreground, background),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps the chart series distinct and visible', () => {
    expect(token('--color-chart-runs')).not.toEqual(token('--color-primary'));
    expect(ratio('--color-chart-runs', '--color-surface')).toBeGreaterThanOrEqual(3);
  });

  it('keeps clay as the primary action with a white foreground', () => {
    expect(token('--color-button-primary')).toEqual(parse('#d97757'));
    expect(token('--color-primary-foreground')).toEqual(parse('#ffffff'));
    expect(token('--color-selected-foreground')).toEqual(token('--color-fg'));
    expect(token('--color-accent-foreground')).toEqual(token('--color-fg'));
  });

  it('records the accepted low-contrast CDS limits', () => {
    // 发丝边与低对比焦点是 CDS 的视觉选择，用户已接受；它们不属于 WCAG AA 达标。
    expect(token('--color-input')).toEqual(token('--color-line'));
    expect(ratio('--color-input', '--color-surface')).toBeCloseTo(1.254, 2);
    expect(ratio('--color-input', '--color-surface')).toBeLessThan(3);
    expect(ratio('--color-control-boundary', '--color-surface')).toBeCloseTo(2.442, 2);
    expect(ratio('--color-control-boundary', '--color-surface')).toBeLessThan(3);
    expect(ratio('--color-ring', '--color-selected')).toBeCloseTo(2.568, 2);
    expect(ratio('--color-ring', '--color-selected')).toBeLessThan(3);
  });
});
