import { join } from 'node:path';

export function knowledgeBlobsRoot(knowledgeDir: string): string {
  return join(knowledgeDir, 'blobs');
}

export function knowledgeBlobPath(knowledgeDir: string, sha: string): string {
  return join(knowledgeBlobsRoot(knowledgeDir), sha.slice(0, 2), sha);
}

export function knowledgeDocsRoot(knowledgeDir: string): string {
  return join(knowledgeDir, 'docs');
}

export function knowledgeDocumentDir(knowledgeDir: string, documentId: string): string {
  return join(knowledgeDocsRoot(knowledgeDir), documentId);
}

export function knowledgeVersionDir(
  knowledgeDir: string,
  documentId: string,
  versionId: string,
): string {
  return join(knowledgeDocumentDir(knowledgeDir, documentId), versionId);
}

export function knowledgeVersionMarkdownPath(
  knowledgeDir: string,
  documentId: string,
  versionId: string,
): string {
  return join(knowledgeVersionDir(knowledgeDir, documentId, versionId), 'markdown.md');
}

export function knowledgeVersionImagesDir(
  knowledgeDir: string,
  documentId: string,
  versionId: string,
): string {
  return join(knowledgeVersionDir(knowledgeDir, documentId, versionId), 'images');
}

export function knowledgeVersionImagePath(
  knowledgeDir: string,
  documentId: string,
  versionId: string,
  name: string,
): string {
  return join(knowledgeVersionImagesDir(knowledgeDir, documentId, versionId), name);
}
