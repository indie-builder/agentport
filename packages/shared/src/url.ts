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

declare const URL: new (value: string) => ParsedUrl;

export function parseUrl(value: string): ParsedUrl | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
