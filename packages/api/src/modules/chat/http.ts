import { ATTACHMENT_LIMITS } from '@agentport/shared';
import type { Hono } from 'hono';
import { requestBodyLimit } from '../../http/body-limit.js';
import type { HttpEnv, NativeHttpDependencies } from '../../http/context.js';
import { registerChatAttachmentsHttp } from './attachments.js';
import { registerChatOutputsHttp } from './outputs.js';
import { registerChatEventsHttp } from './router.js';
export function registerChatHttp(app: Hono<HttpEnv>, deps: NativeHttpDependencies): void {
  app.on('POST', '/api/chat', requestBodyLimit(ATTACHMENT_LIMITS.bodyBytes));
  registerChatEventsHttp(app, deps);
  registerChatOutputsHttp(app);
  registerChatAttachmentsHttp(app);
}
