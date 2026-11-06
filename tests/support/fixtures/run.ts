import { z } from '../../../packages/shared/node_modules/zod/index.js';
import { close } from './database.js';

const scenarios = {
  'agent-defaults': () => import('./agent-defaults.js'),
  'agent-package-bytes': () => import('./agent-package-bytes.js'),
  'audit-export': () => import('./audit-export.js'),
  'runs-export': () => import('./runs-export.js'),
  'eval-export': () => import('./eval-export.js'),
  'overview-aggregates': () => import('./overview-aggregates.js'),
  'run-cancel': () => import('./run-cancel.js'),
  'chat-history-filter': () => import('./chat-history-filter.js'),
  'chat-history-pages': () => import('./chat-history-pages.js'),
  regression: () => import('./regression.js'),
  channels: () => import('./channels.js'),
  'channels-business': () => import('./channels-business.js'),
  'chat-replay': () => import('./chat-replay.js'),
};

const request = z
  .object({
    scenario: z.custom<keyof typeof scenarios>(
      (value) => typeof value === 'string' && Object.hasOwn(scenarios, value),
    ),
    operation: z.string(),
    args: z.array(z.unknown()),
  })
  .strict()
  .parse(JSON.parse(await Bun.stdin.text()));

try {
  if (request.scenario === 'chat-replay' && process.env.E2E_WORKER_PAUSED !== '1')
    throw new Error('E2E_WORKER_PAUSED=1 is required for replay fixtures');
  const module = await scenarios[request.scenario]();
  if (!Object.hasOwn(module, request.operation)) throw new Error('Unknown fixture operation');
  const operation: unknown = Reflect.get(module, request.operation);
  if (typeof operation !== 'function') throw new Error('Fixture operation must be callable');
  const result: unknown = await operation(...request.args);
  process.stdout.write(JSON.stringify({ result }));
} finally {
  await close();
}
