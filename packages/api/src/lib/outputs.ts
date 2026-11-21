import { listOutputFiles, readOutputFile } from '@agentport/core';
import type { OutputFile } from '@agentport/shared';

const PREVIEW_MAX_BYTES = 1024 * 1024;

type WorkspaceContext = { config: { WORKSPACES_DIR: string } };

export function readWorkspaceOutput(
  context: WorkspaceContext,
  input: { slug: string; conversationId: string; runId: string; path: string },
): Promise<{ file: OutputFile; data: Buffer }> {
  return readOutputFile({ root: context.config.WORKSPACES_DIR, ...input });
}

export function listWorkspaceOutputs(
  context: WorkspaceContext,
  input: { slug: string; conversationId: string; limit: number; before?: string; runId?: string },
) {
  return listOutputFiles({ root: context.config.WORKSPACES_DIR, ...input });
}

function isTextPreview(mediaType: string): boolean {
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType === 'image/svg+xml'
  );
}

function decodeUtf8(data: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

type PreviewResult =
  | { ok: true; content: string }
  | { ok: false; code: 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE'; message: string };

export function previewText(data: Buffer, mediaType: string): PreviewResult {
  if (data.length > PREVIEW_MAX_BYTES) {
    return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: '文件超过 1MiB，请下载原件查看' };
  }
  if (!isTextPreview(mediaType)) {
    return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: '该文件不能直接预览，请下载原件' };
  }
  const content = decodeUtf8(data);
  if (content === null) {
    return {
      ok: false,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: '该文件不是有效的 UTF-8 文本，请下载原件',
    };
  }
  return { ok: true, content };
}

export function safeMediaType(mediaType: string): string {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mediaType)
    ? mediaType
    : 'application/octet-stream';
}
