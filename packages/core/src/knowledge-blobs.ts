import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { knowledgeBlobPath } from './knowledge-paths.js';

export async function writeKnowledgeBlob(
  knowledgeDir: string,
  sha: string,
  data: Uint8Array,
): Promise<void> {
  const target = knowledgeBlobPath(knowledgeDir, sha);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(temp, data);
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function ensureKnowledgeBlob(
  knowledgeDir: string,
  sha: string,
  data: Uint8Array,
): Promise<void> {
  if (await stat(knowledgeBlobPath(knowledgeDir, sha)).catch(() => null)) return;
  await writeKnowledgeBlob(knowledgeDir, sha, data);
}
