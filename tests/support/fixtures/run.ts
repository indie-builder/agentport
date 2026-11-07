import { createRequire } from 'node:module';
import { scenarios } from '../scenarios.js';
import { close } from './database.js';

const requireFromShared = createRequire(
  new URL('../../../packages/shared/package.json', import.meta.url),
);
const { z } = requireFromShared('zod');

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
