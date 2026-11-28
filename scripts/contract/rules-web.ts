import { existsSync } from 'node:fs';
import { join } from 'node:path';
import traverse from '@babel/traverse';
import { isInTypePosition } from './ast-utils.js';
import type { ContractContext, RuleModule } from './context.js';

const WEB_RULES = [
  'web-banned-primitive',
  'lucide-icon-size',
  'web-hardcoded-hex',
  'button-variants-concat',
  'web-localstorage',
  'web-no-dark-variant',
  'styles-dark-variant',
  'styles-dark-block',
  'styles-muted-token',
  'styles-radius-4xl',
  'styles-shadow',
  'collapsible-panel-visibility',
] as const;

const iconRe = /import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/;
const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
const buttonVariantsFix = '改用 cn(buttonVariants(...), ...)（见 packages/web/src/lib/cn.ts）';
const storageRe = /\bwindow\.localStorage\b|\blocalStorage\./g;
const webDarkVariantRe =
  /(?:^|[\s'"`])(?:(?:[a-z0-9_*\-@]+(?:\/[a-z0-9_-]+)?(?:\[[^\]]*\])?(?:\/[a-z0-9_-]+)?|\[[^\]]+\]):)*dark:[a-z0-9![(\-@*]/i;

function findButtonVariantsConcatViolations(ctx: ContractContext, code: string): number[] {
  const lines = new Set<number>();
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      i = ctx.skipQuoted(code, i, ch) - 1;
      continue;
    }
    if (ch === '`') {
      const tpl = ctx.scanTemplateLiteral(code, i);
      for (const expr of tpl.expressions) {
        if (/\bbuttonVariants\s*\(/.test(expr.expr)) {
          lines.add(ctx.lineAt(code, i));
        }
      }
      i = tpl.end - 1;
    }
  }
  for (const m of code.matchAll(/\+\s*buttonVariants\s*\(/g)) {
    if (m.index !== undefined) lines.add(ctx.lineAt(code, m.index));
  }
  for (const m of code.matchAll(/\bbuttonVariants\s*\(/g)) {
    if (m.index === undefined) continue;
    const afterParen = ctx.skipBalancedParens(code, m.index + m[0].length);
    if (/^\s*\+/.test(code.slice(afterParen))) {
      lines.add(ctx.lineAt(code, m.index));
    }
  }
  return [...lines].sort((a, b) => a - b);
}

function readCssToken(
  ctx: ContractContext,
  css: string,
  name: string,
): { value: string; line: number } | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*:\\s*([^;]+);`));
  if (!match || match[1] === undefined || match.index === undefined) return null;
  return { value: match[1].trim(), line: ctx.lineAt(css, match.index) };
}

function checkWebFiles(ctx: ContractContext): void {
  const checkPrimitive = ctx.hasRule('web-banned-primitive');
  const checkIcon = ctx.hasRule('lucide-icon-size');
  const checkHex = ctx.hasRule('web-hardcoded-hex');
  const checkButtonVariants = ctx.hasRule('button-variants-concat');
  const checkStorage = ctx.hasRule('web-localstorage');
  const checkDark = ctx.hasRule('web-no-dark-variant');

  if (
    !checkPrimitive &&
    !checkIcon &&
    !checkHex &&
    !checkButtonVariants &&
    !checkStorage &&
    !checkDark
  ) {
    return;
  }

  for (const file of ctx.webFiles) {
    const displayPath = ctx.rel(file);

    if (checkPrimitive) {
      for (const imp of ctx.getModuleImports(file)) {
        if (
          ctx.matchesPackage(imp.specifier, '@radix-ui') ||
          ctx.matchesPackage(imp.specifier, '@base-ui')
        ) {
          ctx.report(
            'web-banned-primitive',
            `${displayPath}:${imp.line}: 引入 ${imp.specifier}（改用 @ui-sdk/react 或 packages/web/src/components/ui/）`,
          );
        }
      }
    }

    if (checkIcon && !file.endsWith('App.tsx')) {
      const src = ctx.read(file);
      const m = src.match(iconRe);
      if (m?.[1]) {
        const names = m[1]
          .split(',')
          .map(
            (s) =>
              s
                .trim()
                .split(/\s+as\s+/)
                .pop() ?? '',
          )
          .filter(Boolean);
        for (const name of names) {
          const tag = new RegExp(`<${name}\\b[^>]*>`, 'g');
          for (const t of src.matchAll(tag)) {
            if (t.index !== undefined && /\b(strokeWidth|size)=/.test(t[0])) {
              ctx.report(
                'lucide-icon-size',
                `${displayPath}:${ctx.lineAt(src, t.index)}: lucide 图标 ${name} 逐个传 strokeWidth/size`,
              );
            }
          }
        }
      }
    }

    if (checkHex && !file.includes('/components/ui/')) {
      const src = ctx.read(file);
      for (const m of src.matchAll(hexRe)) {
        if (m.index !== undefined) {
          ctx.report(
            'web-hardcoded-hex',
            `${displayPath}:${ctx.lineAt(src, m.index)}: 硬编码色值 ${m[0]}（用 @theme token）`,
          );
        }
      }
    }

    if (checkButtonVariants) {
      const code = ctx.readStripped(file);
      for (const line of findButtonVariantsConcatViolations(ctx, code)) {
        ctx.report(
          'button-variants-concat',
          `${displayPath}:${line}: 拼接 buttonVariants 类名（${buttonVariantsFix}）`,
        );
      }
    }

    if (checkStorage && displayPath !== 'packages/web/src/lib/storage.ts') {
      const src = ctx.read(file);
      for (const m of src.matchAll(storageRe)) {
        if (m.index !== undefined) {
          ctx.report(
            'web-localstorage',
            `${displayPath}:${ctx.lineAt(src, m.index)}: 直接访问 localStorage（改用 packages/web/src/lib/storage.ts 的 readStorage / writeStorage）`,
          );
        }
      }
    }

    if (checkDark) {
      traverse(ctx.readModule(file).ast, {
        StringLiteral(path) {
          if (isInTypePosition(path)) return;
          if (webDarkVariantRe.test(path.node.value)) {
            ctx.report(
              'web-no-dark-variant',
              `${displayPath}:${path.node.loc?.start.line ?? 0}: 禁止使用 dark: 变体类（本项目仅亮色，删除无用 dark: 类）`,
            );
          }
        },
        TemplateElement(path) {
          if (isInTypePosition(path)) return;
          const text = path.node.value.cooked ?? path.node.value.raw;
          if (webDarkVariantRe.test(text)) {
            ctx.report(
              'web-no-dark-variant',
              `${displayPath}:${path.node.loc?.start.line ?? 0}: 禁止使用 dark: 变体类（本项目仅亮色，删除无用 dark: 类）`,
            );
          }
        },
      });
    }
  }
}

function checkStyles(ctx: ContractContext): void {
  const stylesPath = join(ctx.root, 'packages/web/src/styles.css');
  if (
    existsSync(stylesPath) &&
    ctx.hasAnyRule([
      'styles-dark-variant',
      'styles-dark-block',
      'styles-muted-token',
      'styles-radius-4xl',
      'styles-shadow',
    ])
  ) {
    const stylesCode = ctx.stripCssComments(ctx.read(stylesPath));

    if (!stylesCode.includes('@custom-variant dark (&:where(.dark, .dark *));')) {
      ctx.report(
        'styles-dark-variant',
        'packages/web/src/styles.css: 缺少 @custom-variant dark (&:where(.dark, .dark *));',
      );
    }
    for (const m of stylesCode.matchAll(/\.dark(?![\w-])[^;{}]*\{/g)) {
      if (m.index !== undefined) {
        ctx.report(
          'styles-dark-block',
          `packages/web/src/styles.css:${ctx.lineAt(stylesCode, m.index)}: 禁止定义 .dark 主题块`,
        );
      }
    }
    for (const m of stylesCode.matchAll(
      /--color-muted\s*:\s*var\(\s*--color-muted-foreground\s*\)\s*;/g,
    )) {
      if (m.index !== undefined) {
        ctx.report(
          'styles-muted-token',
          `packages/web/src/styles.css:${ctx.lineAt(stylesCode, m.index)}: --color-muted 不得等于 var(--color-muted-foreground)`,
        );
      }
    }
    const radius4xl = readCssToken(ctx, stylesCode, '--radius-4xl');
    if (radius4xl?.value !== 'var(--radius-tag)') {
      ctx.report(
        'styles-radius-4xl',
        `packages/web/src/styles.css:${radius4xl?.line ?? 1}: --radius-4xl 必须等于 var(--radius-tag)`,
      );
    }
    for (const shadowVar of ['--shadow-md', '--shadow-lg']) {
      const token = readCssToken(ctx, stylesCode, shadowVar);
      if (token?.value !== 'var(--shadow-overlay)') {
        ctx.report(
          'styles-shadow',
          `packages/web/src/styles.css:${token?.line ?? 1}: ${shadowVar} 必须等于 var(--shadow-overlay)`,
        );
      }
    }
  }

  if (ctx.hasRule('collapsible-panel-visibility')) {
    for (const file of ctx.walk(join(ctx.root, 'packages/web/src'), /\.css$/)) {
      const css = ctx.stripCssComments(ctx.read(file));
      for (const m of css.matchAll(/[^{};]*collapsible-panel[^{};]*\{/g)) {
        if (m.index === undefined) continue;
        const blockStart = m.index + m[0].length;
        const blockEnd = ctx.skipBalancedBraces(css, blockStart);
        const blockBody = css.slice(blockStart, blockEnd);
        if (/\bcontent-visibility\s*:/.test(blockBody)) {
          ctx.report(
            'collapsible-panel-visibility',
            `${ctx.rel(file)}:${ctx.lineAt(css, m.index)}: 禁止在 collapsible-panel 上设置 content-visibility`,
          );
        }
      }
    }
  }
}

export const webRulesModule: RuleModule = {
  rules: WEB_RULES,
  run(ctx) {
    checkWebFiles(ctx);
    checkStyles(ctx);
  },
};
