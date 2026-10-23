import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAgentRoutes } from '../src/features/agents/routes.js';
import { registerErrorHandler } from '../src/plugins/errors.js';

vi.mock('../src/plugins/audit.js', () => ({ writeAudit: vi.fn() }));
let app: FastifyInstance;
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'memory-routes-'));
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('requireAuth', async () => {});
  app.decorate('config', { WORKSPACES_DIR: root });
  app.decorate('db', {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ slug: 'agent' }] }) }) }),
  });
  registerErrorHandler(app);
  registerAgentRoutes(app);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('memory routes', () => {
  it.each(['GET', 'PUT', 'DELETE'] as const)(
    'validates filenames before looking up the agent for %s',
    async (method) => {
      for (const name of ['.hidden.md', 'notes.txt', '..%2Fprivate.md', 'a%5Cb.md']) {
        const response = await app.inject({
          method,
          url: `/api/agents/agent/memory/${name}`,
          ...(method === 'PUT' ? { payload: { content: 'x' } } : {}),
        });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json()).toMatchObject({ code: 'INVALID_INPUT', path: '/name' });
      }
    },
  );

  it('returns 413 for oversized UTF-8 memory content', async () => {
    for (const content of ['界'.repeat(66_667), 'x'.repeat(200_001)]) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/agents/agent/memory/MEMORY.md',
        payload: { content },
      });
      expect(response.statusCode, response.body.slice(0, 500)).toBe(413);
      expect(response.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    }
  });

  it.each(['GET', 'PUT', 'DELETE'] as const)(
    'returns 400 for links without leaking their private path for %s',
    async (method) => {
      await fs.mkdir(join(root, 'agent', 'agent-memory'), { recursive: true });
      await fs.symlink('/private/secret-file.md', join(root, 'agent', 'agent-memory', 'MEMORY.md'));
      const response = await app.inject({
        method,
        url: '/api/agents/agent/memory/MEMORY.md',
        ...(method === 'PUT' ? { payload: { content: 'x' } } : {}),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_INPUT' });
      expect(response.body).not.toContain('/private/secret-file.md');
      expect(response.body).not.toContain('cause');
    },
  );

  it('reports an IO write failure as internal error without exposing filesystem details', async () => {
    await fs.writeFile(join(root, 'agent'), 'not a directory');
    const response = await app.inject({
      method: 'PUT',
      url: '/api/agents/agent/memory/MEMORY.md',
      payload: { content: 'x' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(response.body).not.toContain(root);
    expect(response.body).not.toContain('cause');
  });
});
