export function outputPreviewKind(
  mediaType: string,
): 'markdown' | 'text' | 'image' | 'pdf' | 'binary' {
  const type = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'text/markdown') return 'markdown';
  if (/^image\/(png|jpeg|gif|webp)$/.test(type)) return 'image';
  if (type === 'application/pdf') return 'pdf';
  return /^(text\/|application\/json$|image\/svg\+xml$)/.test(type) ? 'text' : 'binary';
}

export function outputSelectionMode(mediaType: string): 'read' | 'source' {
  return outputPreviewKind(mediaType) === 'markdown' ? 'read' : 'source';
}

export type SharePreviewKind = 'markdown' | 'code' | 'image' | 'pdf' | 'none';

export function sharePreviewKind(mediaType: string): SharePreviewKind {
  const type = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'text/x-markdown') return 'markdown';
  switch (outputPreviewKind(mediaType)) {
    case 'markdown':
      return 'markdown';
    case 'text':
      return 'code';
    case 'image':
      return 'image';
    case 'pdf':
      return 'pdf';
    case 'binary':
      return 'none';
  }
}
