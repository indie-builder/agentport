function contentDisposition(path: string): string {
  const name = path.split('/').at(-1) ?? 'download';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function attachmentResponse(
  body: string | Uint8Array,
  filename: string,
  mediaType: string,
): Response {
  return new Response(body, {
    headers: {
      'content-type': mediaType,
      'content-disposition': contentDisposition(filename),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
