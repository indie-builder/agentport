import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  cleanup,
  createAgent,
  infraReady,
  loginCookie,
  request,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('memory routes', () => {
  let app: TestApp;
  let cookie: string;
  let root: string;
  let id: string;
  let brokenId: string;
  const agentSlugs: string[] = [];

  beforeAll(async () => {
    root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'memory-routes-'));
    app = await startApp({ WORKSPACES_DIR: root });
    cookie = await loginCookie(app);
    id = (
      await createAgent(app, cookie, {
        slug: unique('memory-agent'),
        track: agentSlugs,
      })
    ).json<{ id: string }>().id;
    brokenId = (
      await createAgent(app, cookie, {
        slug: unique('memory-broken'),
        track: agentSlugs,
      })
    ).json<{ id: string }>().id;
  });

  afterAll(async () => {
    if (!app) return;
    await cleanup(app, { agentSlugs });
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(['GET', 'PUT', 'DELETE'] as const)(
    'validates filenames before looking up the agent for %s',
    async (method) => {
      for (const name of ['.hidden.md', 'notes.txt', '..%2Fprivate.md', 'a%5Cb.md']) {
        const response = await request(app, {
          method,
          url: `/api/agents/${id}/memory/${name}`,
          headers: { cookie },
          ...(method === 'PUT' ? { payload: { content: 'x' } } : {}),
        });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json()).toMatchObject({ code: 'INVALID_INPUT', path: '/params/name' });
      }
    },
  );

  it('returns 413 for oversized UTF-8 memory content', async () => {
    for (const content of ['界'.repeat(66_667), 'x'.repeat(200_001)]) {
      const response = await request(app, {
        method: 'PUT',
        url: `/api/agents/${id}/memory/MEMORY.md`,
        headers: { cookie },
        payload: { content },
      });
      expect(response.statusCode, response.body.slice(0, 500)).toBe(413);
      expect(response.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    }
  });

  it.each(['GET', 'PUT', 'DELETE'] as const)(
    'returns 400 for links without leaking their private path for %s',
    async (method) => {
      const slug = agentSlugs[0] ?? '';
      await fs.mkdir(join(root, slug, 'agent-memory'), { recursive: true });
      await fs.rm(join(root, slug, 'agent-memory', 'MEMORY.md'), { force: true });
      await fs.symlink('/private/secret-file.md', join(root, slug, 'agent-memory', 'MEMORY.md'));
      const response = await request(app, {
        method,
        url: `/api/agents/${id}/memory/MEMORY.md`,
        headers: { cookie },
        ...(method === 'PUT' ? { payload: { content: 'x' } } : {}),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_INPUT' });
      expect(response.body).not.toContain('/private/secret-file.md');
      expect(response.body).not.toContain('cause');
    },
  );

  it('reports an IO write failure as internal error without exposing filesystem details', async () => {
    await fs.writeFile(join(root, agentSlugs[1] ?? ''), 'not a directory');
    const response = await request(app, {
      method: 'PUT',
      url: `/api/agents/${brokenId}/memory/MEMORY.md`,
      headers: { cookie },
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
