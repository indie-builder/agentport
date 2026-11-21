const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

export const BINARY_MIME_BY_EXTENSION: Record<string, string> & {
  '.docx': string;
  '.xlsx': string;
} = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.rtf': 'application/rtf',
  '.epub': 'application/epub+zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function extensionWithDot(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

export function declaredMime(contentType: string | null | undefined): string | undefined {
  const mime = contentType?.split(';')[0]?.trim().toLowerCase();
  return mime && mime !== 'application/octet-stream' ? mime : undefined;
}

export function mimeOf(name: string, declared: string | undefined): string | undefined {
  const extension = extensionWithDot(name);
  const byExtension = BINARY_MIME_BY_EXTENSION[extension] ?? TEXT_MIME_BY_EXTENSION[extension];
  if (byExtension) return byExtension;
  const mime = declaredMime(declared);
  return mime && EXTENSION_BY_MIME[mime] ? mime : undefined;
}

export const EXTENSION_BY_MIME: Record<string, string> = {};

export const MIME_BY_EXTENSION: Record<string, string> = {
  ...TEXT_MIME_BY_EXTENSION,
  '.rst': 'text/plain',
  '.adoc': 'text/plain',
};

export function mimeForExtension(extension: string): string | undefined {
  return BINARY_MIME_BY_EXTENSION[extension] ?? MIME_BY_EXTENSION[extension];
}

const EXTENSION_BY_MIME_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.rtf',
  '.epub',
  '.png',
  '.jpg',
  '.gif',
  '.webp',
  '.txt',
  '.html',
  '.csv',
  '.md',
  '.json',
  '.xml',
]);

for (const extension of EXTENSION_BY_MIME_EXTENSIONS) {
  const mime = mimeForExtension(extension);
  if (mime) EXTENSION_BY_MIME[mime] = extension.slice(1);
}

export const MIME_ALIASES: Record<string, string> = {
  'text/x-markdown': 'text/markdown',
  'application/md': 'text/markdown',
  'application/markdown': 'text/markdown',
  'image/jpg': 'image/jpeg',
};

export function textContentType(value: string | null): boolean {
  if (!value) return false;
  const mime = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml')
  );
}
