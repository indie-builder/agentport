import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = await readFile(
  join(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
  'utf8',
);
const theme = /@theme\s*\{([\s\S]*?)^\}/m.exec(css);
if (!theme) throw new Error('missing @theme block');
const declarations = new Map<string, string>();
for (const match of theme[1].matchAll(/(--color-[a-z0-9-]+):\s*([^;]+);/g)) {
  declarations.set(match[1], match[2].trim());
}

function value(name: string): string {
  const declared = declarations.get(name);
  if (!declared) throw new Error(`missing ${name}`);
  const alias = /^var\((--color-[a-z0-9-]+)\)$/.exec(declared);
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
  const spaceRgba = /^rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(raw);
  if (spaceRgba) {
    const [r, g, b] = spaceRgba.slice(1, 4).map(Number) as Rgb;
    const rawAlpha = spaceRgba[4];
    const a =
      rawAlpha === undefined
        ? 1
        : rawAlpha.endsWith('%')
          ? Number.parseFloat(rawAlpha) / 100
          : Number(rawAlpha);
    return { r, g, b, a };
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

function ratioRgba(fgToken: Rgba, bgToken: Rgba): number {
  const bg = composite(bgToken, white);
  const fg = composite(fgToken, bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function ratio(foreground: string, background: string): number {
  return ratioRgba(token(foreground), token(background));
}

describe('CDS light theme token contract', () => {
  it('keeps the neutral content ladder and neutral sidebar', () => {
    expect(token('--color-surface')).toEqual(parse('#ffffff'));
    expect(token('--color-canvas')).toEqual(parse('#fbfbfb'));
    expect(token('--color-sunken')).toEqual(parse('#f7f7f7'));
    expect(token('--color-selected')).toEqual(parse('#e6e6e6'));
    expect(token('--color-sidebar')).toEqual(parse('#fafafa'));
    expect(token('--color-sidebar-hover')).toEqual(parse('rgba(0, 0, 0, 0.05)'));
    expect(token('--color-sidebar-selected')).toEqual(parse('rgba(0, 0, 0, 0.10)'));
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

  it('keeps actions, links and focus neutral and readable', () => {
    expect(token('--color-link')).toEqual(token('--color-fg'));
    expect(token('--color-ring')).toEqual(token('--color-fg'));
    expect(token('--color-primary-foreground')).toEqual(parse('#ffffff'));
    expect(token('--color-primary')).toEqual(parse('#0b0b0b'));
    expect(token('--color-primary-hover')).toEqual(parse('#0b0b0b'));
    expect(token('--color-selected-foreground')).toEqual(token('--color-fg'));
    expect(token('--color-accent-foreground')).toEqual(token('--color-fg'));
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

  it('keeps control boundaries and input focus at 3:1 contrast', () => {
    expect(token('--color-control-boundary')).toEqual(parse('rgba(0, 0, 0, 0.48)'));
    expect(token('--color-input-focus')).toEqual(token('--color-subtle'));
    expect(ratio('--color-control-boundary', '--color-surface')).toBeGreaterThanOrEqual(3);
    expect(ratio('--color-control-boundary', '--color-selected')).toBeGreaterThanOrEqual(3);
    expect(ratio('--color-input-focus', '--color-surface')).toBeGreaterThanOrEqual(3);
  });

  it('records the accepted low-contrast CDS hairline limit', () => {
    expect(token('--color-input')).toEqual(token('--color-line'));
    expect(ratio('--color-input', '--color-surface')).toBeCloseTo(1.254, 2);
    expect(ratio('--color-input', '--color-surface')).toBeLessThan(3);
  });

  it('keeps body and helper text readable on interactive and code surfaces', () => {
    for (const background of [
      '--color-hover',
      '--color-chip',
      '--color-code',
      '--color-popover',
      '--color-card',
      '--color-secondary',
      '--color-accent',
      '--color-badge-accent-soft',
    ] as const) {
      for (const foreground of ['--color-fg', '--color-muted-foreground'] as const) {
        expect(
          ratio(foreground, background),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps status, badge accent, and destructive text readable on their subtle fills', () => {
    expect(ratio('--color-success', '--color-success-soft')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--color-warning', '--color-warning-soft')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--color-danger', '--color-danger-soft')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--color-destructive', '--color-danger-soft')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--color-badge-accent', '--color-badge-accent-soft')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--color-badge-accent', '--color-surface')).toBeGreaterThanOrEqual(4.5);
    for (const background of ['--color-surface', '--color-canvas', '--color-selected'] as const) {
      expect(
        ratio('--color-destructive', background),
        `--color-destructive on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    const destructive = token('--color-destructive');
    for (const alpha of [0.1, 0.2]) {
      expect(
        ratioRgba(destructive, { ...destructive, a: alpha }),
        `--color-destructive on destructive/${alpha * 100}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps filled actions and avatar identities readable', () => {
    expect(ratio('--color-primary-foreground', '--color-primary')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--color-destructive-foreground', '--color-destructive')).toBeGreaterThanOrEqual(
      4.5,
    );
    for (const avatar of [
      '--color-avatar-1',
      '--color-avatar-2',
      '--color-avatar-3',
      '--color-avatar-4',
      '--color-avatar-5',
      '--color-avatar-6',
    ] as const) {
      expect(
        ratio('--color-surface', avatar),
        `--color-surface on ${avatar}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps code block syntax and dimmed tokens readable on code block surface', () => {
    for (const foreground of [
      '--color-code-block-fg',
      '--color-code-syntax-comment',
      '--color-code-syntax-string',
      '--color-code-syntax-accent',
      '--color-code-syntax-muted',
      '--color-code-block-dim',
      '--color-code-block-faint',
    ] as const) {
      expect(
        ratio(foreground, '--color-code-block'),
        `${foreground} on --color-code-block`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps chart failure, input focus on canvas, and control boundary on sunken at 3:1 contrast', () => {
    expect(ratio('--color-chart-failed', '--color-surface')).toBeGreaterThanOrEqual(3);
    expect(ratio('--color-input-focus', '--color-canvas')).toBeGreaterThanOrEqual(3);
    expect(ratio('--color-control-boundary', '--color-sunken')).toBeGreaterThanOrEqual(3);
  });
});
