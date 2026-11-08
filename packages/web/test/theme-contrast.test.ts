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
const theme = /@theme\s*\{([\s\S]*?)^\}/m.exec(css);
if (!theme) throw new Error('missing @theme block');
const declarations = new Map<string, string>();
for (const match of theme[1].matchAll(/(--color-[a-z-]+):\s*([^;]+);/g)) {
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
  it('keeps the neutral content ladder and petrol sidebar', () => {
    expect(token('--color-surface')).toEqual(parse('#ffffff'));
    expect(token('--color-canvas')).toEqual(parse('#fbfbfb'));
    expect(token('--color-sunken')).toEqual(parse('#f7f7f7'));
    expect(token('--color-selected')).toEqual(parse('#e6e6e6'));
    expect(token('--color-sidebar')).toEqual(parse('#eaf0f0'));
    expect(token('--color-sidebar-hover')).toEqual(parse('#dfe8e9'));
    expect(token('--color-sidebar-selected')).toEqual(token('--color-surface'));
  });

  it('keeps body and helper text readable on every surface', () => {
    for (const background of [
      '--color-surface',
      '--color-canvas',
      '--color-selected',
      '--color-sunken',
      '--color-sidebar',
      '--color-sidebar-hover',
      '--color-sidebar-selected',
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
      for (const foreground of ['--color-success', '--color-warning', '--color-danger'] as const) {
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

  it('keeps petrol actions and focus readable with neutral filled controls', () => {
    expect(token('--color-button-primary')).toEqual(parse('#315d67'));
    expect(token('--color-button-primary-hover')).toEqual(parse('#284f58'));
    expect(token('--color-button-primary-active')).toEqual(parse('#204149'));
    expect(token('--color-primary-foreground')).toEqual(parse('#ffffff'));
    expect(token('--color-primary')).toEqual(parse('#0b0b0b'));
    expect(token('--color-primary-hover')).toEqual(parse('#0b0b0b'));
    expect(token('--color-selected-foreground')).toEqual(token('--color-fg'));
    expect(token('--color-accent-foreground')).toEqual(token('--color-fg'));
    for (const background of [
      '--color-button-primary',
      '--color-button-primary-hover',
      '--color-button-primary-active',
    ] as const) {
      expect(ratio('--color-primary-foreground', background), background).toBeGreaterThanOrEqual(
        4.5,
      );
    }
    for (const background of [
      '--color-surface',
      '--color-canvas',
      '--color-sidebar-selected',
      '--color-selected',
    ] as const) {
      expect(ratio('--color-ring', background), background).toBeGreaterThanOrEqual(3);
      expect(ratio('--color-link', background), background).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('records the accepted low-contrast CDS boundary limits', () => {
    expect(token('--color-input')).toEqual(token('--color-line'));
    expect(ratio('--color-input', '--color-surface')).toBeCloseTo(1.254, 2);
    expect(ratio('--color-input', '--color-surface')).toBeLessThan(3);
    expect(ratio('--color-control-boundary', '--color-surface')).toBeCloseTo(2.442, 2);
    expect(ratio('--color-control-boundary', '--color-surface')).toBeLessThan(3);
  });
});
