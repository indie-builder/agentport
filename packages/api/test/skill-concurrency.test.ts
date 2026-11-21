import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Skill } from '@agentport/shared';
import {
  cleanup,
  expectProblem,
  infraReady,
  loginCookie,
  request,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('skill update concurrency', () => {
  let app: TestApp;
  let cookie: string;
  const createdSkills: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { skillSlugs: createdSkills });
    await app.close();
  });

  const createSkill = async (): Promise<Skill> => {
    const slug = unique('stale-skill');
    createdSkills.push(slug);
    const res = await request(app, {
      method: 'POST',
      url: '/api/skills',
      headers: { cookie },
      payload: { slug, name: `Skill ${slug}`, description: 'version guard', body: 'original' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Skill>();
  };

  const patch = (id: string, payload: Record<string, unknown>) =>
    request(app, {
      method: 'PATCH',
      url: `/api/skills/${id}`,
      headers: { cookie },
      payload,
    });

  const get = async (id: string): Promise<Skill> => {
    const res = await request(app, {
      method: 'GET',
      url: `/api/skills/${id}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Skill>();
  };

  it('applies an update and advances updatedAt', async () => {
    const skill = await createSkill();

    const res = await patch(skill.id, {
      name: 'Renamed',
      expectedUpdatedAt: skill.updatedAt,
    });
    expect(res.statusCode, res.body).toBe(200);
    const updated = res.json<Skill>();
    expect(updated.name).toBe('Renamed');
    expect(updated.updatedAt).not.toBe(skill.updatedAt);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
      new Date(skill.updatedAt).getTime(),
    );

    expect(await get(skill.id)).toMatchObject({ name: 'Renamed' });
  });

  it('rejects a stale update without touching the stored skill', async () => {
    const skill = await createSkill();
    const first = await patch(skill.id, { name: 'First', expectedUpdatedAt: skill.updatedAt });
    expect(first.statusCode, first.body).toBe(200);

    const stale = await patch(skill.id, { name: 'Second', expectedUpdatedAt: skill.updatedAt });
    expectProblem(stale, 'CONFLICT_STALE');
    expect(await get(skill.id)).toMatchObject({ name: 'First', body: 'original' });
  });

  it('accepts each returned updatedAt immediately, without waits', async () => {
    const skill = await createSkill();
    let version = skill.updatedAt;

    for (let i = 0; i < 5; i += 1) {
      const res = await patch(skill.id, { name: `Round ${i}`, expectedUpdatedAt: version });
      expect(res.statusCode, res.body).toBe(200);
      const next = res.json<Skill>();
      expect(new Date(next.updatedAt).getTime()).toBeGreaterThan(new Date(version).getTime());
      version = next.updatedAt;
    }

    expect(await get(skill.id)).toMatchObject({ name: 'Round 4' });
  });

  it('returns 404 for a missing skill even when a version is supplied', async () => {
    const missing = await patch('skill_missing', {
      name: 'x',
      expectedUpdatedAt: new Date().toISOString(),
    });
    expectProblem(missing, 'NOT_FOUND');
  });

  it('rejects a malformed expectedUpdatedAt', async () => {
    const skill = await createSkill();

    const res = await patch(skill.id, { name: 'Nope', expectedUpdatedAt: 'not-a-date' });
    expectProblem(res, 'INVALID_INPUT');
    expect(await get(skill.id)).toMatchObject({ name: `Skill ${skill.slug}` });
  });

  it('keeps older clients working when expectedUpdatedAt is omitted', async () => {
    const skill = await createSkill();

    const res = await patch(skill.id, { name: 'Untracked', expectedUpdatedAt: undefined });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<Skill>().name).toBe('Untracked');

    const stale = await patch(skill.id, { name: 'Late', expectedUpdatedAt: skill.updatedAt });
    expectProblem(stale, 'CONFLICT_STALE');
  });

  it('patches only the fields that were supplied', async () => {
    const skill = await createSkill();

    const res = await patch(skill.id, {
      name: 'Only Name',
      id: 'skill_hijacked',
      createdAt: '2000-01-01T00:00:00.000Z',
      expectedUpdatedAt: skill.updatedAt,
    });
    expect(res.statusCode, res.body).toBe(200);
    const updated = res.json<Skill>();
    expect(updated).toMatchObject({
      id: skill.id,
      createdAt: skill.createdAt,
      name: 'Only Name',
      slug: skill.slug,
      description: skill.description,
      body: skill.body,
    });
  });

  it('lets exactly one of two concurrent updates with the same version win', async () => {
    const skill = await createSkill();
    const expectedUpdatedAt = skill.updatedAt;

    const [a, b] = await Promise.all([
      patch(skill.id, { name: 'Concurrent A', expectedUpdatedAt }),
      patch(skill.id, { name: 'Concurrent B', expectedUpdatedAt }),
    ]);

    const statuses = [a.statusCode, b.statusCode].sort((x, y) => x - y);
    expect(statuses, `${a.body} / ${b.body}`).toEqual([200, 409]);
    const winner = a.statusCode === 200 ? a : b;
    const loser = a.statusCode === 200 ? b : a;
    expectProblem(loser, 'CONFLICT_STALE');

    expect(await get(skill.id)).toMatchObject({ name: winner.json<Skill>().name });
  });

  it('requires auth to update', async () => {
    const skill = await createSkill();
    const res = await request(app, {
      method: 'PATCH',
      url: `/api/skills/${skill.id}`,
      payload: { name: 'Anon', expectedUpdatedAt: skill.updatedAt },
    });
    expectProblem(res, 'UNAUTHORIZED');
  });
});
