export interface ParsedUrl {
  username: string;
  password: string;
  hostname: string;
  protocol: string;
  toString(): string;
}

export function hasEmbeddedCredentials(url: ParsedUrl): boolean {
  return Boolean(url.username || url.password);
}

export function parseUrl(value: string): ParsedUrl | null {
  try {
    return new (globalThis as unknown as { URL: new (value: string) => ParsedUrl }).URL(value);
  } catch {
    return null;
  }
}
