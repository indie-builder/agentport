import type { Hono } from 'hono';
import type { HttpEnv } from '../../http/context.js';
import { registerChatAttachmentsHttp } from './attachments.js';
import { registerChatOutputsHttp } from './outputs.js';
import { registerChatEventsHttp } from './router.js';
export type NativeHttpDependencies = { timeout: (request: Request, seconds: number) => void };
export function registerChatHttp(app: Hono<HttpEnv>, deps: NativeHttpDependencies): void {
  registerChatEventsHttp(app, deps);
  registerChatOutputsHttp(app);
  registerChatAttachmentsHttp(app);
}
