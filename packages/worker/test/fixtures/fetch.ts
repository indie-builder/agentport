const actualFetch = globalThis.fetch;

export function stubFetch(fn: typeof fetch): void {
  globalThis.fetch = fn;
}

export function restoreFetch(): void {
  globalThis.fetch = actualFetch;
}
