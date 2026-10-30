import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 直接读生产 styles.css，校验冻结契约的可访问约束；
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

type Rgb = [number, number, number];

function rgb(name: string): Rgb {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value(name));
  if (!match) throw new Error(`${name} is not a hex color: ${value(name)}`);
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1];
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const white: Rgb = [255, 255, 255];

describe('theme tokens match the frozen Qoder visual contract', () => {
  it('keeps every content surface pure white', () => {
    for (const name of [
      '--color-canvas',
      '--color-surface',
      '--color-panel',
      '--color-background',
      '--color-card',
      '--color-popover',
    ]) {
      expect(rgb(name), name).toEqual(white);
    }
  });

  it('uses neutral dark actions instead of a brand hue', () => {
    for (const name of [
      '--color-primary',
      '--color-primary-hover',
      '--color-ring',
      '--color-button-primary',
      '--color-button-primary-hover',
      '--color-button-primary-active',
    ]) {
      const [r, g, b] = rgb(name);
      expect(r === g && g === b, name).toBe(true);
    }
    expect(rgb('--color-primary')).toEqual(rgb('--color-button-primary'));
    expect(rgb('--color-primary-foreground')).toEqual(white);
    expect(rgb('--color-selected-foreground')).toEqual(rgb('--color-fg'));
    expect(rgb('--color-accent-foreground')).toEqual(rgb('--color-fg'));
  });

  it('keeps the data series independent from UI actions', () => {
    expect(rgb('--color-chart-runs')).not.toEqual(rgb('--color-primary'));
    expect(contrast(rgb('--color-chart-runs'), rgb('--color-surface'))).toBeGreaterThanOrEqual(3);
  });

  it('keeps body, helper and status text readable on white and selected', () => {
    for (const background of ['--color-surface', '--color-selected', '--color-code'] as const) {
      for (const foreground of [
        '--color-fg',
        '--color-muted-foreground',
        '--color-success',
        '--color-warning',
        '--color-danger',
      ]) {
        expect(
          contrast(rgb(foreground), rgb(background)),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps helper text readable at the worst end of the shell gradient', () => {
    const stops = ['--color-shell-start', '--color-shell-mid', '--color-shell-end'] as const;
    const ratios = stops.map((stop) => contrast(rgb('--color-muted-foreground'), rgb(stop)));
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps solid actions and editable boundaries accessible', () => {
    for (const action of [
      '--color-button-primary',
      '--color-button-primary-hover',
      '--color-button-primary-active',
    ]) {
      expect(
        contrast(rgb('--color-primary-foreground'), rgb(action)),
        action,
      ).toBeGreaterThanOrEqual(4.5);
    }
    for (const background of [
      '--color-surface',
      '--color-selected',
      '--color-shell-end',
    ] as const) {
      expect(
        contrast(rgb('--color-input'), rgb(background)),
        `input on ${background}`,
      ).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(rgb('--color-ring'), rgb('--color-selected'))).toBeGreaterThanOrEqual(3);
  });
});
