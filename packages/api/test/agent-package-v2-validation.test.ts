import type { Agent, Skill } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

const rule = { slug: 'guide', content: 'Canonical rule.', globs: 'src/**' };
const style = {
  slug: 'brief',
  description: 'Brief answers',
  keepCodingInstructions: true,
  body: 'Canonical style.',
  isSelected: true,
};
const resource = { path: 'references/api.md', content: 'Canonical resource.' };

function packageV2() {
  const skillSlug = unique('v2-validation-skill');
  return {
    format: 'agentport/agent@2',
    agent: {
      slug: unique('v2-validation-root'),
      name: 'Validation root',
      systemPrompt: 'Canonical prompt.',
      skillSlugs: [skillSlug],
    },
    servers: [],
    rules: [{ ...rule }],
    outputStyles: [{ ...style }],
    skills: [
      {
        slug: skillSlug,
        name: 'Validation skill',
        description: 'Portable resource skill.',
        body: '# Canonical skill',
        files: [{ ...resource }],
      },
    ] satisfies [unknown],
    subAgents: [
      {
        slug: unique('v2-validation-child'),
        name: 'Validation child',
        skillSlugs: [skillSlug],
        rules: [{ ...rule }],
        outputStyles: [{ ...style }],
      },
    ] satisfies [unknown],
  };
}

type AgentPackage = ReturnType<typeof packageV2>;

const collisionCases = [
  ...['skill.md', 'SkIlL.mD', 'skill.md/child.md', 'SkIlL.mD/child.md'].map((path) => ({
    label: `reserved skill path ${path}`,
    paths: [path],
  })),
  { label: 'case-folded duplicate paths', paths: ['references/A.md', 'references/a.md'] },
  { label: 'case-folded ancestor first', paths: ['refs/A', 'refs/a/child.md'] },
  { label: 'case-folded descendant first', paths: ['refs/a/child.md', 'refs/A'] },
];

const invalidCases: Array<{ label: string; invalidate: (file: AgentPackage) => void }> = [
  ...collisionCases.map(({ label, paths }) => ({
    label,
    invalidate: (file: AgentPackage) => {
      file.skills[0].files = paths.map((path) => ({ path, content: 'Conflicting resource.' }));
    },
  })),
  { label: 'missing root rules', invalidate: (file) => Reflect.deleteProperty(file, 'rules') },
  {
    label: 'missing root output styles',
    invalidate: (file) => Reflect.deleteProperty(file, 'outputStyles'),
  },
  {
    label: 'missing child rules',
    invalidate: (file) => Reflect.deleteProperty(file.subAgents[0], 'rules'),
  },
  {
    label: 'missing child output styles',
    invalidate: (file) => Reflect.deleteProperty(file.subAgents[0], 'outputStyles'),
  },
  {
    label: 'missing skill files',
    invalidate: (file) => Reflect.deleteProperty(file.skills[0], 'files'),
  },
  { label: 'duplicate root rule slugs', invalidate: (file) => file.rules.push({ ...rule }) },
  {
    label: 'duplicate child rule slugs',
    invalidate: (file) => file.subAgents[0].rules.push({ ...rule }),
  },
  {
    label: 'duplicate style slugs',
    invalidate: (file) => file.outputStyles.push({ ...style, isSelected: false }),
  },
  {
    label: 'two selected root styles',
    invalidate: (file) => file.outputStyles.push({ ...style, slug: 'second' }),
  },
  {
    label: 'two selected child styles',
    invalidate: (file) => file.subAgents[0].outputStyles.push({ ...style, slug: 'second' }),
  },
  {
    label: 'duplicate skill file paths',
    invalidate: (file) =>
      file.skills[0].files.push({ ...resource, content: 'Conflicting content.' }),
  },
  ...['../outside.md', '/outside.md', 'SKILL.md', 'references/./api.md', 'references//api.md'].map(
    (path) => ({
      label: `unsafe skill path ${path}`,
      invalidate: (file: AgentPackage) => file.skills[0].files.push({ path, content: 'Unsafe.' }),
    }),
  ),
  {
    label: '51 root rules',
    invalidate: (file) => {
      file.rules = Array.from({ length: 51 }, (_, i) => ({ ...rule, slug: `rule-${i}` }));
    },
  },
  {
    label: '51 child rules',
    invalidate: (file) => {
      file.subAgents[0].rules = Array.from({ length: 51 }, (_, i) => ({
        ...rule,
        slug: `rule-${i}`,
      }));
    },
  },
  {
    label: '21 root styles',
    invalidate: (file) => {
      file.outputStyles = Array.from({ length: 21 }, (_, i) => ({
        ...style,
        slug: `style-${i}`,
        isSelected: false,
      }));
    },
  },
  {
    label: '21 child styles',
    invalidate: (file) => {
      file.subAgents[0].outputStyles = Array.from({ length: 21 }, (_, i) => ({
        ...style,
        slug: `style-${i}`,
        isSelected: false,
      }));
    },
  },
  {
    label: '51 skill files',
    invalidate: (file) => {
      file.skills[0].files = Array.from({ length: 51 }, (_, i) => ({
        path: `references/file-${i}.md`,
        content: 'Resource.',
      }));
    },
  },
];

describe.skipIf(!ready)('agent package v2 validation', () => {
  let app: FastifyInstance;
  let cookie: string;
  const agentSlugs: string[] = [];
  const skillSlugs: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    try {
      const targets = await app.pool.query<{ id: string }>(
        `select id from agents where slug = any($1::text[])
         union all
         select id from skills where slug = any($2::text[])`,
        [agentSlugs, skillSlugs],
      );
      await app.pool.query('delete from audit_log where target = any($1::text[])', [
        targets.rows.map(({ id }) => id),
      ]);
      await cleanup(app, { agentSlugs, skillSlugs });
    } finally {
      await app.close();
    }
  });

  function fixture() {
    const file = packageV2();
    agentSlugs.push(file.agent.slug, ...file.subAgents.map((agent) => agent.slug));
    skillSlugs.push(...file.skills.map((skill) => skill.slug));
    return file;
  }

  const importAgent = (payload: object) =>
    inject(app, { method: 'POST', url: '/api/import/agents', headers: { cookie }, payload });

  it.each(invalidCases)('rejects $label without partial writes', async ({ invalidate }) => {
    const file = fixture();
    invalidate(file);
    const response = await importAgent(file);
    expect(response.statusCode, response.body).toBe(400);
    expectProblem(response, 'INVALID_INPUT');

    const [agents, skills] = await Promise.all([
      inject(app, { method: 'GET', url: '/api/agents', headers: { cookie } }),
      inject(app, { method: 'GET', url: '/api/skills', headers: { cookie } }),
    ]);
    expect(agents.statusCode, agents.body).toBe(200);
    expect(skills.statusCode, skills.body).toBe(200);
    const ownAgents = [file.agent.slug, ...file.subAgents.map((agent) => agent.slug)];
    expect(agents.json<Agent[]>().filter((agent) => ownAgents.includes(agent.slug))).toEqual([]);
    expect(
      skills
        .json<Skill[]>()
        .filter((skill) => file.skills.some((entry) => entry.slug === skill.slug)),
    ).toEqual([]);
    const definitions = await app.pool.query(
      `select r.id from agent_rules r join agents a on a.id = r.agent_id where a.slug = any($1::text[])
       union all
       select o.id from agent_output_styles o join agents a on a.id = o.agent_id where a.slug = any($1::text[])
       union all
       select f.id from skill_files f join skills s on s.id = f.skill_id where s.slug = any($2::text[])`,
      [ownAgents, file.skills.map((skill) => skill.slug)],
    );
    expect(definitions.rows).toEqual([]);
  });

  it.each(collisionCases)('rejects stored $label on export', async ({ paths }) => {
    const file = fixture();
    const imported = await importAgent(file);
    expect(imported.statusCode, imported.body).toBe(201);
    const skill = await app.pool.query<{ id: string }>('select id from skills where slug = $1', [
      file.skills[0]?.slug,
    ]);
    const skillRow = skill.rows[0];
    if (!skillRow) throw new Error('imported skill missing');
    await app.pool.query('delete from skill_files where skill_id = $1', [skillRow.id]);
    for (const path of paths) {
      await app.pool.query(
        'insert into skill_files (id, skill_id, path, content) values ($1, $2, $3, $4)',
        [unique('collision-file'), skillRow.id, path, 'Conflicting resource.'],
      );
    }
    const exported = await inject(app, {
      method: 'GET',
      url: `/api/export/agents/${imported.json<{ agent: Agent }>().agent.id}`,
      headers: { cookie },
    });
    expect(exported.statusCode, exported.body).toBe(400);
    expectProblem(exported, 'INVALID_INPUT');
  });

  it('preserves spelling and content when only directory casing differs', async () => {
    const file = fixture();
    file.skills[0].files = [
      { path: 'Refs/B.md', content: 'Uppercase directory.\n' },
      { path: 'refs/A.md', content: 'Mixed-case filename.\n' },
    ];
    const imported = await importAgent(file);
    expect(imported.statusCode, imported.body).toBe(201);
    const exported = await inject(app, {
      method: 'GET',
      url: `/api/export/agents/${imported.json<{ agent: Agent }>().agent.id}`,
      headers: { cookie },
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.json<AgentPackage>().skills[0].files).toEqual(file.skills[0].files);
  });

  it('imports canonical v2 definitions and ignores conflicting workspace previews', async () => {
    const file = fixture();
    const imported = await importAgent({
      ...file,
      workspace: {
        claudeMd: 'UNTRUSTED preview prompt',
        rules: [{ slug: 'preview', content: 'UNTRUSTED preview rule' }],
        outputStyles: [{ slug: 'preview', content: 'UNTRUSTED preview style' }],
        selectedOutputStyle: 'preview',
        settingsJson: '{"outputStyle":"preview"}',
        skills: [
          {
            slug: file.skills[0].slug,
            content: 'UNTRUSTED preview skill',
            files: [{ path: '../outside.md', content: 'UNTRUSTED preview resource' }],
          },
        ],
      },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const exported = await inject(app, {
      method: 'GET',
      url: `/api/export/agents/${imported.json<{ agent: Agent }>().agent.id}`,
      headers: { cookie },
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const saved = exported.json<AgentPackage>();
    expect(saved.format).toBe('agentport/agent@2');
    expect(saved.agent.systemPrompt).toBe('Canonical prompt.');
    expect(saved.rules).toEqual(file.rules);
    expect(saved.outputStyles).toEqual(file.outputStyles);
    expect(saved.skills).toEqual(file.skills);
    expect(saved.subAgents).toMatchObject(file.subAgents);
    expect(exported.body).not.toContain('UNTRUSTED');
  });

  it('rejects a v2 body over 1 MiB before creating definitions', async () => {
    const file = fixture();
    const payload = JSON.stringify(file).padEnd(1_048_577, ' ');
    expect(Buffer.byteLength(payload, 'utf8')).toBe(1_048_577);
    const response = await inject(app, {
      method: 'POST',
      url: '/api/import/agents',
      headers: { cookie, 'content-type': 'application/json' },
      payload,
    });
    expectProblem(response, 'PAYLOAD_TOO_LARGE');
    const rows = await app.pool.query(
      'select id from agents where slug = any($1::text[]) union all select id from skills where slug = $2',
      [[file.agent.slug, file.subAgents[0].slug], file.skills[0].slug],
    );
    expect(rows.rows).toEqual([]);
  });

  it('still imports v1 packages without v2 definitions', async () => {
    const slug = unique('v1-validation-root');
    agentSlugs.push(slug);
    const response = await importAgent({
      format: 'agentport/agent@1',
      agent: { slug, name: 'Legacy root', systemPrompt: 'Legacy prompt.' },
      servers: [],
      skills: [],
    });
    expect(response.statusCode, response.body).toBe(201);
    const agent = response.json<{ agent: Agent }>().agent;
    const saved = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}`,
      headers: { cookie },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<Agent>()).toMatchObject({ slug, systemPrompt: 'Legacy prompt.' });
  });
});
