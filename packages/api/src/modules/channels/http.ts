import { outputPathSchema } from '@agentport/shared';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { HttpEnv } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import type { NativeHttpDependencies } from '../chat/http.js';
import { contentDisposition, safeMediaType } from '../chat/outputs.js';
import { registerChannelRunEventsHttp } from './control.js';
import { registerChannelEventsHttp } from './router.js';
import { readChannelRunOutput } from './runs.js';

export function registerChannelRunOutputsHttp(app: Hono<HttpEnv>): void {
  app.get(
    '/api/channels/:id/runs/:runId/outputs/download',
    access({ kind: 'authenticated' }),
    async (c) => {
      const context = requestContext(c);
      const input = z
        .object({
          params: z.object({ id: z.string().min(1), runId: z.string().min(1) }),
          query: z.object({ path: outputPathSchema }),
        })
        .parse({ params: c.req.param(), query: c.req.query() });
      const { file, data } = await readChannelRunOutput(
        context,
        input.params.id,
        input.params.runId,
        input.query.path,
      );
      c.header('Content-Type', safeMediaType(file.mediaType));
      c.header('Content-Disposition', contentDisposition(file.path));
      c.header('Cache-Control', 'no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(new Uint8Array(data));
    },
  );
}

export function registerChannelsHttp(app: Hono<HttpEnv>, deps: NativeHttpDependencies): void {
  registerChannelEventsHttp(app, deps);
  registerChannelRunEventsHttp(app, deps);
  registerChannelRunOutputsHttp(app);
}
