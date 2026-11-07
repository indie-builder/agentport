import type { Browser } from '@e2e-dev/web';

export function browserFetch(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  return browser.evaluate(
    async (input: { method: string; path: string; body: string | null }) => {
      const response = await fetch(input.path, {
        method: input.method,
        ...(input.body === null
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: input.body }),
      });
      return { status: response.status, text: await response.text() };
    },
    { method, path, body: body === undefined ? null : JSON.stringify(body) },
  );
}
