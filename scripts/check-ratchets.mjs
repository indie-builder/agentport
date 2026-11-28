import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const EXCLUDED_DIRS = [
  'packages/db/migrations/',
  'packages/core/src/generated/',
  'scripts/baselines/',
];
const EXCLUDED_FILES = [
  'packages/web/src/routeTree.gen.ts',
  'packages/web/src/lib/cn-tables.ts',
  'scripts/check-ratchets.mjs',
  'scripts/check-ratchets.test.ts',
];
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];
const WALK_IGNORE = new Set(['node_modules', '.git', 'dist', '.claude', '.agents']);
const PROD_SRC_RE = /^packages\/[^/]+\/src\//;
const DOUBLE_CAST_RE = /\bas\s+unknown\s+as\b/g;

const REGEX_PRE_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'default',
  'else',
  'do',
  'typeof',
  'void',
  'delete',
  'in',
  'instanceof',
  'of',
  'await',
  'yield',
  'new',
  'export',
  'as',
]);

function parseArgs(argv) {
  let root = process.cwd();
  let baselineRel = 'scripts/baselines/suppressions.json';
  let tighten = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tighten') {
      tighten = true;
    } else if (arg === '--root') {
      const val = argv[++i];
      if (!val) throw new Error('--root requires a directory path');
      root = resolve(val);
    } else if (arg.startsWith('--root=')) {
      root = resolve(arg.slice('--root='.length));
    } else if (arg === '--baseline') {
      const val = argv[++i];
      if (!val) throw new Error('--baseline requires a file path');
      baselineRel = val;
    } else if (arg.startsWith('--baseline=')) {
      baselineRel = arg.slice('--baseline='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    root,
    baselinePath: resolve(root, baselineRel),
    tighten,
  };
}

function walkFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (WALK_IGNORE.has(name)) continue;
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) {
      out.push(...walkFiles(full, rel));
    } else if (EXTENSIONS.some((ext) => name.endsWith(ext))) {
      out.push(rel);
    }
  }
  return out;
}

function listFiles(root) {
  let rawFiles;
  if (existsSync(join(root, '.git'))) {
    const listedRun = Bun.spawnSync(
      [
        'git',
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        '*.ts',
        '*.tsx',
        '*.js',
        '*.mjs',
      ],
      { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    );
    if (!listedRun.success) {
      const reason = listedRun.signalCode
        ? `signal ${listedRun.signalCode}`
        : `exit ${listedRun.exitCode}`;
      console.error(listedRun.stderr?.toString('utf8').trim() || `git ls-files failed (${reason})`);
      process.exit(listedRun.exitCode || 1);
    }
    rawFiles = listedRun.stdout.toString('utf8').split('\0').filter(Boolean);
  } else {
    rawFiles = walkFiles(root);
  }
  return rawFiles
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => !EXCLUDED_DIRS.some((dir) => file.startsWith(dir)))
    .filter((file) => !EXCLUDED_FILES.includes(file))
    .filter((file) => existsSync(join(root, file)))
    .sort();
}

function trySkipRegex(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n' || ch === '\r') return -1;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === ']' && inClass) {
      inClass = false;
      i += 1;
      continue;
    }
    if (ch === '/' && !inClass) {
      i += 1;
      while (i < src.length && /[a-zA-Z]/.test(src[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return -1;
}

function scanSource(src) {
  const comments = [];
  let codeOut = '';
  let line = 1;
  let i = 0;
  let canStartRegex = true;
  const braceStack = [];

  const blankSpan = (start, end) => {
    let out = '';
    for (let k = start; k < end; k += 1) {
      if (src[k] === '\n') {
        line += 1;
        out += '\n';
      } else {
        out += ' ';
      }
    }
    return out;
  };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '\n') {
      line += 1;
      codeOut += '\n';
      i += 1;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      codeOut += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      if (i >= 2 && src[i - 1] === ':' && /[a-zA-Z]/.test(src[i - 2])) {
        codeOut += '//';
        i += 2;
        canStartRegex = true;
        continue;
      }
      const startLine = line;
      const bodyStart = i + 2;
      let end = bodyStart;
      while (end < src.length && src[end] !== '\n') end += 1;
      comments.push({ text: src.slice(bodyStart, end), startLine });
      codeOut += ' '.repeat(end - i);
      i = end;
      continue;
    }

    if (ch === '/' && next === '*') {
      const startLine = line;
      const bodyStart = i + 2;
      let end = bodyStart;
      while (end < src.length && !(src[end] === '*' && src[end + 1] === '/')) {
        end += 1;
      }
      const text = src.slice(bodyStart, end);
      comments.push({ text, startLine });
      const closeEnd = end < src.length ? end + 2 : end;
      codeOut += blankSpan(i, closeEnd);
      i = closeEnd;
      continue;
    }

    if (ch === "'" && i > 0 && /[a-zA-Z0-9]/.test(src[i - 1])) {
      codeOut += ch;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let end = i + 1;
      let closed = false;
      while (end < src.length) {
        if (src[end] === '\\') {
          end += 2;
          continue;
        }
        if (src[end] === quote) {
          end += 1;
          closed = true;
          break;
        }
        if (src[end] === '\n') break;
        end += 1;
      }
      codeOut += closed ? quote + blankSpan(i + 1, end - 1) + quote : quote + blankSpan(i + 1, end);
      i = end;
      canStartRegex = false;
      continue;
    }

    if (ch === '`') {
      codeOut += '`';
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          const sliceEnd = Math.min(i + 2, src.length);
          codeOut += blankSpan(i, sliceEnd);
          i = sliceEnd;
          continue;
        }
        if (src[i] === '`') {
          codeOut += '`';
          i += 1;
          canStartRegex = false;
          break;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          codeOut += '${';
          i += 2;
          braceStack.push({ type: 'template', depth: 1 });
          canStartRegex = true;
          break;
        }
        if (src[i] === '\n') {
          line += 1;
          codeOut += '\n';
        } else {
          codeOut += ' ';
        }
        i += 1;
      }
      continue;
    }

    if (ch === '{') {
      if (braceStack.length > 0) {
        braceStack[braceStack.length - 1].depth += 1;
      }
      codeOut += '{';
      i += 1;
      canStartRegex = true;
      continue;
    }

    if (ch === '}') {
      const top = braceStack[braceStack.length - 1];
      if (top) {
        top.depth -= 1;
        if (top.depth === 0) {
          braceStack.pop();
          codeOut += '}';
          i += 1;
          while (i < src.length) {
            if (src[i] === '\\') {
              const sliceEnd = Math.min(i + 2, src.length);
              codeOut += blankSpan(i, sliceEnd);
              i = sliceEnd;
              continue;
            }
            if (src[i] === '`') {
              codeOut += '`';
              i += 1;
              canStartRegex = false;
              break;
            }
            if (src[i] === '$' && src[i + 1] === '{') {
              codeOut += '${';
              i += 2;
              braceStack.push({ type: 'template', depth: 1 });
              canStartRegex = true;
              break;
            }
            if (src[i] === '\n') {
              line += 1;
              codeOut += '\n';
            } else {
              codeOut += ' ';
            }
            i += 1;
          }
          continue;
        }
      }
      codeOut += '}';
      i += 1;
      canStartRegex = true;
      continue;
    }

    if (ch === '/' && canStartRegex) {
      const regexEnd = trySkipRegex(src, i);
      if (regexEnd !== -1) {
        codeOut += `/${' '.repeat(Math.max(0, regexEnd - i - 2))}/`;
        i = regexEnd;
        canStartRegex = false;
        continue;
      }
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      let end = i + 1;
      while (end < src.length && /[a-zA-Z0-9_$]/.test(src[end])) end += 1;
      const ident = src.slice(i, end);
      codeOut += ident;
      i = end;
      canStartRegex = REGEX_PRE_KEYWORDS.has(ident);
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < src.length && /[0-9a-zA-Z._]/.test(src[end])) end += 1;
      codeOut += src.slice(i, end);
      i = end;
      canStartRegex = false;
      continue;
    }

    if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
      codeOut += ch + next;
      i += 2;
      canStartRegex = false;
      continue;
    }

    codeOut += ch;
    i += 1;
    canStartRegex = ch !== ')' && ch !== ']';
  }

  return { comments, codeOut };
}

function lineAt(src, index) {
  let count = 1;
  for (let i = 0; i < index; i += 1) {
    if (src[i] === '\n') count += 1;
  }
  return count;
}

function inspectComments(file, comments) {
  const problems = [];
  const suppressionLines = [];

  for (const comment of comments) {
    const lines = comment.text.split('\n');
    for (let offset = 0; offset < lines.length; offset += 1) {
      const lineText = lines[offset];
      const lineNumber = comment.startLine + offset;

      const forbiddenMatch = lineText.match(
        /(@ts-ignore\b|@ts-nocheck\b|\beslint-disable(?:-(?:next-)?line)?\b)/,
      );
      if (forbiddenMatch) {
        problems.push(
          `[suppression-forbidden] ${file}:${lineNumber}: 禁止使用 ${forbiddenMatch[1]}，请修复根因或使用带说明的 @ts-expect-error / biome-ignore`,
        );
      }

      const biomeMatch = lineText.match(/\b(biome-ignore(?:-all)?)\b(.*)$/);
      if (biomeMatch) {
        suppressionLines.push(lineNumber);
        if (!/:\s*\S/.test(biomeMatch[2])) {
          problems.push(
            `[suppression-reason] ${file}:${lineNumber}: ${biomeMatch[1]} 必须附带具体原因说明`,
          );
        }
      }

      const oxlintMatch = lineText.match(/\b(oxlint-disable(?:-next-line|-line)?)\b(.*)$/);
      if (oxlintMatch) {
        suppressionLines.push(lineNumber);
        if (!/(?:--|:)\s*\S/.test(oxlintMatch[2])) {
          problems.push(
            `[suppression-reason] ${file}:${lineNumber}: ${oxlintMatch[1]} 必须附带具体原因说明`,
          );
        }
      }

      const tsExpectMatch = lineText.match(/(@ts-expect-error)\b(.*)$/);
      if (tsExpectMatch) {
        suppressionLines.push(lineNumber);
        const reason = tsExpectMatch[2].replace(/^[\s:-]+/, '').replace(/\s+/g, '');
        if (reason.length < 4) {
          problems.push(
            `[suppression-reason] ${file}:${lineNumber}: @ts-expect-error 必须附带具体原因说明`,
          );
        }
      }
    }
  }

  return { problems, suppressionLines };
}

function sortRecord(record) {
  const sorted = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }
  return sorted;
}

const { root, baselinePath, tighten } = parseArgs(process.argv.slice(2));
const baselineExists = existsSync(baselinePath);
const baselineRaw = baselineExists
  ? JSON.parse(await Bun.file(baselinePath).text())
  : { suppressions: {}, doubleCasts: {} };
if (!baselineRaw || typeof baselineRaw !== 'object' || Array.isArray(baselineRaw)) {
  console.error(`[ratchets] invalid baseline format: ${baselinePath}`);
  process.exit(1);
}
const baselineSuppressions =
  baselineRaw.suppressions && typeof baselineRaw.suppressions === 'object'
    ? baselineRaw.suppressions
    : {};
const baselineDoubleCasts =
  baselineRaw.doubleCasts && typeof baselineRaw.doubleCasts === 'object'
    ? baselineRaw.doubleCasts
    : {};

const nextSuppressions = { ...baselineSuppressions };
const nextDoubleCasts = { ...baselineDoubleCasts };
let tightened = false;

const files = listFiles(root);
const checkedSet = new Set(files);
const problems = [];
const suppressionByFile = new Map();
const doubleCastByFile = new Map();
const improvedSuppressions = [];
const improvedDoubleCasts = [];

for (const file of files) {
  const src = await Bun.file(join(root, file)).text();
  const { comments, codeOut } = scanSource(src);
  const inspected = inspectComments(file, comments);
  problems.push(...inspected.problems);
  if (inspected.suppressionLines.length > 0) {
    suppressionByFile.set(file, inspected.suppressionLines);
  }

  if (PROD_SRC_RE.test(file)) {
    const castLines = [];
    for (const match of codeOut.matchAll(DOUBLE_CAST_RE)) {
      if (match.index !== undefined) {
        castLines.push(lineAt(codeOut, match.index));
      }
    }
    if (castLines.length > 0) {
      doubleCastByFile.set(file, castLines);
    }
  }
}

for (const [file, lines] of suppressionByFile) {
  const allowed = baselineSuppressions[file] ?? 0;
  if (lines.length > allowed) {
    problems.push(
      `[suppression-ratchet] ${file}: 发现 ${lines.length} 处抑制注释，超过基线允许的 ${allowed} 处（行号: ${lines.join(', ')}），请修复根因而非新增抑制`,
    );
  } else if (lines.length < allowed) {
    if (tighten) {
      nextSuppressions[file] = lines.length;
      tightened = true;
    } else {
      improvedSuppressions.push(file);
    }
  }
}

for (const file of Object.keys(baselineSuppressions)) {
  const current = suppressionByFile.get(file)?.length ?? 0;
  if (!checkedSet.has(file) || current === 0) {
    if (tighten) {
      delete nextSuppressions[file];
      tightened = true;
    } else {
      const reason = !checkedSet.has(file) ? '基线中的文件已不存在' : '抑制注释已归零';
      problems.push(
        `[suppression-ratchet] ${file}: ${reason}，请运行 bun run ratchet:tighten 清理僵尸条目`,
      );
    }
  }
}

for (const [file, lines] of doubleCastByFile) {
  const allowed = baselineDoubleCasts[file] ?? 0;
  if (lines.length > allowed) {
    problems.push(
      `[double-cast-ratchet] ${file}: 发现 ${lines.length} 处 as unknown as，超过基线允许的 ${allowed} 处（行号: ${lines.join(', ')}），请改用类型收窄或 schema 校验`,
    );
  } else if (lines.length < allowed) {
    if (tighten) {
      nextDoubleCasts[file] = lines.length;
      tightened = true;
    } else {
      improvedDoubleCasts.push(file);
    }
  }
}

for (const file of Object.keys(baselineDoubleCasts)) {
  const current = doubleCastByFile.get(file)?.length ?? 0;
  if (!checkedSet.has(file) || !PROD_SRC_RE.test(file) || current === 0) {
    if (tighten) {
      delete nextDoubleCasts[file];
      tightened = true;
    } else {
      const reason = !checkedSet.has(file) ? '基线中的文件已不存在' : 'as unknown as 已归零';
      problems.push(
        `[double-cast-ratchet] ${file}: ${reason}，请运行 bun run ratchet:tighten 清理僵尸条目`,
      );
    }
  }
}

if (
  tighten &&
  tightened &&
  (baselineExists ||
    Object.keys(nextSuppressions).length > 0 ||
    Object.keys(nextDoubleCasts).length > 0)
) {
  const next = {
    suppressions: sortRecord(nextSuppressions),
    doubleCasts: sortRecord(nextDoubleCasts),
  };
  await Bun.write(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

console.log(
  tighten
    ? `ratchets tighten OK (${files.length} files checked${tightened ? ', baseline updated' : ''})`
    : `ratchets OK (${files.length} files checked)`,
);
if (!tighten && (improvedSuppressions.length > 0 || improvedDoubleCasts.length > 0)) {
  console.log(
    `tip: ${improvedSuppressions.length} 个文件抑制注释与 ${improvedDoubleCasts.length} 个文件双断言已下降，可运行 bun run ratchet:tighten 锁定收益`,
  );
}
