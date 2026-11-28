import { type Browser, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';

type Locator = ReturnType<Browser['locator']>;

type ContrastSample = {
  readonly category: 'text' | 'large-text' | 'placeholder' | 'ui';
  readonly selector: string;
  readonly text: string;
  readonly ratio: number;
  readonly threshold: number;
  readonly fg: string;
  readonly bg: string;
};

type ContrastReport = {
  readonly route: string;
  readonly stateLabel: string;
  readonly checkedCount: number;
  readonly minTextRatio: number | null;
  readonly minLargeTextRatio: number | null;
  readonly minPlaceholderRatio: number | null;
  readonly minUiRatio: number | null;
  readonly failures: readonly ContrastSample[];
};

type HoverSnapshot = {
  readonly ratio: number;
  readonly threshold: number;
  readonly fg: string;
  readonly bg: string;
  readonly boxShadow: string;
};

type FocusResult = {
  readonly tagName: string;
  readonly selector: string;
  readonly minRatio: number | null;
  readonly indicators: readonly {
    readonly kind: string;
    readonly color: string;
    readonly bg: string;
    readonly ratio: number;
  }[];
};

type InvalidResult = {
  readonly controlCount: number;
  readonly alertCount: number;
  readonly minBorderRatio: number | null;
  readonly minAlertRatio: number | null;
  readonly failures: readonly {
    readonly kind: string;
    readonly selector: string;
    readonly ratio: number;
    readonly threshold: number;
    readonly fg: string;
    readonly bg: string;
  }[];
};

type SelectedDifferentiationResult = {
  readonly selectedRatio: number;
  readonly unselectedRatio: number;
  readonly selectedFg: string;
  readonly selectedBg: string;
  readonly unselectedFg: string;
  readonly unselectedBg: string;
  readonly indicatorRatio: number | null;
  readonly visuallyDistinct: boolean;
};

const contrastSummary: Array<{
  readonly route: string;
  readonly state: string;
  readonly checked: number;
  readonly minText: number | null;
  readonly minLarge: number | null;
  readonly minPlaceholder: number | null;
  readonly minUi: number | null;
}> = [];

async function settlePage(browser: Browser): Promise<void> {
  await browser.evaluate(async () => {
    const pending = document.getAnimations().filter((anim) => {
      const timing = anim.effect?.getComputedTiming();
      if (!timing) return false;
      return timing.iterations !== Number.POSITIVE_INFINITY && Number.isFinite(timing.endTime);
    });
    await Promise.race([
      Promise.allSettled(pending.map((anim) => anim.finished)),
      new Promise((resolve) => setTimeout(resolve, 450)),
    ]);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return null;
  });
}

async function scanContrast(
  browser: Browser,
  route: string,
  stateLabel: string,
  scopeSelector: string | null = null,
): Promise<ContrastReport> {
  await settlePage(browser);
  const report = await browser.evaluate<
    ContrastReport,
    { route: string; stateLabel: string; scopeSelector: string | null }
  >(
    async ({ route: currentRoute, stateLabel: currentState, scopeSelector: scope }) => {
      const pending = document.getAnimations().filter((anim) => {
        const timing = anim.effect?.getComputedTiming();
        if (!timing) return false;
        return timing.iterations !== Number.POSITIVE_INFINITY && Number.isFinite(timing.endTime);
      });
      await Promise.race([
        Promise.allSettled(pending.map((anim) => anim.finished)),
        new Promise((resolve) => setTimeout(resolve, 450)),
      ]);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );

      type Rgba = { r: number; g: number; b: number; a: number };

      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });

      const parseColor = (raw: string): Rgba => {
        const trimmed = raw.trim().toLowerCase();
        if (!trimmed || trimmed === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
        const commaRgb =
          /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+%?))?\s*\)$/.exec(
            trimmed,
          );
        if (commaRgb) {
          const rawAlpha = commaRgb[4];
          const a =
            rawAlpha === undefined
              ? 1
              : rawAlpha.endsWith('%')
                ? Number.parseFloat(rawAlpha) / 100
                : Number.parseFloat(rawAlpha);
          return {
            r: Number.parseFloat(commaRgb[1] ?? '0'),
            g: Number.parseFloat(commaRgb[2] ?? '0'),
            b: Number.parseFloat(commaRgb[3] ?? '0'),
            a,
          };
        }
        const spaceRgb =
          /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(trimmed);
        if (spaceRgb) {
          const rawAlpha = spaceRgb[4];
          const a =
            rawAlpha === undefined
              ? 1
              : rawAlpha.endsWith('%')
                ? Number.parseFloat(rawAlpha) / 100
                : Number.parseFloat(rawAlpha);
          return {
            r: Number.parseFloat(spaceRgb[1] ?? '0'),
            g: Number.parseFloat(spaceRgb[2] ?? '0'),
            b: Number.parseFloat(spaceRgb[3] ?? '0'),
            a,
          };
        }
        const srgb =
          /^color\(srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*([\d.eE+-]+%?))?\s*\)$/.exec(
            trimmed,
          );
        if (srgb) {
          const rawAlpha = srgb[4];
          const a =
            rawAlpha === undefined
              ? 1
              : rawAlpha.endsWith('%')
                ? Number.parseFloat(rawAlpha) / 100
                : Number.parseFloat(rawAlpha);
          return {
            r: Number.parseFloat(srgb[1] ?? '0') * 255,
            g: Number.parseFloat(srgb[2] ?? '0') * 255,
            b: Number.parseFloat(srgb[3] ?? '0') * 255,
            a,
          };
        }
        if (ctx) {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = 'rgba(0, 0, 0, 0)';
          ctx.fillStyle = raw;
          ctx.fillRect(0, 0, 1, 1);
          const pixel = ctx.getImageData(0, 0, 1, 1).data;
          return {
            r: pixel[0] ?? 0,
            g: pixel[1] ?? 0,
            b: pixel[2] ?? 0,
            a: (pixel[3] ?? 0) / 255,
          };
        }
        return { r: 0, g: 0, b: 0, a: 0 };
      };

      const sourceOver = (top: Rgba, bottom: Rgba): Rgba => {
        const a = top.a + bottom.a * (1 - top.a);
        if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
        return {
          r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
          g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
          b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
          a,
        };
      };

      const luminance = (c: Rgba): number => {
        const lin = (channel: number): number => {
          const s = Math.max(0, Math.min(255, channel)) / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
      };

      const contrastRatio = (a: Rgba, b: Rgba): number => {
        const la = luminance(a);
        const lb = luminance(b);
        const hi = Math.max(la, lb);
        const lo = Math.min(la, lb);
        return (hi + 0.05) / (lo + 0.05);
      };

      const formatRgba = (c: Rgba): string =>
        `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

      const describeElement = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const slot = el.getAttribute('data-slot');
        const slotPart = slot ? `[data-slot="${slot}"]` : '';
        const role = el.getAttribute('role');
        const rolePart = role ? `[role="${role}"]` : '';
        return `${tag}${id}${slotPart}${rolePart}`;
      };

      const isDisabledNode = (el: Element): boolean => {
        let cur: Element | null = el;
        while (cur) {
          if (cur.matches(':disabled')) return true;
          if (cur.getAttribute('aria-disabled') === 'true') return true;
          const dataDisabled = cur.getAttribute('data-disabled');
          if (dataDisabled === '' || dataDisabled === 'true') return true;
          cur = cur.parentElement;
        }
        return false;
      };

      const isElementVisible = (el: Element): boolean => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (Number.parseFloat(style.opacity) <= 0.01) return false;
        if (style.clipPath.includes('inset(50%)') || style.clip === 'rect(0px, 0px, 0px, 0px)') {
          return false;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return false;
        if (rect.width <= 2 && rect.height <= 2 && style.overflow === 'hidden') return false;
        if (rect.bottom <= 0 || rect.right <= 0) return false;
        if (typeof el.checkVisibility === 'function') {
          return el.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
            contentVisibilityAuto: true,
          });
        }
        return true;
      };

      const zIndexOf = (style: CSSStyleDeclaration): number => {
        if (style.zIndex === 'auto') return 0;
        const parsed = Number.parseInt(style.zIndex, 10);
        return Number.isFinite(parsed) ? parsed : 0;
      };

      const paintLayersAt = (
        el: Element,
        cx: number,
        cy: number,
        fgColor: Rgba | null,
      ): { fg: Rgba; bg: Rgba } => {
        const chain: Element[] = [];
        let cur: Element | null = el;
        while (cur) {
          chain.unshift(cur);
          cur = cur.parentElement;
        }

        type Layer = { readonly bg: Rgba; readonly opacity: number };
        const layers: Layer[] = [];

        for (let i = 0; i < chain.length; i += 1) {
          const node = chain[i];
          if (!node) continue;
          const style = getComputedStyle(node);
          const bg = parseColor(style.backgroundColor);
          const opacity = Number.parseFloat(style.opacity);
          layers.push({ bg, opacity: Number.isFinite(opacity) ? opacity : 1 });

          const nextChild = chain[i + 1];
          if (
            nextChild &&
            (style.position !== 'static' ||
              style.isolation === 'isolate' ||
              style.zIndex !== 'auto')
          ) {
            const branchStyle = getComputedStyle(nextChild);
            const branchZ =
              branchStyle.position === 'static' && branchStyle.zIndex === 'auto'
                ? 0
                : zIndexOf(branchStyle);
            const siblings = Array.from(node.children);
            const branchIndex = siblings.indexOf(nextChild);
            const behindSiblings: { layer: Layer; z: number; idx: number }[] = [];

            for (let sIdx = 0; sIdx < siblings.length; sIdx += 1) {
              const sib = siblings[sIdx];
              if (!sib || sib === nextChild) continue;
              const sibStyle = getComputedStyle(sib);
              if (sibStyle.display === 'none' || sibStyle.visibility === 'hidden') continue;
              const sibOpacity = Number.parseFloat(sibStyle.opacity);
              if (sibOpacity <= 0.01) continue;
              const sibBg = parseColor(sibStyle.backgroundColor);
              if (sibBg.a <= 0.001) continue;
              const sibRect = sib.getBoundingClientRect();
              if (
                cx < sibRect.left ||
                cx > sibRect.right ||
                cy < sibRect.top ||
                cy > sibRect.bottom
              ) {
                continue;
              }
              const sibZ =
                sibStyle.position === 'static' && sibStyle.zIndex === 'auto'
                  ? 0
                  : zIndexOf(sibStyle);
              const paintsBefore = sibZ < branchZ || (sibZ === branchZ && sIdx < branchIndex);
              if (paintsBefore) {
                behindSiblings.push({
                  layer: { bg: sibBg, opacity: Number.isFinite(sibOpacity) ? sibOpacity : 1 },
                  z: sibZ,
                  idx: sIdx,
                });
              }
            }

            behindSiblings.sort((a, b) => (a.z !== b.z ? a.z - b.z : a.idx - b.idx));
            for (const entry of behindSiblings) {
              layers.push(entry.layer);
            }
          }
        }

        const paintChain = (
          index: number,
          currentBg: Rgba,
        ): { readonly bg: Rgba; readonly fg: Rgba } => {
          if (index >= layers.length) {
            return {
              bg: currentBg,
              fg: fgColor ? sourceOver(fgColor, currentBg) : currentBg,
            };
          }
          const layer = layers[index];
          if (!layer) return { bg: currentBg, fg: currentBg };
          if (layer.opacity < 0.999) {
            const inner = paintChain(index + 1, layer.bg);
            const scaledBg: Rgba = { ...inner.bg, a: inner.bg.a * layer.opacity };
            const scaledFg: Rgba = { ...inner.fg, a: inner.fg.a * layer.opacity };
            return {
              bg: sourceOver(scaledBg, currentBg),
              fg: sourceOver(scaledFg, currentBg),
            };
          }
          return paintChain(index + 1, sourceOver(layer.bg, currentBg));
        };

        return paintChain(0, { r: 255, g: 255, b: 255, a: 1 });
      };

      const rootEl: Element | null = scope ? document.querySelector(scope) : document.body;
      if (!rootEl) {
        return {
          route: currentRoute,
          stateLabel: currentState,
          checkedCount: 0,
          minTextRatio: null,
          minLargeTextRatio: null,
          minPlaceholderRatio: null,
          minUiRatio: null,
          failures: [],
        };
      }

      const activeModal =
        scope === null
          ? (Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).find(
              (el) => isElementVisible(el),
            ) ?? null)
          : null;

      let checkedCount = 0;
      const stats: {
        minText: number | null;
        minLarge: number | null;
        minPlaceholder: number | null;
        minUi: number | null;
      } = {
        minText: null,
        minLarge: null,
        minPlaceholder: null,
        minUi: null,
      };
      const failures: ContrastSample[] = [];
      const seenElements = new Set<Element>();

      const recordRatio = (
        category: ContrastSample['category'],
        el: Element,
        text: string,
        fg: Rgba,
        bg: Rgba,
        threshold: number,
      ): void => {
        checkedCount += 1;
        const ratio = contrastRatio(fg, bg);
        if (category === 'text') {
          stats.minText = stats.minText === null ? ratio : Math.min(stats.minText, ratio);
        } else if (category === 'large-text') {
          stats.minLarge = stats.minLarge === null ? ratio : Math.min(stats.minLarge, ratio);
        } else if (category === 'placeholder') {
          stats.minPlaceholder =
            stats.minPlaceholder === null ? ratio : Math.min(stats.minPlaceholder, ratio);
        } else {
          stats.minUi = stats.minUi === null ? ratio : Math.min(stats.minUi, ratio);
        }
        if (ratio < threshold) {
          failures.push({
            category,
            selector: describeElement(el),
            text: text.slice(0, 80),
            ratio: Number(ratio.toFixed(3)),
            threshold,
            fg: formatRgba(fg),
            bg: formatRgba(bg),
          });
        }
      };

      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = node.textContent?.trim() ?? '';
        const parent = node.parentElement;
        if (
          text.length > 0 &&
          parent &&
          !seenElements.has(parent) &&
          !parent.closest('svg, script, style, noscript, [aria-hidden="true"]') &&
          (!activeModal || activeModal.contains(parent)) &&
          isElementVisible(parent) &&
          !isDisabledNode(parent)
        ) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          if (rect.width >= 0.5 && rect.height >= 0.5 && rect.bottom > 0 && rect.right > 0) {
            const style = getComputedStyle(parent);
            const fgRaw = parseColor(style.color);
            const isGradientClipText =
              fgRaw.a === 0 &&
              (style.backgroundClip === 'text' || style.webkitBackgroundClip === 'text');
            if (!isGradientClipText) {
              const cx = rect.left + rect.width / 2;
              const cy = rect.top + rect.height / 2;
              const inViewport =
                cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;
              const topHits = inViewport ? document.elementsFromPoint(cx, cy) : [];
              const coveredByOtherLayer =
                inViewport &&
                topHits.length > 0 &&
                !topHits.some(
                  (hit) => hit === parent || hit.contains(parent) || parent.contains(hit),
                );
              if (!coveredByOtherLayer) {
                seenElements.add(parent);
                const painted = paintLayersAt(parent, cx, cy, fgRaw);
                const fontSize = Number.parseFloat(style.fontSize) || 14;
                const fontWeight =
                  style.fontWeight === 'bold'
                    ? 700
                    : style.fontWeight === 'normal'
                      ? 400
                      : Number.parseInt(style.fontWeight, 10) || 400;
                const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
                recordRatio(
                  isLarge ? 'large-text' : 'text',
                  parent,
                  text,
                  painted.fg,
                  painted.bg,
                  isLarge ? 3.0 : 4.5,
                );
              }
            }
          }
        }
        node = walker.nextNode();
      }

      const controls = Array.from(rootEl.querySelectorAll('input, textarea'));
      for (const control of controls) {
        if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
          continue;
        }
        if (control.type === 'hidden') continue;
        if (!control.placeholder || control.value.length > 0) continue;
        if (
          control.closest('[aria-hidden="true"]') ||
          (activeModal && !activeModal.contains(control)) ||
          !isElementVisible(control) ||
          isDisabledNode(control)
        ) {
          continue;
        }
        const phStyle = getComputedStyle(control, '::placeholder');
        const phColor = parseColor(phStyle.color);
        if (phColor.a <= 0.01) continue;
        const rect = control.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const painted = paintLayersAt(control, cx, cy, phColor);
        const fontSize = Number.parseFloat(phStyle.fontSize) || 14;
        const threshold = fontSize >= 24 ? 3.0 : 4.5;
        recordRatio(
          'placeholder',
          control,
          `placeholder:${control.placeholder}`,
          painted.fg,
          painted.bg,
          threshold,
        );
      }

      const uiControls = Array.from(
        rootEl.querySelectorAll(
          '[role="checkbox"], [role="switch"], [role="radio"], [role="tab"][aria-selected="true"]',
        ),
      );
      for (const ctrl of uiControls) {
        if (
          ctrl.closest('[aria-hidden="true"]') ||
          (activeModal && !activeModal.contains(ctrl)) ||
          !isElementVisible(ctrl) ||
          isDisabledNode(ctrl)
        ) {
          continue;
        }
        const rect = ctrl.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const style = getComputedStyle(ctrl);
        const role = ctrl.getAttribute('role');
        if (role === 'checkbox' || role === 'switch') {
          const checked =
            ctrl.getAttribute('aria-checked') === 'true' ||
            ctrl.getAttribute('data-checked') === '' ||
            ctrl.getAttribute('data-checked') === 'true';
          if (checked) {
            const bgColor = parseColor(style.backgroundColor);
            if (bgColor.a > 0.01) {
              const parentBg = ctrl.parentElement
                ? paintLayersAt(ctrl.parentElement, cx, cy, null).bg
                : { r: 255, g: 255, b: 255, a: 1 };
              const paintedCtrl = paintLayersAt(ctrl, cx, cy, null).bg;
              recordRatio('ui', ctrl, `${role}:checked`, paintedCtrl, parentBg, 3.0);
            }
          } else {
            const borderColor = parseColor(style.borderTopColor);
            const borderWidth = Number.parseFloat(style.borderTopWidth);
            const bgColor = parseColor(style.backgroundColor);
            const parentBg = ctrl.parentElement
              ? paintLayersAt(ctrl.parentElement, cx, cy, null).bg
              : { r: 255, g: 255, b: 255, a: 1 };
            if (borderWidth >= 1 && borderColor.a > 0.01) {
              const paintedBorder = sourceOver(borderColor, parentBg);
              recordRatio('ui', ctrl, `${role}:border`, paintedBorder, parentBg, 3.0);
            } else if (bgColor.a > 0.01) {
              const paintedTrack = sourceOver(bgColor, parentBg);
              recordRatio('ui', ctrl, `${role}:track`, paintedTrack, parentBg, 3.0);
            }
          }
        } else if (role === 'tab') {
          const afterStyle = getComputedStyle(ctrl, '::after');
          const afterBg = parseColor(afterStyle.backgroundColor);
          const afterOpacity = Number.parseFloat(afterStyle.opacity);
          if (afterBg.a > 0.01 && afterOpacity > 0.1) {
            const tabBg = paintLayersAt(ctrl, cx, cy, null).bg;
            const paintedIndicator = sourceOver({ ...afterBg, a: afterBg.a * afterOpacity }, tabBg);
            recordRatio('ui', ctrl, 'tab:indicator', paintedIndicator, tabBg, 3.0);
          }
        }
      }

      return {
        route: currentRoute,
        stateLabel: currentState,
        checkedCount,
        minTextRatio: stats.minText === null ? null : Number(stats.minText.toFixed(3)),
        minLargeTextRatio: stats.minLarge === null ? null : Number(stats.minLarge.toFixed(3)),
        minPlaceholderRatio:
          stats.minPlaceholder === null ? null : Number(stats.minPlaceholder.toFixed(3)),
        minUiRatio: stats.minUi === null ? null : Number(stats.minUi.toFixed(3)),
        failures,
      };
    },
    { route, stateLabel, scopeSelector },
  );

  contrastSummary.push({
    route,
    state: stateLabel,
    checked: report.checkedCount,
    minText: report.minTextRatio,
    minLarge: report.minLargeTextRatio,
    minPlaceholder: report.minPlaceholderRatio,
    minUi: report.minUiRatio,
  });

  expect(report.checkedCount, `${route} [${stateLabel}] measured elements`).toBeGreaterThan(0);
  expect(report.failures, `${route} [${stateLabel}] contrast failures`).toEqual([]);
  return report;
}

async function measureHoverElement(
  browser: Browser,
  locator: Locator,
  label: string,
): Promise<void> {
  await locator.scrollIntoView();
  await browser.mouse.move(0, 0);
  await settlePage(browser);

  const box = await locator.boundingBox();
  expect(box, `${label} boundingBox`).not.toBeNull();
  if (!box) return;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  const readStyle = async (): Promise<HoverSnapshot> =>
    browser.evaluate<HoverSnapshot, { x: number; y: number }>(({ x, y }) => {
      const parseColor = (raw: string) => {
        const trimmed = raw.trim().toLowerCase();
        if (!trimmed || trimmed === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
        const commaRgb =
          /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+%?))?\s*\)$/.exec(
            trimmed,
          );
        if (commaRgb) {
          const rawAlpha = commaRgb[4];
          const a =
            rawAlpha === undefined
              ? 1
              : rawAlpha.endsWith('%')
                ? Number.parseFloat(rawAlpha) / 100
                : Number.parseFloat(rawAlpha);
          return {
            r: Number.parseFloat(commaRgb[1] ?? '0'),
            g: Number.parseFloat(commaRgb[2] ?? '0'),
            b: Number.parseFloat(commaRgb[3] ?? '0'),
            a,
          };
        }
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
        if (!ctx) return { r: 0, g: 0, b: 0, a: 0 };
        ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.fillStyle = raw;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0, a: (d[3] ?? 0) / 255 };
      };
      const sourceOver = (
        top: { r: number; g: number; b: number; a: number },
        bottom: { r: number; g: number; b: number; a: number },
      ) => {
        const a = top.a + bottom.a * (1 - top.a);
        if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
        return {
          r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
          g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
          b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
          a,
        };
      };
      const lum = (c: { r: number; g: number; b: number }) => {
        const lin = (v: number) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
      };

      const hit = document.elementFromPoint(x, y);
      const el = hit?.closest('button, a, [role="tab"], [role="radio"], [role="menuitem"]') ?? hit;
      if (!el) {
        throw new Error(`No element found at (${x}, ${y})`);
      }

      const chain: Element[] = [];
      let cur: Element | null = el;
      while (cur) {
        chain.unshift(cur);
        cur = cur.parentElement;
      }
      let bg = { r: 255, g: 255, b: 255, a: 1 };
      for (const node of chain) {
        bg = sourceOver(parseColor(getComputedStyle(node).backgroundColor), bg);
      }
      const style = getComputedStyle(el);
      const fg = sourceOver(parseColor(style.color), bg);
      const la = lum(fg);
      const lb = lum(bg);
      const ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      const fontSize = Number.parseFloat(style.fontSize) || 14;
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
      const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
      return {
        ratio: Number(ratio.toFixed(3)),
        threshold: isLarge ? 3.0 : 4.5,
        fg: `rgb(${Math.round(fg.r)}, ${Math.round(fg.g)}, ${Math.round(fg.b)})`,
        bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
        boxShadow: style.boxShadow,
      };
    }, point);

  const before = await readStyle();
  await locator.hover();
  await settlePage(browser);
  const after = await readStyle();

  expect(after.ratio, `${label} hover contrast`).toBeGreaterThanOrEqual(after.threshold);
  const changed =
    after.bg !== before.bg || after.fg !== before.fg || after.boxShadow !== before.boxShadow;
  expect(changed, `${label} hover visual change`).toBe(true);
  await browser.mouse.move(0, 0);
}

async function measureActiveFocusRing(browser: Browser, label: string): Promise<FocusResult> {
  await settlePage(browser);
  const result = await browser.evaluate<FocusResult>(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) {
      return { tagName: 'none', selector: 'none', minRatio: null, indicators: [] };
    }

    const parseColor = (raw: string) => {
      const trimmed = raw.trim().toLowerCase();
      if (!trimmed || trimmed === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
      const commaRgb =
        /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+%?))?\s*\)$/.exec(
          trimmed,
        );
      if (commaRgb) {
        const rawAlpha = commaRgb[4];
        const a =
          rawAlpha === undefined
            ? 1
            : rawAlpha.endsWith('%')
              ? Number.parseFloat(rawAlpha) / 100
              : Number.parseFloat(rawAlpha);
        return {
          r: Number.parseFloat(commaRgb[1] ?? '0'),
          g: Number.parseFloat(commaRgb[2] ?? '0'),
          b: Number.parseFloat(commaRgb[3] ?? '0'),
          a,
        };
      }
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
      if (!ctx) return { r: 0, g: 0, b: 0, a: 0 };
      ctx.fillStyle = 'rgba(0,0,0,0)';
      ctx.fillStyle = raw;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0, a: (d[3] ?? 0) / 255 };
    };

    const sourceOver = (
      top: { r: number; g: number; b: number; a: number },
      bottom: { r: number; g: number; b: number; a: number },
    ) => {
      const a = top.a + bottom.a * (1 - top.a);
      if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
        g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
        b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
        a,
      };
    };

    const lum = (c: { r: number; g: number; b: number }) => {
      const lin = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    };

    const contrast = (
      a: { r: number; g: number; b: number },
      b: { r: number; g: number; b: number },
    ) => {
      const la = lum(a);
      const lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };

    const fmt = (c: { r: number; g: number; b: number }) =>
      `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

    const backdropOf = (el: Element) => {
      const chain: Element[] = [];
      let cur: Element | null = el.parentElement;
      while (cur) {
        chain.unshift(cur);
        cur = cur.parentElement;
      }
      let bg = { r: 255, g: 255, b: 255, a: 1 };
      for (const node of chain) {
        bg = sourceOver(parseColor(getComputedStyle(node).backgroundColor), bg);
      }
      return bg;
    };

    const splitShadows = (boxShadow: string): string[] => {
      if (!boxShadow || boxShadow === 'none') return [];
      const parts: string[] = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < boxShadow.length; i += 1) {
        const ch = boxShadow[i];
        if (ch === '(') depth += 1;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) {
          parts.push(boxShadow.slice(start, i).trim());
          start = i + 1;
        }
      }
      parts.push(boxShadow.slice(start).trim());
      return parts.filter(Boolean);
    };

    const targets: Element[] = [active];
    const wrapper = active.closest(
      '[data-slot="password-input"], [data-slot="input-group"], [data-slot="number-input-group"], [data-slot="date-input"]',
    );
    if (wrapper && wrapper !== active) targets.push(wrapper);

    const indicators: Array<{
      readonly kind: string;
      readonly color: string;
      readonly bg: string;
      readonly ratio: number;
    }> = [];

    for (const target of targets) {
      const style = getComputedStyle(target);
      const backdrop = backdropOf(target);

      const outlineW = Number.parseFloat(style.outlineWidth);
      if (style.outlineStyle !== 'none' && outlineW >= 1) {
        const c = sourceOver(parseColor(style.outlineColor), backdrop);
        indicators.push({
          kind: 'outline',
          color: fmt(c),
          bg: fmt(backdrop),
          ratio: Number(contrast(c, backdrop).toFixed(3)),
        });
      }

      const shadows = splitShadows(style.boxShadow);
      for (const shadow of shadows) {
        const match =
          /^(rgba?\([^)]+\)|color\([^)]+\)|#[0-9a-f]+)\s+([-\d.]+px)\s+([-\d.]+px)\s+([-\d.]+px)(?:\s+([-\d.]+px))?/.exec(
            shadow,
          );
        if (!match) continue;
        const blur = Number.parseFloat(match[4] ?? '0');
        const spread = Number.parseFloat(match[5] ?? '0');
        if (spread > 0 && blur === 0) {
          const ringColor = sourceOver(parseColor(match[1] ?? ''), backdrop);
          const ratio = contrast(ringColor, backdrop);
          if (fmt(ringColor) !== fmt(backdrop)) {
            indicators.push({
              kind: 'ring-shadow',
              color: fmt(ringColor),
              bg: fmt(backdrop),
              ratio: Number(ratio.toFixed(3)),
            });
          }
        }
      }

      const borderW = Number.parseFloat(style.borderTopWidth);
      const borderColor = parseColor(style.borderTopColor);
      if (borderW >= 1 && borderColor.a > 0.01) {
        const paintedBorder = sourceOver(borderColor, backdrop);
        const ratio = contrast(paintedBorder, backdrop);
        if (ratio >= 2.0) {
          indicators.push({
            kind: 'focus-border',
            color: fmt(paintedBorder),
            bg: fmt(backdrop),
            ratio: Number(ratio.toFixed(3)),
          });
        }
      }
    }

    const minRatio =
      indicators.length === 0 ? null : Math.min(...indicators.map((indicator) => indicator.ratio));

    const idPart = active.id ? `#${active.id}` : '';
    const slot = active.getAttribute('data-slot');
    const slotPart = slot ? `[data-slot="${slot}"]` : '';

    return {
      tagName: active.tagName.toLowerCase(),
      selector: `${active.tagName.toLowerCase()}${idPart}${slotPart}`,
      minRatio,
      indicators,
    };
  });

  expect(
    result.indicators.length,
    `${label} (${result.selector}) has visible focus indicator`,
  ).toBeGreaterThan(0);
  for (const indicator of result.indicators) {
    expect(
      indicator.ratio,
      `${label} (${result.selector}) ${indicator.kind} focus contrast (${indicator.color} on ${indicator.bg})`,
    ).toBeGreaterThanOrEqual(3.0);
  }
  return result;
}

async function checkInvalidControlsAndAlerts(
  browser: Browser,
  label: string,
  scopeSelector: string | null = null,
): Promise<InvalidResult> {
  await settlePage(browser);
  const res = await browser.evaluate<InvalidResult, string | null>((scope) => {
    const parseColor = (raw: string) => {
      const trimmed = raw.trim().toLowerCase();
      if (!trimmed || trimmed === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
      const commaRgb =
        /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+%?))?\s*\)$/.exec(
          trimmed,
        );
      if (commaRgb) {
        const rawAlpha = commaRgb[4];
        const a =
          rawAlpha === undefined
            ? 1
            : rawAlpha.endsWith('%')
              ? Number.parseFloat(rawAlpha) / 100
              : Number.parseFloat(rawAlpha);
        return {
          r: Number.parseFloat(commaRgb[1] ?? '0'),
          g: Number.parseFloat(commaRgb[2] ?? '0'),
          b: Number.parseFloat(commaRgb[3] ?? '0'),
          a,
        };
      }
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
      if (!ctx) return { r: 0, g: 0, b: 0, a: 0 };
      ctx.fillStyle = 'rgba(0,0,0,0)';
      ctx.fillStyle = raw;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0, a: (d[3] ?? 0) / 255 };
    };
    const sourceOver = (
      top: { r: number; g: number; b: number; a: number },
      bottom: { r: number; g: number; b: number; a: number },
    ) => {
      const a = top.a + bottom.a * (1 - top.a);
      if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
        g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
        b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
        a,
      };
    };
    const lum = (c: { r: number; g: number; b: number }) => {
      const lin = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    };
    const contrast = (
      a: { r: number; g: number; b: number },
      b: { r: number; g: number; b: number },
    ) => {
      const la = lum(a);
      const lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const fmt = (c: { r: number; g: number; b: number }) =>
      `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
    const paintedBg = (el: Element) => {
      const chain: Element[] = [];
      let cur: Element | null = el;
      while (cur) {
        chain.unshift(cur);
        cur = cur.parentElement;
      }
      let bg = { r: 255, g: 255, b: 255, a: 1 };
      for (const node of chain) {
        bg = sourceOver(parseColor(getComputedStyle(node).backgroundColor), bg);
      }
      return bg;
    };

    const root = scope ? document.querySelector(scope) : document.body;
    if (!root) {
      return {
        controlCount: 0,
        alertCount: 0,
        minBorderRatio: null,
        minAlertRatio: null,
        failures: [],
      };
    }

    const invalids = Array.from(root.querySelectorAll('[aria-invalid="true"]'));
    let minBorderRatio: number | null = null;
    let minAlertRatio: number | null = null;
    const failures: Array<{
      readonly kind: string;
      readonly selector: string;
      readonly ratio: number;
      readonly threshold: number;
      readonly fg: string;
      readonly bg: string;
    }> = [];

    for (const control of invalids) {
      const wrapper =
        control.closest('[data-slot="password-input"], [data-slot="input-group"]') ?? control;
      const style = getComputedStyle(wrapper);
      const borderW = Number.parseFloat(style.borderTopWidth);
      if (borderW < 1) continue;
      const backdrop = wrapper.parentElement
        ? paintedBg(wrapper.parentElement)
        : { r: 255, g: 255, b: 255, a: 1 };
      const borderColor = sourceOver(parseColor(style.borderTopColor), backdrop);
      const ratio = contrast(borderColor, backdrop);
      minBorderRatio = minBorderRatio === null ? ratio : Math.min(minBorderRatio, ratio);
      if (ratio < 3.0) {
        failures.push({
          kind: 'invalid-border',
          selector: wrapper.id ? `#${wrapper.id}` : wrapper.tagName.toLowerCase(),
          ratio: Number(ratio.toFixed(3)),
          threshold: 3.0,
          fg: fmt(borderColor),
          bg: fmt(backdrop),
        });
      }
    }

    const alerts = Array.from(root.querySelectorAll('[role="alert"]')).filter(
      (el) => (el.textContent?.trim().length ?? 0) > 0,
    );
    for (const alert of alerts) {
      const style = getComputedStyle(alert);
      const bg = paintedBg(alert);
      const fg = sourceOver(parseColor(style.color), bg);
      const ratio = contrast(fg, bg);
      minAlertRatio = minAlertRatio === null ? ratio : Math.min(minAlertRatio, ratio);
      if (ratio < 4.5) {
        failures.push({
          kind: 'alert-text',
          selector: alert.id ? `#${alert.id}` : alert.tagName.toLowerCase(),
          ratio: Number(ratio.toFixed(3)),
          threshold: 4.5,
          fg: fmt(fg),
          bg: fmt(bg),
        });
      }
    }

    return {
      controlCount: invalids.length,
      alertCount: alerts.length,
      minBorderRatio: minBorderRatio === null ? null : Number(minBorderRatio.toFixed(3)),
      minAlertRatio: minAlertRatio === null ? null : Number(minAlertRatio.toFixed(3)),
      failures,
    };
  }, scopeSelector);

  expect(res.controlCount, `${label} invalid control count`).toBeGreaterThan(0);
  expect(res.alertCount, `${label} invalid alert count`).toBeGreaterThan(0);
  expect(res.failures, `${label} invalid contrast failures`).toEqual([]);
  return res;
}

async function checkPairDifferentiation(
  browser: Browser,
  selectedSelector: string,
  unselectedSelector: string,
  indicatorMode: 'none' | 'segmented' | 'tab-after',
  label: string,
): Promise<SelectedDifferentiationResult> {
  await settlePage(browser);
  const res = await browser.evaluate<
    SelectedDifferentiationResult,
    { selectedSelector: string; unselectedSelector: string; indicatorMode: string }
  >(
    ({ selectedSelector: selA, unselectedSelector: selB, indicatorMode: mode }) => {
      const parseColor = (raw: string) => {
        const trimmed = raw.trim().toLowerCase();
        if (!trimmed || trimmed === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
        const commaRgb =
          /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+%?))?\s*\)$/.exec(
            trimmed,
          );
        if (commaRgb) {
          const rawAlpha = commaRgb[4];
          const a =
            rawAlpha === undefined
              ? 1
              : rawAlpha.endsWith('%')
                ? Number.parseFloat(rawAlpha) / 100
                : Number.parseFloat(rawAlpha);
          return {
            r: Number.parseFloat(commaRgb[1] ?? '0'),
            g: Number.parseFloat(commaRgb[2] ?? '0'),
            b: Number.parseFloat(commaRgb[3] ?? '0'),
            a,
          };
        }
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
        if (!ctx) return { r: 0, g: 0, b: 0, a: 0 };
        ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.fillStyle = raw;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0, a: (d[3] ?? 0) / 255 };
      };
      const sourceOver = (
        top: { r: number; g: number; b: number; a: number },
        bottom: { r: number; g: number; b: number; a: number },
      ) => {
        const a = top.a + bottom.a * (1 - top.a);
        if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
        return {
          r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
          g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
          b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
          a,
        };
      };
      const lum = (c: { r: number; g: number; b: number }) => {
        const lin = (v: number) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
      };
      const contrast = (
        a: { r: number; g: number; b: number },
        b: { r: number; g: number; b: number },
      ) => {
        const la = lum(a);
        const lb = lum(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      };
      const fmt = (c: { r: number; g: number; b: number }) =>
        `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

      const paintElement = (el: Element, includeSegmentedIndicator: boolean) => {
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const chain: Element[] = [];
        let cur: Element | null = el;
        while (cur) {
          chain.unshift(cur);
          cur = cur.parentElement;
        }
        let bg = { r: 255, g: 255, b: 255, a: 1 };
        for (const node of chain) {
          bg = sourceOver(parseColor(getComputedStyle(node).backgroundColor), bg);
          if (includeSegmentedIndicator && node.getAttribute('data-slot') === 'segmented-control') {
            const indicator = node.querySelector('[data-slot="segmented-control-indicator"]');
            if (indicator) {
              const indRect = indicator.getBoundingClientRect();
              if (
                cx >= indRect.left &&
                cx <= indRect.right &&
                cy >= indRect.top &&
                cy <= indRect.bottom
              ) {
                const indStyle = getComputedStyle(indicator);
                if (indStyle.display !== 'none' && Number.parseFloat(indStyle.opacity) > 0) {
                  bg = sourceOver(parseColor(indStyle.backgroundColor), bg);
                }
              }
            }
          }
        }
        const fg = sourceOver(parseColor(getComputedStyle(el).color), bg);
        return { fg, bg, ratio: Number(contrast(fg, bg).toFixed(3)) };
      };

      const elA = document.querySelector(selA);
      const elB = document.querySelector(selB);
      if (!elA || !elB) {
        throw new Error(`Missing elements for ${selA} / ${selB}`);
      }
      const paintedA = paintElement(elA, mode === 'segmented');
      const paintedB = paintElement(elB, mode === 'segmented');

      let indicatorRatio: number | null = null;
      if (mode === 'tab-after') {
        const afterStyle = getComputedStyle(elA, '::after');
        const afterOpacity = Number.parseFloat(afterStyle.opacity);
        const afterBg = parseColor(afterStyle.backgroundColor);
        if (afterOpacity > 0.1 && afterBg.a > 0.01) {
          const ind = sourceOver({ ...afterBg, a: afterBg.a * afterOpacity }, paintedA.bg);
          indicatorRatio = Number(contrast(ind, paintedA.bg).toFixed(3));
        }
      }

      const visuallyDistinct =
        fmt(paintedA.bg) !== fmt(paintedB.bg) ||
        fmt(paintedA.fg) !== fmt(paintedB.fg) ||
        (indicatorRatio !== null && indicatorRatio >= 3.0);

      return {
        selectedRatio: paintedA.ratio,
        unselectedRatio: paintedB.ratio,
        selectedFg: fmt(paintedA.fg),
        selectedBg: fmt(paintedA.bg),
        unselectedFg: fmt(paintedB.fg),
        unselectedBg: fmt(paintedB.bg),
        indicatorRatio,
        visuallyDistinct,
      };
    },
    { selectedSelector, unselectedSelector, indicatorMode },
  );

  expect(res.selectedRatio, `${label} selected text ratio`).toBeGreaterThanOrEqual(4.5);
  expect(res.unselectedRatio, `${label} unselected text ratio`).toBeGreaterThanOrEqual(4.5);
  expect(res.visuallyDistinct, `${label} selected vs unselected differentiation`).toBe(true);
  if (indicatorMode === 'tab-after') {
    expect(
      res.indicatorRatio ?? 0,
      `${label} active tab indicator contrast`,
    ).toBeGreaterThanOrEqual(3.0);
  }
  return res;
}

test('ui contrast: unauthenticated /login resting, invalid, and focus-visible states', async ({
  app,
  browser,
  screen,
}) => {
  await app.open('/login');
  await expect(screen.getByRole('heading', '登录 PACE')).toBeVisible();

  await browser.mouse.move(0, 0);
  await scanContrast(browser, '/login', 'resting');

  await browser.locator('h1').click();
  await browser.keyboard.press('Tab');
  await measureActiveFocusRing(browser, '/login #username focus-visible');
  await browser.keyboard.press('Tab');
  await measureActiveFocusRing(browser, '/login #password focus-visible');
  await browser.keyboard.press('Tab');
  await measureActiveFocusRing(browser, '/login password toggle focus-visible');
  await browser.keyboard.press('Tab');
  await measureActiveFocusRing(browser, '/login submit button focus-visible');

  await screen.getByRole('button', '登录').tap();
  await expect(browser.locator('#username[aria-invalid="true"]')).toBeVisible();
  await expect(browser.locator('#password[aria-invalid="true"]')).toBeVisible();
  await expect(browser.locator('#username-error')).toBeVisible();
  await expect(browser.locator('#password-error')).toBeVisible();

  await checkInvalidControlsAndAlerts(browser, '/login empty submit');
  await scanContrast(browser, '/login', 'invalid');
});

test('ui contrast: authenticated routes resting, hover, focus, selected, and popup states', {
  session: 'admin',
}, async ({ app, browser, screen }) => {
  await app.open('/agents');
  await expect(screen.getByRole('heading', '找专家')).toBeVisible();

  const suffix = Date.now().toString(36);
  const agentName = `E2E 对比度专家 ${suffix}`;
  const createdAgent = await browserFetch(browser, 'POST', '/api/agents', {
    slug: `e2e-contrast-${suffix}`,
    name: agentName,
    description: '用于验证多页面多状态真实渲染对比度',
    tags: ['对比度', '审计'],
  });
  if (createdAgent.status !== 201) {
    throw new Error(`创建临时专家失败 ${createdAgent.status}：${createdAgent.text}`);
  }
  const agentId = (JSON.parse(createdAgent.text) as { id: string }).id;

  let failure: unknown;
  try {
    for (const item of [
      {
        name: `contrast-llm-${suffix}`,
        prompt: '请回答验证问题',
        expectation: '应给出清晰回答',
        judgeMode: 'llm',
      },
      {
        name: `contrast-contains-${suffix}`,
        prompt: '请输出关键字',
        expectation: 'OK',
        judgeMode: 'contains',
      },
    ]) {
      const res = await browserFetch(browser, 'POST', '/api/eval/cases', {
        agentId,
        ...item,
      });
      if (res.status !== 201) {
        throw new Error(`创建评估用例失败 ${res.status}：${res.text}`);
      }
    }

    await app.open('/agents');
    await expect(screen.getByRole('link', { name: agentName, exact: true })).toBeVisible();
    await browser.mouse.move(0, 0);

    await scanContrast(browser, '/agents', 'resting');
    await checkPairDifferentiation(
      browser,
      'nav[aria-label="主导航"] a[aria-current="page"]',
      'nav[aria-label="主导航"] a:not([aria-current="page"])',
      'none',
      '/agents active sidebar link',
    );

    await measureHoverElement(
      browser,
      browser.locator('nav[aria-label="主导航"] a:not([aria-current="page"])').first(),
      '/agents sidebar link hover',
    );
    await measureHoverElement(
      browser,
      screen.getByRole('button', '新建专家').first(),
      '/agents primary button hover',
    );
    await measureHoverElement(
      browser,
      screen.getByRole('button', '筛选'),
      '/agents outline button hover',
    );
    await measureHoverElement(
      browser,
      screen.getByRole('button', { name: `查看 ${agentName} 工牌`, exact: true }),
      '/agents ghost card button hover',
    );
    await measureHoverElement(
      browser,
      browser.locator('.agent-create-fan').first(),
      '/agents create fan card hover',
    );

    await browser.locator('#agents-search').focus();
    await browser.keyboard.press('Tab');
    await measureActiveFocusRing(browser, '/agents filter button focus-visible');
    await browser.keyboard.press('Tab');
    await measureActiveFocusRing(browser, '/agents favorite toggle focus-visible');

    await screen.getByRole('button', '筛选').tap();
    await expect(browser.locator('[data-slot="popover-content"]')).toBeVisible();
    await scanContrast(browser, '/agents', 'filter-popover-open', '[data-slot="popover-content"]');
    await browser.keyboard.press('Escape');
    await browser.locator('[data-slot="popover-content"]').waitFor({ state: 'hidden' });

    await screen.getByRole('button', '新建专家').first().tap();
    const dialog = browser.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await scanContrast(browser, '/agents', 'create-dialog-open', '[role="dialog"]');

    await browser.locator('#new-agent-visibility').tap();
    const listbox = browser.locator('[role="listbox"]');
    await expect(listbox).toBeVisible();
    await browser.locator('[role="listbox"] [role="option"]').last().hover();
    await scanContrast(browser, '/agents', 'select-listbox-open', '[role="listbox"]');
    await browser.keyboard.press('Escape');
    await listbox.waitFor({ state: 'hidden' });

    await dialog.getByRole('button', '创建', { exact: true }).tap();
    await expect(browser.locator('#new-agent-name[aria-invalid="true"]')).toBeVisible();
    await checkInvalidControlsAndAlerts(
      browser,
      '/agents create dialog invalid',
      '[role="dialog"]',
    );

    await dialog.getByRole('button', '取消', { exact: true }).tap();
    await dialog.waitFor({ state: 'hidden' });

    await screen.getByRole('button', { name: `操作 ${agentName}`, exact: true }).tap();
    const menu = browser.locator('[role="menu"]');
    await expect(menu).toBeVisible();
    await browser.locator('[role="menu"] [role="menuitem"]').last().hover();
    await scanContrast(browser, '/agents', 'row-menu-open', '[role="menu"]');
    await browser.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });

    await app.open('/operations');
    await expect(screen.getByRole('heading', '概况')).toBeVisible();
    await expect(screen.getByRole('button', '导出 CSV')).toBeVisible();
    await browser.mouse.move(0, 0);

    await scanContrast(browser, '/operations', 'resting-overview');
    await measureHoverElement(
      browser,
      screen.getByRole('button', '导出 CSV'),
      '/operations outline export button hover',
    );
    await screen.getByRole('button', '导出 CSV').focus();
    await browser.keyboard.press('Tab');
    await measureActiveFocusRing(browser, '/operations button focus-visible');

    await screen.getByRole('tab', 'SLO 与队列').tap();
    await expect(browser.locator('[data-slot="segmented-control"]')).toBeVisible();
    await browser.mouse.move(0, 0);

    await scanContrast(browser, '/operations', 'observability-slo');
    await checkPairDifferentiation(
      browser,
      '[data-slot="segmented-control"] [role="radio"][aria-checked="true"]',
      '[data-slot="segmented-control"] [role="radio"][aria-checked="false"]',
      'segmented',
      '/operations observability segmented control',
    );
    await measureHoverElement(
      browser,
      screen.getByRole('radio', '队列'),
      '/operations segmented option hover',
    );

    await app.open(`/eval?agent=${agentId}`);
    await expect(screen.getByRole('heading', '评估')).toBeVisible();
    await expect(screen.getByRole('tab', '评估运行', { exact: false })).toBeVisible();
    await browser.mouse.move(0, 0);

    await scanContrast(browser, '/eval', 'resting-runs');
    await checkPairDifferentiation(
      browser,
      '[role="tab"][aria-selected="true"]',
      '[role="tab"][aria-selected="false"]',
      'tab-after',
      '/eval active tab',
    );

    await measureHoverElement(
      browser,
      screen.getByRole('tab', '用例集', { exact: false }),
      '/eval inactive tab hover',
    );
    await screen.getByRole('tab', '用例集', { exact: false }).tap();
    await expect(screen.getByText(`contrast-llm-${suffix}`, { exact: true })).toBeVisible();
    await scanContrast(browser, '/eval', 'cases-tab');
    await checkPairDifferentiation(
      browser,
      '[data-slot="segmented-control"][aria-label="筛选用例类型"] [role="radio"][aria-checked="true"]',
      '[data-slot="segmented-control"][aria-label="筛选用例类型"] [role="radio"][aria-checked="false"]',
      'segmented',
      '/eval cases filter segmented control',
    );

    await screen.getByRole('tab', '用例集', { exact: false }).focus();
    await browser.keyboard.press('Tab');
    await measureActiveFocusRing(browser, '/eval tablist next control focus-visible');

    await app.open('/accounts');
    await expect(screen.getByRole('heading', '账户')).toBeVisible();
    await expect(screen.getByRole('button', '新建账户')).toBeVisible();
    await expect(browser.locator('table[aria-label="账户列表"]')).toBeVisible();
    await browser.mouse.move(0, 0);

    await scanContrast(browser, '/accounts', 'resting-table');
    await checkPairDifferentiation(
      browser,
      '[data-slot="segmented-control"] [role="radio"][aria-checked="true"]',
      '[data-slot="segmented-control"] [role="radio"][aria-checked="false"]',
      'segmented',
      '/accounts ViewToggle table',
    );

    await measureHoverElement(
      browser,
      screen.getByRole('button', '新建账户'),
      '/accounts primary button hover',
    );

    await screen.getByRole('radio', '表格').focus();
    await browser.keyboard.press('Tab');
    await measureActiveFocusRing(browser, '/accounts table row control focus-visible');

    const accountMenuBtn = browser.locator('button[aria-label^="操作 "]').first();
    await accountMenuBtn.tap();
    const accountMenu = browser.locator('[role="menu"]');
    await expect(accountMenu).toBeVisible();
    await browser.locator('[role="menu"] [role="menuitem"]').last().hover();
    await scanContrast(browser, '/accounts', 'row-menu-open', '[role="menu"]');
    await browser.keyboard.press('Escape');
    await accountMenu.waitFor({ state: 'hidden' });

    await screen.getByRole('radio', '卡片').tap();
    await expect(browser.locator('ul[aria-label="账户列表"]')).toBeVisible();
    await scanContrast(browser, '/accounts', 'cards-view');

    console.log(`CONTRAST_SUMMARY=${JSON.stringify(contrastSummary)}`);
  } catch (error) {
    failure = error;
  }
  const deleted = await browserFetch(browser, 'DELETE', `/api/agents/${agentId}`);
  if (deleted.status !== 204 && deleted.status !== 404) {
    const cleanupError = new Error(`清理临时专家失败 ${deleted.status}：${deleted.text}`);
    if (failure !== undefined) {
      throw new AggregateError([failure, cleanupError], '对比度用例与临时专家清理均失败');
    }
    throw cleanupError;
  }
  if (failure !== undefined) throw failure;
});
