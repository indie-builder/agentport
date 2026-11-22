import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const problems = [];

/** @param {string} dir @param {RegExp} ext */
function walk(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, ext));
    else if (ext.test(name)) out.push(full);
  }
  return out;
}

const rel = (p) => relative(ROOT, p);
const read = (p) => readFileSync(p, 'utf8');
const lineAt = (src, index) => src.slice(0, index).split('\n').length;

function skipBalancedBraces(src, i) {
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(src, i, c);
      continue;
    }
    if (c === '`') {
      i = scanTemplateLiteral(src, i).end;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  return i;
}

function skipQuoted(src, i, quote) {
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

function scanTemplateLiteral(src, start) {
  let i = start + 1;
  let staticText = '';
  let exprText = '';
  const expressions = [];
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      staticText += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '`') {
      return { end: i + 1, staticText, exprText, expressions };
    }
    if (ch === '$' && src[i + 1] === '{') {
      i += 2;
      const exprStart = i;
      i = skipBalancedBraces(src, i);
      const expr = src.slice(exprStart, i - 1);
      expressions.push({ expr, index: exprStart });
      exprText += ` ${expr} `;
      staticText += ' ';
      continue;
    }
    staticText += ch;
    i += 1;
  }
  return { end: i, staticText, exprText, expressions };
}

function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < src.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(src, i, ch);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '`') {
      const tpl = scanTemplateLiteral(src, i);
      out += src.slice(i, tpl.end);
      i = tpl.end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const moduleStmtRe =
  /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:(?:\*(?:\s+as\s+\w+)?|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?))?)\s+from\s+)?['"]([^'"]+)['"]/g;

function isTypeOnlyImportStatement(stmt, typeKeyword) {
  if (typeKeyword) return true;
  const fromMatch = stmt.match(/^\s*(?:import|export)\s+([\s\S]*?)\s+from\s+['"]/);
  if (!fromMatch) return false;
  const clause = fromMatch[1].trim();
  if (!clause.startsWith('{') || !clause.endsWith('}')) return false;
  const parts = clause
    .slice(1, -1)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((part) => /^type\s+/.test(part));
}

function extractModuleImports(code) {
  const imports = [];
  for (const m of code.matchAll(moduleStmtRe)) {
    imports.push({
      specifier: m[3],
      line: lineAt(code, m.index + (m[0].startsWith('\n') ? 1 : 0)),
      isTypeOnly: isTypeOnlyImportStatement(m[0], m[2]),
    });
  }
  return imports;
}

const matchesPackage = (spec, pkg) => spec === pkg || spec.startsWith(`${pkg}/`);

const webFiles = walk(join(ROOT, 'packages/web/src'), /\.(ts|tsx)$/);
const apiFiles = walk(join(ROOT, 'packages/api/src'), /\.(ts|tsx)$/);
const workerFiles = walk(join(ROOT, 'packages/worker/src'), /\.(ts|tsx)$/);
const sharedFiles = walk(join(ROOT, 'packages/shared/src'), /\.ts$/);
const contractFiles = walk(join(ROOT, 'packages/contract/src'), /\.ts$/);
const dbFiles = walk(join(ROOT, 'packages/db/src'), /\.ts$/);
const dbSchemaFiles = walk(join(ROOT, 'packages/db/src/schema'), /\.ts$/);

const allowedWebCoreImports = new Set([
  '@agentport/core/workspace',
  '@agentport/core/plugin-display',
  '@agentport/core/record',
]);
const forbiddenWebPackages = ['@agentport/db', '@agentport/api', '@agentport/worker'];

for (const file of webFiles) {
  const code = stripComments(read(file));
  for (const imp of extractModuleImports(code)) {
    if (matchesPackage(imp.specifier, '@radix-ui') || matchesPackage(imp.specifier, '@base-ui')) {
      problems.push(
        `${rel(file)}:${imp.line}: 引入 ${imp.specifier}（改用 @ui-sdk/react 或 packages/web/src/components/ui/）`,
      );
    }
    if (
      forbiddenWebPackages.some((pkg) => matchesPackage(imp.specifier, pkg)) ||
      (matchesPackage(imp.specifier, '@agentport/core') && !allowedWebCoreImports.has(imp.specifier))
    ) {
      problems.push(
        `${rel(file)}:${imp.line}: web 禁止引入 ${imp.specifier}（只允许 @agentport/core/workspace、@agentport/core/plugin-display、@agentport/core/record、@agentport/shared 与 @agentport/contract）`,
      );
    }
  }
}

for (const file of sharedFiles) {
  const code = stripComments(read(file));
  for (const imp of extractModuleImports(code)) {
    if (
      imp.specifier.startsWith('node:') ||
      matchesPackage(imp.specifier, 'react') ||
      matchesPackage(imp.specifier, 'react-dom') ||
      imp.specifier.startsWith('@agentport/')
    ) {
      problems.push(
        `${rel(file)}:${imp.line}: shared 禁止引入 ${imp.specifier}（packages/shared 只允许依赖 zod 与包内相对路径）`,
      );
    }
  }
}

const forbiddenContractPackages = [
  '@agentport/db',
  '@agentport/api',
  '@agentport/worker',
  '@agentport/core',
];
for (const file of contractFiles) {
  const code = stripComments(read(file));
  for (const imp of extractModuleImports(code)) {
    if (forbiddenContractPackages.some((pkg) => matchesPackage(imp.specifier, pkg))) {
      problems.push(
        `${rel(file)}:${imp.line}: contract 禁止引入 ${imp.specifier}（packages/contract 只允许依赖 @agentport/shared、zod 与 @orpc/contract）`,
      );
    }
  }
}

const forbiddenDbPackages = ['@agentport/api', '@agentport/worker', 'hono', 'bullmq', 'pg'];
for (const file of dbFiles) {
  const code = stripComments(read(file));
  for (const imp of extractModuleImports(code)) {
    if (forbiddenDbPackages.some((pkg) => matchesPackage(imp.specifier, pkg))) {
      problems.push(
        `${rel(file)}:${imp.line}: db 禁止引入 ${imp.specifier}（db 模块边界只使用 drizzle-orm/bun-sql，不引入路由、队列或 pg）`,
      );
    }
  }
}

const routerRe = /^packages\/api\/src\/modules\/[^/]+\/router\.ts$/;
const routerSafeParseRe = /\binput\.(params|query|body)\.safeParse\b/g;
for (const file of apiFiles) {
  if (!routerRe.test(rel(file))) continue;
  const code = stripComments(read(file));
  for (const m of code.matchAll(routerSafeParseRe)) {
    problems.push(
      `${rel(file)}:${lineAt(code, m.index)}: router 内对 input.${m[1]} 使用 safeParse（校验只在 @agentport/contract 的 input schema 完成，不在 router.ts 重复 safeParse）`,
    );
  }
}

const dynamicPinoRe = /\b(?:import|require)\s*\(\s*['"]pino(?:\/[^'"]*)?['"]\s*\)/g;
for (const file of [...apiFiles, ...workerFiles]) {
  const code = stripComments(read(file));
  for (const imp of extractModuleImports(code)) {
    if (matchesPackage(imp.specifier, 'pino') && !imp.isTypeOnly) {
      problems.push(
        `${rel(file)}:${imp.line}: 直接引入 pino 值（改用 @agentport/core/logger 的 createServiceLogger / requestScopedLogger / runScopedLogger）`,
      );
    }
  }
  for (const m of code.matchAll(dynamicPinoRe)) {
    problems.push(
      `${rel(file)}:${lineAt(code, m.index)}: 动态引入 pino（改用 @agentport/core/logger 的 createServiceLogger / requestScopedLogger / runScopedLogger）`,
    );
  }
}

const iconRe = /import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/;
for (const file of webFiles) {
  if (file.endsWith('App.tsx')) continue;
  const src = read(file);
  const m = src.match(iconRe);
  if (!m) continue;
  const names = m[1]
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/).pop())
    .filter(Boolean);
  for (const name of names) {
    const tag = new RegExp(`<${name}\\b[^>]*>`, 'g');
    for (const t of src.matchAll(tag)) {
      if (/\b(strokeWidth|size)=/.test(t[0])) {
        problems.push(`${rel(file)}:${lineAt(src, t.index)}: lucide 图标 ${name} 逐个传 strokeWidth/size`);
      }
    }
  }
}

const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
for (const file of webFiles) {
  if (file.includes('/components/ui/')) continue;
  const src = read(file);
  for (const m of src.matchAll(hexRe)) {
    problems.push(`${rel(file)}:${lineAt(src, m.index)}: 硬编码色值 ${m[0]}（用 @theme token）`);
  }
}

function skipBalancedParens(src, i) {
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(src, i, c);
      continue;
    }
    if (c === '`') {
      i = scanTemplateLiteral(src, i).end;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    i += 1;
  }
  return i;
}

const buttonVariantsFix = '改用 cn(buttonVariants(...), ...)（见 packages/web/src/lib/cn.ts）';
function findButtonVariantsConcatViolations(code) {
  const lines = new Set();
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(code, i, ch) - 1;
      continue;
    }
    if (ch === '`') {
      const tpl = scanTemplateLiteral(code, i);
      for (const expr of tpl.expressions) {
        if (/\bbuttonVariants\s*\(/.test(expr.expr)) {
          lines.add(lineAt(code, i));
        }
      }
      i = tpl.end - 1;
    }
  }
  for (const m of code.matchAll(/\+\s*buttonVariants\s*\(/g)) {
    lines.add(lineAt(code, m.index));
  }
  for (const m of code.matchAll(/\bbuttonVariants\s*\(/g)) {
    const afterParen = skipBalancedParens(code, m.index + m[0].length);
    if (/^\s*\+/.test(code.slice(afterParen))) {
      lines.add(lineAt(code, m.index));
    }
  }
  return [...lines].sort((a, b) => a - b);
}

for (const file of webFiles) {
  const code = stripComments(read(file));
  for (const line of findButtonVariantsConcatViolations(code)) {
    problems.push(`${rel(file)}:${line}: 拼接 buttonVariants 类名（${buttonVariantsFix}）`);
  }
}

function findSqlLikeViolations(src) {
  const lines = [];
  const startRe = /(?<![\w$.])sql\s*`/g;
  for (const m of src.matchAll(startRe)) {
    const tpl = scanTemplateLiteral(src, m.index + m[0].length - 1);
    if (
      tpl.expressions.length > 0 &&
      /\b(?:i?like)\b/i.test(tpl.staticText) &&
      !/\b(?:containsPattern|prefixPattern|escapeLike)\b/.test(tpl.exprText)
    ) {
      lines.push(lineAt(src, m.index));
    }
  }
  return lines;
}

const likeFix = '改用 packages/db/src/repo/like.ts 的 ilikeContains / likePrefix / containsPattern';
const likeCallRe = /\b(?:i?like)\s*\(/g;
for (const file of dbFiles) {
  if (rel(file) === 'packages/db/src/repo/like.ts') continue;
  const src = read(file);
  for (const m of src.matchAll(likeCallRe)) {
    problems.push(
      `${rel(file)}:${lineAt(src, m.index)}: 直接调用 ${m[0].replace(/\($/, '')}（${likeFix}）`,
    );
  }
  for (const line of findSqlLikeViolations(src)) {
    problems.push(`${rel(file)}:${line}: sql 模板中未转义的 LIKE/ILIKE（${likeFix}）`);
  }
}

const DB_ENUM_CHECK_ALLOWLIST = new Set([
  'packages/db/src/schema/chat.ts:channel_wakes_status_check',
  'packages/db/src/schema/governance.ts:budget_limits_scope_metric_check',
  'packages/db/src/schema/integrations.ts:webhook_deliveries_status_check',
  'packages/db/src/schema/knowledge-bases.ts:knowledge_model_profiles_dimensions_check',
  'packages/db/src/schema/knowledge-documents.ts:knowledge_document_tags_origin_check',
]);

for (const file of dbSchemaFiles) {
  const code = stripComments(read(file));
  for (const m of code.matchAll(/\bcheck\s*\(\s*(['"])([^'"]+)\1\s*,/g)) {
    const checkName = m[2];
    const callEnd = skipBalancedParens(code, m.index + m[0].indexOf('(') + 1);
    const callBody = code.slice(m.index, callEnd);
    const sqlMatch = callBody.match(/(?<![\w$.])sql\s*`/);
    if (!sqlMatch) continue;
    const tpl = scanTemplateLiteral(callBody, sqlMatch.index + sqlMatch[0].length - 1);
    if (!/\bin\s*\(/i.test(tpl.staticText)) continue;
    const hasHardcodedInList = /\bin\s*\(\s*'/i.test(tpl.staticText);
    const derivesFromOptions = /\.options\b/.test(tpl.exprText);
    if (hasHardcodedInList || !derivesFromOptions) {
      const key = `${rel(file)}:${checkName}`;
      if (!DB_ENUM_CHECK_ALLOWLIST.has(key)) {
        problems.push(
          `${rel(file)}:${lineAt(code, m.index)}: DB check '${checkName}' 未从 @agentport/shared 的 *.options 派生（改用 ${'${schema}.options'} 派生枚举，或确认属 DB 内部约束后加入 DB_ENUM_CHECK_ALLOWLIST）`,
        );
      }
    }
  }
}

const storageRe = /\bwindow\.localStorage\b|\blocalStorage\./g;
for (const file of webFiles) {
  if (rel(file) === 'packages/web/src/lib/storage.ts') continue;
  const src = read(file);
  for (const m of src.matchAll(storageRe)) {
    problems.push(
      `${rel(file)}:${lineAt(src, m.index)}: 直接访问 localStorage（改用 packages/web/src/lib/storage.ts 的 readStorage / writeStorage）`,
    );
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('project contract OK');
