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

const webFiles = walk(join(ROOT, 'packages/web/src'), /\.(ts|tsx)$/);
const apiFiles = walk(join(ROOT, 'packages/api/src'), /\.(ts|tsx)$/);
const dbFiles = walk(join(ROOT, 'packages/db/src'), /\.ts$/);

for (const file of webFiles) {
  if (/from ['"]@radix-ui\//.test(read(file))) {
    problems.push(`${rel(file)}: 引入 @radix-ui（项目规定用 Base UI）`);
  }
}

for (const file of apiFiles) {
  const src = read(file);
  const re = /request\.(body|params|query|querystring)\.safeParse/g;
  for (const m of src.matchAll(re)) {
    const line = src.slice(0, m.index).split('\n').length;
    problems.push(`${rel(file)}:${line}: handler 内对 request 使用 safeParse`);
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
        const line = src.slice(0, t.index).split('\n').length;
        problems.push(`${rel(file)}:${line}: lucide 图标 ${name} 逐个传 strokeWidth/size`);
      }
    }
  }
}

const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
for (const file of webFiles) {
  if (file.includes('/components/ui/')) continue;
  const src = read(file);
  for (const m of src.matchAll(hexRe)) {
    const line = src.slice(0, m.index).split('\n').length;
    problems.push(`${rel(file)}:${line}: 硬编码色值 ${m[0]}（用 @theme token）`);
  }
}

function findSqlLikeViolations(src) {
  const lines = [];
  const startRe = /(?<![\w$.])sql\s*`/g;
  for (const m of src.matchAll(startRe)) {
    let i = m.index + m[0].length;
    let staticText = '';
    let exprText = '';
    let hasInterpolation = false;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') {
        staticText += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '`') break;
      if (ch === '$' && src[i + 1] === '{') {
        hasInterpolation = true;
        i += 2;
        let depth = 1;
        const exprStart = i;
        while (i < src.length && depth > 0) {
          const c = src[i];
          if (c === '\\') {
            i += 2;
            continue;
          }
          if (c === "'" || c === '"' || c === '`') {
            const quote = c;
            i += 1;
            while (i < src.length) {
              if (src[i] === '\\') {
                i += 2;
                continue;
              }
              if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
                i += 2;
                let inner = 1;
                while (i < src.length && inner > 0) {
                  if (src[i] === '\\') i += 2;
                  else if (src[i] === '{') {
                    inner += 1;
                    i += 1;
                  } else if (src[i] === '}') {
                    inner -= 1;
                    i += 1;
                  } else i += 1;
                }
                continue;
              }
              if (src[i] === quote) {
                i += 1;
                break;
              }
              i += 1;
            }
            continue;
          }
          if (c === '{') depth += 1;
          else if (c === '}') depth -= 1;
          i += 1;
        }
        exprText += ` ${src.slice(exprStart, i - 1)} `;
        staticText += ' ';
        continue;
      }
      staticText += ch;
      i += 1;
    }
    if (
      hasInterpolation &&
      /\b(?:i?like)\b/i.test(staticText) &&
      !/\b(?:containsPattern|prefixPattern|escapeLike)\b/.test(exprText)
    ) {
      lines.push(src.slice(0, m.index).split('\n').length);
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
    const line = src.slice(0, m.index).split('\n').length;
    problems.push(`${rel(file)}:${line}: 直接调用 ${m[0].replace(/\($/, '')}（${likeFix}）`);
  }
  for (const line of findSqlLikeViolations(src)) {
    problems.push(`${rel(file)}:${line}: sql 模板中未转义的 LIKE/ILIKE（${likeFix}）`);
  }
}

const storageRe = /\bwindow\.localStorage\b|\blocalStorage\./g;
for (const file of webFiles) {
  if (rel(file) === 'packages/web/src/lib/storage.ts') continue;
  const src = read(file);
  for (const m of src.matchAll(storageRe)) {
    const line = src.slice(0, m.index).split('\n').length;
    problems.push(
      `${rel(file)}:${line}: 直接访问 localStorage（改用 packages/web/src/lib/storage.ts 的 readStorage / writeStorage）`,
    );
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('project contract OK');
