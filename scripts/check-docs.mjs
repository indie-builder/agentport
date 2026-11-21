import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dir, '..');
const glob = new Bun.Glob('packages/*/AGENTS.md');
const sources = [
  'AGENTS.md',
  'docs/README.md',
  'docs/ARCHITECTURE.md',
  ...[...glob.scanSync({ cwd: root })].sort(),
];

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[`*]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

const decode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const anchorCache = new Map();
const anchorsOf = async (file) => {
  if (!anchorCache.has(file)) {
    const text = await Bun.file(file).text();
    const anchors = [];
    const seen = new Map();
    Bun.markdown.render(text, {
      heading: (content) => {
        const base = slug(content);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        anchors.push(count === 0 ? base : `${base}-${count}`);
        return content;
      },
    });
    for (const match of text.matchAll(/\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      anchors.push(match[1] ?? match[2]);
    anchorCache.set(file, anchors);
  }
  return anchorCache.get(file);
};

const isExternal = (href) => /^[a-z][a-z\d+.-]*:/i.test(href);
const inside = (path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const failures = [];
let links = 0;
let anchors = 0;

for (const source of sources) {
  const file = resolve(root, source);
  const found = [];
  Bun.markdown.render(await Bun.file(file).text(), {
    link: (children, { href }) => {
      found.push(href);
      return children;
    },
  });

  for (const href of found) {
    if (!href || href === '#' || href.startsWith('//') || isExternal(href)) continue;

    const hash = href.indexOf('#');
    const beforeHash = hash === -1 ? href : href.slice(0, hash);
    const query = beforeHash.indexOf('?');
    const pathPart = decode(query === -1 ? beforeHash : beforeHash.slice(0, query));
    const fragment = decode(hash === -1 ? '' : href.slice(hash + 1));
    const fail = (reason) => failures.push(`${source}: ${href} -> ${reason}`);

    if (isAbsolute(pathPart)) {
      links += 1;
      fail('绝对路径');
      continue;
    }
    links += 1;

    if (pathPart === '') {
      if (fragment) {
        anchors += 1;
        if (!(await anchorsOf(file)).includes(fragment)) fail(`锚点不存在 #${fragment}`);
      }
      continue;
    }

    const target = resolve(dirname(file), pathPart);
    if (!inside(target) || (existsSync(target) && !inside(realpathSync(target)))) {
      fail('超出仓库范围');
      continue;
    }
    if (!existsSync(target)) {
      fail(`目标不存在 ${relative(root, target) || '.'}`);
      continue;
    }

    if (fragment) {
      anchors += 1;
      if (!statSync(target).isFile() || !(await anchorsOf(target)).includes(fragment))
        fail(`锚点不存在 #${fragment}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`docs navigation OK (${links} links, ${anchors} anchors in ${sources.length} files)`);
