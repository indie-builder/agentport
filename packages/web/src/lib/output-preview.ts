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
