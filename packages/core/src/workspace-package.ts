import { strToU8, Unzip, UnzipInflate, zipSync } from 'fflate';
import { parseAgentMd, stringList } from './agent-md.js';
import { AppError, fail } from './errors.js';
import { parseMarkdownFrontmatter } from './markdown-frontmatter.js';
import { parseSkillMd } from './skill-md.js';
import { splitGlobs, type WorkspaceFiles } from './workspace.js';

export const ARCHIVE_LIMITS = {
  archiveBytes: 1_048_576,
  unpackedBytes: 8_388_608,
  fileBytes: 1_048_576,
  entries: 1000,
} as const;

export interface ArchiveAgentMeta {
  name: string;
  systemPrompt: string;
}

export interface ParsedArchiveChild {
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  permissionMode: string;
  maxTurns: number;
  effort?: string;
  allowedTools: string[];
  disallowedTools: string[];
  skills: string[];
}

export interface ParsedArchive {
  agent: ArchiveAgentMeta;
  subAgents: ParsedArchiveChild[];
  skills: Array<{
    slug: string;
    name: string;
    description: string;
    body: string;
    license?: string;
    compatibility?: string;
    metadata?: Record<string, unknown>;
    files: Array<{ path: string; content: string }>;
  }>;
  rules: Array<{ slug: string; content: string; globs: string }>;
  outputStyles: Array<{
    slug: string;
    description: string;
    keepCodingInstructions: boolean;
    body: string;
    isSelected: boolean;
  }>;
  mcp: Record<string, unknown>;
  settings: Record<string, unknown>;
  warnings: string[];
}

/** 平台运行时能接受的权限模式；auto/bypassPermissions 会削弱平台约束，不作为默认值。 */
const FALLBACK_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk']);

function invalid(message: string, path?: string): never {
  fail('INVALID_INPUT', message, path === undefined ? undefined : { path });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** zip 条目名也是相对路径：拒绝绝对路径、穿越、反斜杠与空段。 */
function assertRelativePath(path: string, label: string): void {
  if (
    path === '' ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /^[A-Za-z]:/.test(path) ||
    hasControlCharacter(path)
  ) {
    invalid(`${label}不是合法的相对路径：${path}`);
  }
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    invalid(`${label}不能包含空段、. 或 ..：${path}`);
  }
}

/** slug 会直接拼进目录或文件名，必须是一个路径段。 */
function assertSlug(slug: string, label: string): void {
  if (
    slug === '' ||
    slug === '.' ||
    slug === '..' ||
    slug.includes('/') ||
    slug.includes('\\') ||
    hasControlCharacter(slug)
  ) {
    invalid(`${label}不能用作文件或目录名：${slug}`);
  }
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const body = text.replace(/^﻿/, '');
  if (body.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    invalid(`${label} 不是合法的 JSON`);
  }
  if (!isRecord(value)) invalid(`${label} 的顶层必须是对象`);
  return value;
}

export function buildWorkspaceArchive(input: {
  files: WorkspaceFiles;
  agent: ArchiveAgentMeta;
}): Uint8Array {
  const { files, agent } = input;
  const entries: Record<string, Uint8Array> = {};
  const seen = new Set<string>();

  function add(path: string, content: string): void {
    assertRelativePath(path, '归档路径');
    const key = path.toLowerCase();
    if (seen.has(key)) invalid(`归档内路径重复：${path}`);
    seen.add(key);
    entries[path] = strToU8(content);
  }

  // 根智能体只带自己的提示词；运行时追加的「工具使用」「等待规则」不进入可移植包。
  add('CLAUDE.md', `# ${agent.name}\n\n${agent.systemPrompt.trim()}\n`);
  add('.mcp.json', files.mcpJson);

  for (const subAgent of files.subAgents) {
    assertSlug(subAgent.slug, '子智能体 slug');
    add(`.claude/agents/${subAgent.slug}.md`, subAgent.content);
  }

  for (const skill of files.skills) {
    assertSlug(skill.slug, '技能 slug');
    add(`.claude/skills/${skill.slug}/SKILL.md`, skill.content);
    for (const file of skill.files) {
      assertRelativePath(file.path, '技能文件路径');
      add(`.claude/skills/${skill.slug}/${file.path}`, file.content);
    }
  }

  for (const rule of files.rules) {
    assertSlug(rule.slug, '规则 slug');
    add(`.claude/rules/${rule.slug}.md`, rule.content);
  }

  for (const style of files.outputStyles) {
    assertSlug(style.slug, '输出风格 slug');
    add(`.claude/output-styles/${style.slug}.md`, style.content);
  }

  if (files.settingsJson !== null) {
    parseJsonObject(files.settingsJson, '.claude/settings.json');
    add('.claude/settings.json', files.settingsJson);
  }

  return zipSync(entries);
}

interface ArchiveEntry {
  name: string;
  data: Uint8Array;
}

/**
 * 归档按固定大小分块推入：fflate 每次 push 只解压这一块，
 * 否则整包一次 push 会在 ondata 之前把高压缩比条目整体解压进内存。
 */
const PUSH_CHUNK_BYTES = 4096;

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_BYTES = 22;
const MAX_ARCHIVE_COMMENT_BYTES = 0xffff;

/**
 * fflate 0.8.3 的 Unzip 只读本地文件头，没有 onend/onerror，也不会读中央目录；
 * 截掉尾部（中央目录/EOCD）的归档它会当作正常结束。这里补上完整性校验，并返回声明的条目数。
 */
function readCentralDirectory(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const earliest = Math.max(0, data.length - EOCD_BYTES - MAX_ARCHIVE_COMMENT_BYTES);
  for (let i = data.length - EOCD_BYTES; i >= earliest; i -= 1) {
    if (view.getUint32(i, true) !== EOCD_SIGNATURE) continue;
    const commentBytes = view.getUint16(i + 20, true);
    // EOCD 必须正好结束在文件末尾；中央目录也必须紧贴 EOCD。
    if (i + EOCD_BYTES + commentBytes !== data.length) continue;
    if (view.getUint32(i + 16, true) + view.getUint32(i + 12, true) !== i) continue;
    return view.getUint16(i + 10, true);
  }
  return invalid('压缩包不完整或不是有效的 zip 文件');
}

function readEntries(data: Uint8Array): ArchiveEntry[] {
  if (data.byteLength > ARCHIVE_LIMITS.archiveBytes) {
    fail('PAYLOAD_TOO_LARGE', `压缩包超过 ${ARCHIVE_LIMITS.archiveBytes} 字节上限`);
  }
  const declaredEntries = readCentralDirectory(data);

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let count = 0;
  let unpacked = 0;
  let declaredUnpacked = 0;
  // 超限时在回调里抛错会被 fflate 的 Inflate 捕获并再回调一次；记住它，第二次直接抛出终止解压。
  let failure: AppError | undefined;

  const unzip = new Unzip((file) => {
    count += 1;
    if (count > ARCHIVE_LIMITS.entries) {
      fail('PAYLOAD_TOO_LARGE', `压缩包条目数超过 ${ARCHIVE_LIMITS.entries} 上限`);
    }
    if (file.name.endsWith('/')) return;
    assertRelativePath(file.name, '归档条目');

    const key = file.name.toLowerCase();
    if (seen.has(key)) invalid(`归档内路径重复：${file.name}`);
    seen.add(key);

    // 头部声明的大小可以提前拦住大文件；实际字节仍以流式累计为准。
    const originalSize = file.originalSize ?? 0;
    declaredUnpacked += originalSize;
    if (originalSize > ARCHIVE_LIMITS.fileBytes) {
      fail('PAYLOAD_TOO_LARGE', `单个文件超过 ${ARCHIVE_LIMITS.fileBytes} 字节上限：${file.name}`);
    }
    if (declaredUnpacked > ARCHIVE_LIMITS.unpackedBytes) {
      fail('PAYLOAD_TOO_LARGE', `解压总大小超过 ${ARCHIVE_LIMITS.unpackedBytes} 字节上限`);
    }

    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (failure !== undefined) throw failure;
      if (err) {
        failure = new AppError('INVALID_INPUT', `压缩包损坏：${file.name}`);
        throw failure;
      }
      const reject = (message: string): never => {
        failure = new AppError('PAYLOAD_TOO_LARGE', message);
        file.terminate();
        throw failure;
      };
      size += chunk.length;
      if (size > ARCHIVE_LIMITS.fileBytes) {
        reject(`单个文件超过 ${ARCHIVE_LIMITS.fileBytes} 字节上限：${file.name}`);
      }
      unpacked += chunk.length;
      if (unpacked > ARCHIVE_LIMITS.unpackedBytes) {
        reject(`解压总大小超过 ${ARCHIVE_LIMITS.unpackedBytes} 字节上限`);
      }
      chunks.push(chunk);
      if (!final) return;

      if (chunks.length === 1) {
        entries.push({ name: file.name, data: chunks[0] as Uint8Array });
        return;
      }
      const merged = new Uint8Array(size);
      let offset = 0;
      for (const part of chunks) {
        merged.set(part, offset);
        offset += part.length;
      }
      entries.push({ name: file.name, data: merged });
    };
    file.start();
  });

  unzip.register(UnzipInflate);
  try {
    for (let offset = 0; offset < data.length; offset += PUSH_CHUNK_BYTES) {
      const end = Math.min(offset + PUSH_CHUNK_BYTES, data.length);
      unzip.push(data.subarray(offset, end), end === data.length);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    invalid('压缩包损坏或不是有效的 zip 文件');
  }
  if (count !== declaredEntries) invalid('压缩包条目数与中央目录声明不一致');
  return entries;
}

function decodeText(entry: ArchiveEntry): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(entry.data);
  } catch {
    invalid(`文件不是 UTF-8 文本：${entry.name}`);
  }
}

function parseClaudeMd(content: string): ArchiveAgentMeta {
  const text = content.replace(/^﻿/, '');
  const match = /^#[ \t]+(.+?)[ \t]*\r?$/m.exec(text);
  const name = match?.[1]?.trim();
  if (match?.index === undefined || !name) {
    invalid('CLAUDE.md 缺少用于智能体名称的一级标题');
  }
  const rest = text.slice(0, match.index) + text.slice(match.index + match[0].length);
  return { name, systemPrompt: rest.trim() };
}

/** paths 接受 YAML 列表或逗号分隔字符串；花括号内的逗号不拆。 */
function globsFromPaths(value: unknown): string {
  if (value === undefined) return '';
  const values =
    typeof value === 'string'
      ? [value]
      : Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? (value as string[])
        : invalid('规则文件的 paths 必须是字符串列表或逗号分隔字符串', '/paths');
  return values.flatMap(splitGlobs).join(', ');
}

function parseRule(
  content: string,
  slug: string,
  warnings: string[],
): { slug: string; content: string; globs: string } {
  const text = content.replace(/^﻿/, '');
  if (!/^---[ \t]*\r?\n/.test(text)) return { slug, content: text.trim(), globs: '' };

  const { fields, body } = parseMarkdownFrontmatter(text, '规则文件', `/rules/${slug}`);
  const unknown = [...fields.keys()].filter((key) => key !== 'paths');
  if (unknown.length > 0) {
    warnings.push(`规则「${slug}」的前置字段 ${unknown.join('、')} 不受支持，已忽略`);
  }
  return { slug, content: body.trim(), globs: globsFromPaths(fields.get('paths')) };
}

function parseOutputStyle(
  content: string,
  slug: string,
  selected: string | null,
  warnings: string[],
): ParsedArchive['outputStyles'][number] {
  const { fields, body } = parseMarkdownFrontmatter(
    content,
    '输出风格文件',
    `/output-styles/${slug}`,
  );

  const rawName = fields.get('name');
  const name =
    rawName === undefined
      ? slug
      : typeof rawName === 'string' && rawName.trim() !== ''
        ? rawName.trim()
        : invalid('输出风格文件的 name 必须是非空字符串', '/name');

  const description = fields.get('description');
  if (description !== undefined && typeof description !== 'string') {
    invalid('输出风格文件的 description 必须是字符串', '/description');
  }

  const keep = fields.get('keep-coding-instructions');
  if (keep !== undefined && typeof keep !== 'boolean') {
    invalid('输出风格文件的 keep-coding-instructions 必须是布尔值', '/keep-coding-instructions');
  }

  if (fields.has('force-for-plugin')) {
    warnings.push(`输出风格「${name}」的 force-for-plugin 仅供插件使用，已忽略`);
  }
  const unknown = [...fields.keys()].filter(
    (key) =>
      key !== 'name' &&
      key !== 'description' &&
      key !== 'keep-coding-instructions' &&
      key !== 'force-for-plugin',
  );
  if (unknown.length > 0) {
    warnings.push(`输出风格「${name}」的前置字段 ${unknown.join('、')} 不受支持，已忽略`);
  }

  return {
    slug,
    description: typeof description === 'string' ? description : '',
    keepCodingInstructions: keep === true,
    body: body.trim(),
    isSelected: selected === name || selected === slug,
  };
}

function parseChild(
  content: string,
  path: string,
  defaults: { model?: string; permissionMode?: string },
): ParsedArchiveChild {
  // 只是判断字段是否缺省；解析仍由 parseAgentMd 完成，避免第二套 frontmatter 规则。
  const { fields } = parseMarkdownFrontmatter(content, '子智能体文件', path);
  // 子智能体的 model: inherit 是官方合法写法，继承父智能体（归档里即 settings.model）。
  const { agent } = parseAgentMd(content, { allowInherit: true });
  const inheritsModel = fields.get('model') === 'inherit';
  return {
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    model: inheritsModel || !fields.has('model') ? (defaults.model ?? agent.model) : agent.model,
    permissionMode: fields.has('permissionMode')
      ? agent.permissionMode
      : (defaults.permissionMode ?? agent.permissionMode),
    maxTurns: agent.maxTurns,
    ...(agent.effort ? { effort: agent.effort } : {}),
    allowedTools: agent.allowedTools,
    disallowedTools: agent.disallowedTools,
    skills: stringList(fields.get('skills'), 'skills') ?? [],
  };
}

export function parseWorkspaceArchive(data: Uint8Array): ParsedArchive {
  const entries = readEntries(data);
  const warnings: string[] = [];

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  function textOf(name: string): string | undefined {
    const entry = byName.get(name);
    return entry === undefined ? undefined : decodeText(entry);
  }

  const claudeMd = textOf('CLAUDE.md');
  if (claudeMd === undefined) invalid('压缩包缺少 CLAUDE.md');
  const agent = parseClaudeMd(claudeMd);

  const settingsText = textOf('.claude/settings.json');
  const settings =
    settingsText === undefined ? {} : parseJsonObject(settingsText, '.claude/settings.json');

  const mcpText = textOf('.mcp.json');
  let mcp: Record<string, unknown> = {};
  if (mcpText !== undefined) {
    const root = parseJsonObject(mcpText, '.mcp.json');
    const servers = root.mcpServers;
    if (servers !== undefined && !isRecord(servers)) {
      invalid('.mcp.json 的 mcpServers 必须是对象');
    }
    mcp = isRecord(servers) ? servers : {};
    const extra = Object.keys(root).filter((key) => key !== 'mcpServers');
    if (extra.length > 0) {
      warnings.push(`.mcp.json 的顶层字段 ${extra.join('、')} 不受支持，已忽略`);
    }
  }

  // 官方子智能体默认继承会话的模型与权限模式；settings 里有值时作为缺省。
  const settingsModel = typeof settings.model === 'string' ? settings.model.trim() : '';
  const defaultModel =
    settingsModel !== '' && settingsModel !== 'inherit' ? settingsModel : undefined;
  const permissions = isRecord(settings.permissions) ? settings.permissions : undefined;
  const settingsMode =
    typeof permissions?.defaultMode === 'string' ? permissions.defaultMode : undefined;
  const defaultMode =
    settingsMode !== undefined && FALLBACK_PERMISSION_MODES.has(settingsMode)
      ? settingsMode
      : undefined;
  if (settingsMode !== undefined && defaultMode === undefined) {
    warnings.push(
      `settings.permissions.defaultMode「${settingsMode}」不由项目设置生效或平台不支持，已忽略`,
    );
  }

  const selected = typeof settings.outputStyle === 'string' ? settings.outputStyle : null;

  const subAgents: ParsedArchiveChild[] = [];
  const rules: ParsedArchive['rules'] = [];
  const outputStyles: ParsedArchive['outputStyles'] = [];
  const skillDirs = new Map<
    string,
    { skillMd?: string; files: Array<{ path: string; content: string }> }
  >();

  for (const entry of entries) {
    const { name } = entry;
    if (name === 'CLAUDE.md' || name === '.mcp.json' || name === '.claude/settings.json') continue;

    const agentMatch = /^\.claude\/agents\/([^/]+)\.md$/.exec(name);
    if (agentMatch?.[1]) {
      subAgents.push(
        parseChild(decodeText(entry), `/${name}`, {
          ...(defaultModel === undefined ? {} : { model: defaultModel }),
          ...(defaultMode === undefined ? {} : { permissionMode: defaultMode }),
        }),
      );
      continue;
    }

    const ruleMatch = /^\.claude\/rules\/([^/]+)\.md$/.exec(name);
    if (ruleMatch?.[1]) {
      rules.push(parseRule(decodeText(entry), ruleMatch[1], warnings));
      continue;
    }

    const styleMatch = /^\.claude\/output-styles\/([^/]+)\.md$/.exec(name);
    if (styleMatch?.[1]) {
      outputStyles.push(parseOutputStyle(decodeText(entry), styleMatch[1], selected, warnings));
      continue;
    }

    const skillMatch = /^\.claude\/skills\/([^/]+)\/(.+)$/.exec(name);
    if (skillMatch?.[1] && skillMatch[2]) {
      const dir = skillMatch[1];
      const relative = skillMatch[2];
      const state = skillDirs.get(dir) ?? { files: [] };
      skillDirs.set(dir, state);
      if (relative.toLowerCase() === 'skill.md') {
        if (relative !== 'SKILL.md') invalid(`技能文件必须命名为 SKILL.md：${name}`);
        state.skillMd = decodeText(entry);
      } else {
        state.files.push({ path: relative, content: decodeText(entry) });
      }
      continue;
    }

    invalid(`压缩包包含不支持的文件：${name}`);
  }

  const skills: ParsedArchive['skills'] = [];
  for (const [dir, state] of skillDirs) {
    if (state.skillMd === undefined) invalid(`技能目录缺少 SKILL.md：.claude/skills/${dir}`);
    const { skill } = parseSkillMd(state.skillMd);
    if (skill.slug !== dir) {
      warnings.push(`技能目录「${dir}」与 SKILL.md 的 name「${skill.slug}」不一致`);
    }
    skills.push({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      body: skill.body,
      ...(skill.license === undefined ? {} : { license: skill.license }),
      ...(skill.compatibility === undefined ? {} : { compatibility: skill.compatibility }),
      ...(skill.metadata === undefined ? {} : { metadata: skill.metadata }),
      files: state.files,
    });
  }

  if (selected !== null && !outputStyles.some((style) => style.isSelected)) {
    warnings.push(`settings.outputStyle 指向的输出风格「${selected}」不在压缩包中`);
  }

  return { agent, subAgents, skills, rules, outputStyles, mcp, settings, warnings };
}
