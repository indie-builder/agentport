import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from '@e2e-dev/web';
import { encodePackage } from '../../packages/api/src/features/agent-package-zip.js';

/** 固定数据集命名空间；所有专用 slug 与 manifest 路径都带这个标记。 */
export const DATASET_ID = 'devdata-qinghe-v1';

const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** 返回某个领域 manifest 的绝对路径；文件本身由 owner 组负责写入。 */
export function datasetPath(section: string): string {
  if (!/^[a-z]+$/.test(section)) throw new Error(`非法 manifest 分区：${section}`);
  return path.join(projectRoot, 'data', 'dev-dataset', DATASET_ID, `${section}.json`);
}

/**
 * 用已登录浏览器的同源会话请求业务 API。
 * 只允许 /api/ 路径；非 2xx 直接抛出带响应体原文的错误，不吞错。
 */
export async function api<T>(
  browser: Browser,
  requestPath: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  if (!requestPath.startsWith('/api/'))
    throw new Error(`api() 只接受同源 /api 路径：${requestPath}`);
  const method = init.method ?? 'GET';
  const payload = init.body === undefined ? null : JSON.stringify(init.body);
  const response = await browser.evaluate(
    async (input: { path: string; method: string; body: string | null }) => {
      const result = await fetch(input.path, {
        method: input.method,
        credentials: 'same-origin',
        ...(input.body === null
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: input.body }),
      });
      return { status: result.status, text: await result.text() };
    },
    { path: requestPath, method, body: payload },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`API ${method} ${requestPath} 返回 ${response.status}：${response.text}`);
  }
  return (response.text === '' ? undefined : JSON.parse(response.text)) as T;
}

export async function manifestExists(section: string): Promise<boolean> {
  try {
    await access(datasetPath(section));
    return true;
  } catch {
    return false;
  }
}

export async function readManifest<T>(section: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(datasetPath(section), 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeManifest(section: string, value: unknown): Promise<void> {
  const file = datasetPath(section);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 生成一个只用于 UI 导入的本地插件 ZIP；不落仓库、导入完成后由调用方清理。 */
export async function writePluginZip(entries: Record<string, string>): Promise<{
  dir: string;
  file: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), `${DATASET_ID}-plugin-`));
  const file = path.join(dir, `${DATASET_ID}-plugin.zip`);
  await writeFile(file, encodePackage(entries));
  return { dir, file };
}
