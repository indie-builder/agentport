import { isMap, parseDocument } from 'yaml';

const MODEL_PATH = /^models\/[^/]+\/metadata\.yml$/;

function normalizeSafePath(path: string): string | null {
  if (path === '' || path.includes('\x00') || path.includes('\\')) return null;
  if (path.startsWith('/')) return null;
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) return null;
  if (parts.length === 0) return null;
  const name = parts.at(-1);
  if (name === '.env' || name === 'profiles.yml') return null;
  return parts.join('/');
}

function yamlParses(content: string): boolean {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) return false;
  try {
    doc.toJS();
  } catch {
    return false;
  }
  return true;
}

function isYamlMapping(content: string): boolean {
  const doc = parseDocument(content);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return false;
  try {
    doc.toJS();
  } catch {
    return false;
  }
  return true;
}

function isJsonValid(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

export function validateWrenProjectFiles(
  files: Record<string, string>,
): { ok: true } | { ok: false; error: string } {
  const entries: { path: string; normalized: string; content: string }[] = [];
  const normalizedToPath = new Map<string, string>();
  for (const path of Object.keys(files)) {
    const normalized = normalizeSafePath(path);
    if (normalized === null) return { ok: false, error: `文件路径不合法：${path}` };
    const existing = normalizedToPath.get(normalized);
    if (existing !== undefined) {
      return { ok: false, error: `文件路径冲突：${existing} 与 ${path}` };
    }
    normalizedToPath.set(normalized, path);
    entries.push({ path, normalized, content: files[path] ?? '' });
  }

  if (!normalizedToPath.has('wren_project.yml')) {
    return { ok: false, error: '缺少必需文件 wren_project.yml' };
  }
  if (![...normalizedToPath.keys()].some((normalized) => MODEL_PATH.test(normalized))) {
    return { ok: false, error: '至少需要一个 models/<表>/metadata.yml 模型文件' };
  }

  for (const { path, normalized, content } of entries) {
    if (normalized === 'wren_project.yml' || MODEL_PATH.test(normalized)) {
      if (!isYamlMapping(content)) return { ok: false, error: `文件 ${path} 不是合法 YAML` };
    } else if (/\.ya?ml$/.test(normalized)) {
      if (!yamlParses(content)) return { ok: false, error: `文件 ${path} 不是合法 YAML` };
    } else if (normalized.endsWith('.json')) {
      if (!isJsonValid(content)) return { ok: false, error: `文件 ${path} 不是合法 JSON` };
    }
  }
  return { ok: true };
}
