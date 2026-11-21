export interface ParsedUrl {
  username: string;
  password: string;
  hostname: string;
  protocol: string;
  toString(): string;
}

export function parseUrl(value: string): ParsedUrl | null {
  try {
    return new (globalThis as unknown as { URL: new (value: string) => ParsedUrl }).URL(value);
  } catch {
    return null;
  }
}
