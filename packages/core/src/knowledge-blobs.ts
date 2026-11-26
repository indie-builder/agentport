import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hasErrorCode } from '@agentport/shared';
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
    await Bun.write(temp, data);
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
  const existing = await stat(knowledgeBlobPath(knowledgeDir, sha)).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  });
  if (existing !== null) return;
  await writeKnowledgeBlob(knowledgeDir, sha, data);
}
