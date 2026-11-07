import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from '@e2e-dev/web';
import { encodePackage } from '../../packages/api/src/modules/agents/package-zip.js';
import { browserFetch } from './browser-api.js';

export const DATASET_ID = 'devdata-qinghe-v1';

const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function datasetPath(section: string): string {
  if (!/^[a-z]+$/.test(section)) throw new Error(`非法 manifest 分区：${section}`);
  return path.join(projectRoot, 'data', 'dev-dataset', DATASET_ID, `${section}.json`);
}

export class DatasetApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(
  browser: Browser,
  requestPath: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  if (!requestPath.startsWith('/api/'))
    throw new Error(`api() 只接受同源 /api 路径：${requestPath}`);
  const method = init.method ?? 'GET';
  const response = await browserFetch(browser, method, requestPath, init.body);
  if (response.status < 200 || response.status >= 300) {
    throw new DatasetApiError(
      response.status,
      `API ${method} ${requestPath} 返回 ${response.status}：${response.text}`,
    );
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

export function writeManifest(section: string, value: unknown): void {
  const file = datasetPath(section);
  const temp = `${file}.tmp-${randomUUID()}`;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export async function writePluginZip(entries: Record<string, string>): Promise<{
  dir: string;
  file: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), `${DATASET_ID}-plugin-`));
  const file = path.join(dir, `${DATASET_ID}-plugin.zip`);
  await writeFile(file, encodePackage(entries));
  return { dir, file };
}
