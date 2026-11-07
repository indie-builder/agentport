// shared 不带 DOM/Node lib，这里声明跨运行时都可用的最小 URL 形状。
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
