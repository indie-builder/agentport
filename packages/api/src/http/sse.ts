import type { HttpContext } from './context.js';

export function beginSse(
  c: HttpContext,
  timeout: (request: Request, seconds: number) => void,
): void {
  timeout(c.req.raw, 0);
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('X-Accel-Buffering', 'no');
}
