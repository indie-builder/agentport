import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// 项目契约的按需检查（不接 CI、不装钩子）：只放零误报的机械规则。
// 判断类规则交给 Opus review，不在这里。

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

// A. Radix 已整体移除，不得重新引入。
for (const file of webFiles) {
  if (/from ['"]@radix-ui\//.test(read(file))) {
    problems.push(`${rel(file)}: 引入 @radix-ui（项目规定用 Base UI）`);
  }
}

// B. Fastify handler 不得对 request 自行 safeParse（校验应在 schema 里）。
for (const file of apiFiles) {
  const src = read(file);
  const re = /request\.(body|params|query|querystring)\.safeParse/g;
  for (const m of src.matchAll(re)) {
    const line = src.slice(0, m.index).split('\n').length;
    problems.push(`${rel(file)}:${line}: handler 内对 request 使用 safeParse`);
  }
}

// C. lucide 图标由 App.tsx 的 LucideProvider 统一设 strokeWidth/size，组件里不得逐个传。
//    只匹配从 lucide-react 导入的组件名，避免误伤 recharts 的 <Area strokeWidth>。
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

// D. 禁止硬编码十六进制色值；styles.css 的令牌与 vendored shadcn 原语（components/ui）除外。
const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
for (const file of webFiles) {
  if (file.includes('/components/ui/')) continue;
  const src = read(file);
  for (const m of src.matchAll(hexRe)) {
    const line = src.slice(0, m.index).split('\n').length;
    problems.push(`${rel(file)}:${line}: 硬编码色值 ${m[0]}（用 @theme token）`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('project contract OK');
