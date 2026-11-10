export function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === 'AbortError');
}

export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function extensionOf(value: string): string {
  const dot = value.lastIndexOf('.');
  return dot < 0 ? '' : value.slice(dot + 1).toLowerCase();
}

export function titleWithExtension(name: string, extension: string): string {
  return extensionOf(name) === extension.toLowerCase() ? name : `${name}.${extension}`;
}
