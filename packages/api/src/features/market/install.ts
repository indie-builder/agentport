import { fail, parseSkillMd } from '@agentport/core';
import {
  type MarketInstallInput,
  type SkillInput,
  skillFileInputSchema,
  slugSchema,
} from '@agentport/shared';

const DOWNLOAD_URL = 'https://skills.sh/api/download';
const TIMEOUT_MS = 30_000;
// 快照 JSON 可能被上游放大；先按响应头挡掉明显超限的包。
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_FILE_CHARS = 200_000;
const MAX_TOTAL_CHARS = 10 * 1024 * 1024;

interface SkillFileDraft {
  path: string;
  content: string;
}

interface SnapshotEntry {
  path: string;
  contents: string;
}

export function snapshotToSkill(
  slug: string,
  entries: unknown[],
): { skill: SkillInput; files: SkillFileDraft[]; warnings: string[] } {
  if (!slugSchema.safeParse(slug).success) {
    fail('INVALID_INPUT', `市场技能目录名不合法：${slug}`);
  }

  let skillMd: string | null = null;
  const files: SkillFileDraft[] = [];
  const warnings: string[] = [];
  let chars = 0;

  for (const raw of entries) {
    const entry = raw as Partial<SnapshotEntry> | null;
    if (typeof entry?.path !== 'string' || typeof entry.contents !== 'string') {
      warnings.push('跳过快照中格式不正确的条目');
      continue;
    }
    if (entry.contents.length > MAX_FILE_CHARS) {
      warnings.push(`跳过超过 ${MAX_FILE_CHARS} 字符的文件 ${entry.path}`);
      continue;
    }
    if (entry.contents.includes('\0')) {
      warnings.push(`跳过非文本文件 ${entry.path}`);
      continue;
    }
    if (entry.path === 'SKILL.md') {
      skillMd = entry.contents;
      continue;
    }
    if (!skillFileInputSchema.safeParse({ path: entry.path, content: entry.contents }).success) {
      warnings.push(`跳过路径不合法的文件 ${entry.path}`);
      continue;
    }
    files.push({ path: entry.path, content: entry.contents });
    chars += entry.contents.length;
    if (files.length > MAX_FILES || chars > MAX_TOTAL_CHARS) {
      fail('INVALID_INPUT', '技能资源文件过多或过大，无法安装');
    }
  }

  if (skillMd === null) fail('INVALID_INPUT', '市场技能缺少 SKILL.md，无法安装');
  // frontmatter 的 license/metadata 等描述性字段不落库，只提示资源文件层面的问题。
  const { skill } = parseSkillMd(skillMd, { slug });
  return { skill, files, warnings };
}

export async function installFromMarket(input: MarketInstallInput): Promise<{
  skill: SkillInput;
  files: SkillFileDraft[];
  warnings: string[];
}> {
  const [owner, repo, slug] = input.id.split('/');
  if (!owner || !repo || !slug) fail('INVALID_INPUT', '市场技能 id 不合法');

  const url = `${DOWNLOAD_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(slug)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'agentport-market/1.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    fail('UPSTREAM_FAILED', '暂时无法下载市场技能，请稍后重试', { cause: err, retryable: true });
  }
  if (response.status === 404) {
    fail('NOT_FOUND', '该技能在 skills.sh 上没有可用快照，暂不支持安装');
  }
  if (!response.ok) {
    fail('UPSTREAM_FAILED', `技能快照下载失败（${response.status}），请稍后重试`, {
      retryable: true,
    });
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    fail('INVALID_INPUT', '技能快照超过大小限制，无法安装');
  }

  let body: { files?: unknown };
  try {
    body = (await response.json()) as { files?: unknown };
  } catch (err) {
    fail('UPSTREAM_FAILED', '技能快照格式不正确，请稍后重试', { cause: err, retryable: true });
  }
  if (!Array.isArray(body.files)) {
    fail('UPSTREAM_FAILED', '技能快照格式不正确，请稍后重试');
  }
  return snapshotToSkill(slug, body.files);
}
