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

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('project contract OK');
