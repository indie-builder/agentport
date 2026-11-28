import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dir, '..');
const MAX_ROOT_AGENTS_BYTES = 16 * 1024;
const MAX_PKG_AGENTS_BYTES = 12 * 1024;
const packageAgents = [...new Bun.Glob('packages/*/AGENTS.md').scanSync({ cwd: root })].sort();
const docSources = [
  'AGENTS.md',
  'README.md',
  ...[...new Bun.Glob('docs/*.md').scanSync({ cwd: root })].sort(),
  ...packageAgents,
];
const historical = /^docs\/(?:PITFALLS|CAPABILITY-GAP)\.md$/;
const sources = docSources.filter((source) => !historical.test(source));

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

const agentsLimits = [
  ['AGENTS.md', MAX_ROOT_AGENTS_BYTES],
  ...packageAgents.map((source) => [source, MAX_PKG_AGENTS_BYTES]),
];
const agentsChecked = agentsLimits.length;
const agentByteFailures = (
  await Promise.all(
    agentsLimits.map(async ([source, limit]) => {
      const bytes = Buffer.byteLength(await Bun.file(resolve(root, source)).text(), 'utf8');
      return bytes > limit
        ? `[docs-check] ${source}: ${bytes} bytes 超过上限 ${limit} bytes -> 请将详细参考/总表下沉到 docs/ 并保留上下文指针，避免规则注入被截断`
        : null;
    }),
  )
).filter((item) => item !== null);
failures.push(...agentByteFailures);

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
    const fail = (reason) => failures.push(`[docs-check] ${source}: ${href} -> ${reason}`);

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

const inlineCode = (line) => [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
const repoPath = /^(?:packages|scripts|tests)\/\S+$/;
const isGlob = /[*?[\]{}<>]/;
const explanatory = /已删除|旧版|删除重复/;
const sourceLineSuffix = /:\d+(?:-\d+)?$/;
const buildSegment = /^(?:dist|node_modules)$/;
const shellCommand = /^(?:pnpm|npm)\s+\S/;
const historicalLine = /复跑|历史/;
const fenceOpen = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const shellLanguages = new Set(['bash', 'sh', 'zsh', 'shell', 'console']);

let paths = 0;
let commands = 0;
const sectionTitles = [];
const indexRows = [];
let indexDone = false;

for (const source of docSources) {
  const lines = (await Bun.file(resolve(root, source)).text()).split(/\r?\n/);
  const isHistorical = historical.test(source);
  let fenceClose = null;
  let fenceLanguage = '';
  let sectionSeen = false;
  for (const [index, line] of lines.entries()) {
    if (indexRows.length && !indexDone && !line.startsWith('|')) indexDone = true;
    if (fenceClose) {
      if (fenceClose.test(line)) {
        fenceClose = null;
        fenceLanguage = '';
        continue;
      }
      if (isHistorical || !shellLanguages.has(fenceLanguage)) continue;
      const candidate = line.trimStart().replace(/^\$\s+/, '');
      if (!shellCommand.test(candidate)) continue;
      commands += 1;
      failures.push(`[docs-check] ${source}:${index + 1}: ${candidate} -> 禁止 pnpm/npm 运行命令`);
      continue;
    }
    const fenceMatch = line.match(fenceOpen);
    if (fenceMatch && (fenceMatch[2][0] !== '`' || !fenceMatch[3].includes('`'))) {
      const run = fenceMatch[2];
      fenceClose = new RegExp(`^ {0,3}${run[0]}{${run.length},}[ \\t]*$`);
      fenceLanguage = fenceMatch[3].trim().split(/\s+/)[0] ?? '';
      continue;
    }
    if (isHistorical) {
      if (source !== 'docs/PITFALLS.md') continue;
      if (line.startsWith('## ')) {
        sectionSeen = true;
        sectionTitles.push(line.slice(3).trim());
      } else if (!sectionSeen && !indexDone && line.startsWith('|')) {
        indexRows.push({ line, number: index + 1 });
      }
      continue;
    }
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const candidate = match[1];
      if (!repoPath.test(candidate) || isGlob.test(candidate)) continue;
      const context = line.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80);
      if (explanatory.test(context)) continue;
      const bare = candidate.replace(sourceLineSuffix, '');
      if (bare.split('/').some((segment) => buildSegment.test(segment))) continue;
      paths += 1;
      if (!existsSync(resolve(root, bare)))
        failures.push(`[docs-check] ${source}:${index + 1}: ${candidate} -> 行内路径不存在`);
    }
    if (historicalLine.test(line)) continue;
    for (const candidate of inlineCode(line)) {
      if (!shellCommand.test(candidate)) continue;
      commands += 1;
      failures.push(`[docs-check] ${source}:${index + 1}: ${candidate} -> 禁止 pnpm/npm 运行命令`);
    }
  }
}

const rowCells = (row) => {
  const cells = row.split(/(?<!\\)\|/);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells.at(-1).trim() === '') cells.pop();
  return cells.map((cell) => cell.trim());
};

const indexFormatError = (lineNumber) =>
  `[docs-check] docs/PITFALLS.md:${lineNumber}: 索引表格式不符合预期`;
const indexed = [];
let indexTableValid = false;
if (indexRows.length === 0) {
  failures.push('[docs-check] docs/PITFALLS.md: 缺少索引表');
} else if (indexRows.length < 2 || indexRows[1].number !== indexRows[0].number + 1) {
  failures.push(indexFormatError(indexRows[0].number));
} else {
  const header = rowCells(indexRows[0].line);
  const separator = rowCells(indexRows[1].line);
  const headerOk =
    header.length === 2 && header[0] === '症状或任务类别' && header[1] === '相关条目（`##` 节名）';
  const separatorOk = separator.length === 2 && separator.every((cell) => /^:?-{3,}:?$/.test(cell));
  const dataRows = indexRows.slice(2);
  const invalidRows = dataRows.filter(({ line }) => {
    const cells = rowCells(line);
    return cells.length !== 2 || cells[1] === '';
  });
  if (!headerOk || !separatorOk) {
    failures.push(indexFormatError(indexRows[0].number));
  } else if (invalidRows.length) {
    for (const { number } of invalidRows) failures.push(indexFormatError(number));
  } else {
    indexTableValid = true;
    for (const { line } of dataRows) {
      indexed.push(
        ...rowCells(line)[1]
          .split('；')
          .map((item) => item.trim().replace(/\\\|/g, '|'))
          .filter(Boolean),
      );
    }
  }
}
const tally = (items) => {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
};
const titleCounts = tally(sectionTitles);
const indexCounts = tally(indexed);
const missing = [...titleCounts].filter(([title, count]) => count > (indexCounts.get(title) ?? 0));
const extra = [...indexCounts].filter(([item, count]) => count > (titleCounts.get(item) ?? 0));
const duplicate = [...new Set([...titleCounts.keys(), ...indexCounts.keys()])].filter(
  (item) => (titleCounts.get(item) ?? 0) > 1 || (indexCounts.get(item) ?? 0) > 1,
);
if (indexTableValid) {
  for (const [title] of missing)
    failures.push(`[docs-check] docs/PITFALLS.md: 索引缺少 ## ${title}`);
  for (const [item] of extra) failures.push(`[docs-check] docs/PITFALLS.md: 索引多出 ${item}`);
  for (const item of duplicate) failures.push(`[docs-check] docs/PITFALLS.md: 重复条目 ${item}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(
    '提示：路径只检查行内单行片段中的 `packages|scripts|tests` 引用；命令检查覆盖行内命令与 bash/sh/zsh/shell/console 围栏内的命令；代码片段前后 80 字符内含「已删除」「旧版」或「删除重复」的说明性路径引用已豁免；行内含「复跑」或「历史」的行内命令记录已豁免；docs/PITFALLS.md 与 docs/CAPABILITY-GAP.md 不检查路径与命令。',
  );
  process.exit(1);
}

console.log(
  `docs navigation OK (${links} links, ${anchors} anchors in ${sources.length} files; ${agentsChecked} AGENTS byte caps; ${paths} inline paths, ${commands} npm/pnpm commands, ${sectionTitles.length} pitfall sections indexed)`,
);
