import type { Agent } from '@agentport/shared';
import { AGENT_PACKAGE_SIDECAR } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  expectProblem,
  infraReady,
  inject,
  injectZip,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';
import {
  type AgentSpec,
  type ChildSpec,
  type PackageSpec,
  packageZip,
  rawZip,
  type SkillSpec,
  sidecarOf,
  unzipPackage,
} from './package-fixtures.js';

const ready = await infraReady;

const rule = { slug: 'guide', content: 'Canonical rule.', globs: 'src/**' };
const style = {
  slug: 'brief',
  description: 'Brief answers',
  keepCodingInstructions: true,
  body: 'Canonical style.',
  isSelected: true,
};
const childStyle = {
  slug: 'child',
  description: '',
  keepCodingInstructions: false,
  body: 'Child style.',
  isSelected: true,
};
const resource = { path: 'references/api.md', content: 'Canonical resource.' };

describe.skipIf(!ready)('agent package validation (official files)', () => {
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

  interface Fixture {
    spec: PackageSpec;
    root: string;
    child: string;
    skill: string;
  }

  function fixture(): Fixture {
    const root = unique('pkgv-root');
    const child = unique('pkgv-child');
    const skillSlug = unique('pkgv-skill');
    agentSlugs.push(root, child);
    skillSlugs.push(skillSlug);
    const agent: AgentSpec = {
      slug: root,
      name: 'Validation root',
      systemPrompt: 'Canonical prompt.',
      skillSlugs: [skillSlug],
      effort: 'high',
    };
    const childAgent: ChildSpec = {
      slug: child,
      name: 'Validation child',
      systemPrompt: 'Child prompt.',
      skills: [skillSlug],
      rules: [{ slug: 'guide', content: 'Child rule.', globs: '' }],
      outputStyles: [childStyle],
    };
    const skill: SkillSpec = {
      slug: skillSlug,
      name: 'Validation skill',
      description: 'Portable resource skill.',
      body: '# Canonical skill',
      files: [resource],
    };
    return {
      root,
      child,
      skill: skillSlug,
      spec: {
        agent,
        servers: [],
        rules: [rule],
        outputStyles: [style],
        skills: [skill],
        subAgents: [childAgent],
      },
    };
  }

  const importZip = (zip: Buffer) => injectZip(app, 'POST', '/api/import/agents', cookie, zip);
  const importSpec = (spec: PackageSpec) => importZip(packageZip(spec));
  const exportFiles = async (id: string) => {
    const res = await injectZip(app, 'GET', `/api/export/agents/${id}`, cookie);
    expect(res.statusCode, res.body).toBe(200);
    return unzipPackage(res.rawPayload);
  };

  const assertNothingWritten = async (fixtureValue: Fixture) => {
    const [agents, skills] = await Promise.all([
      inject(app, { method: 'GET', url: '/api/agents', headers: { cookie } }),
      inject(app, { method: 'GET', url: '/api/skills', headers: { cookie } }),
    ]);
    const ownAgents = [fixtureValue.root];
    expect(agents.json<Agent[]>().filter((entry) => ownAgents.includes(entry.slug))).toEqual([]);
    expect(
      skills.json<Array<{ slug: string }>>().filter((entry) => entry.slug === fixtureValue.skill),
    ).toEqual([]);
    const definitions = await app.pool.query(
      `select r.id from agent_rules r join agents a on a.id = r.agent_id where a.slug = any($1::text[])
       union all
       select o.id from agent_output_styles o join agents a on a.id = o.agent_id where a.slug = any($1::text[])
       union all
       select f.id from skill_files f join skills s on s.id = f.skill_id where s.slug = any($2::text[])`,
      [ownAgents, [fixtureValue.skill]],
    );
    expect(definitions.rows).toEqual([]);
  };

  const invalidCases: Array<{
    label: string;
    build: (value: Fixture) => Buffer;
  }> = [
    ...[
      'skill.md',
      'SkIlL.mD',
      'skill.md/child.md',
      'references/A.md|references/a.md',
      'refs/A|refs/a/child.md',
      'refs/a/child.md|refs/A',
      '../outside.md',
      '/outside.md',
      'references/./api.md',
      'references//api.md',
    ].map((paths) => ({
      label: `unsafe skill resource paths ${paths}`,
      build: ({ spec, skill }: Fixture) => {
        // 直接构造归档：这些路径连合法的 ZIP 打包函数都不会接受。
        const files = unzipPackage(packageZip(spec));
        const base = `.claude/skills/${skill}/`;
        const extra = paths
          .split('|')
          .filter((path) => path !== resource.path)
          .map((path) => ({ name: `${base}${path}`, content: 'Conflicting resource.' }));
        return rawZip([
          ...[...files]
            .filter(([name]) => !name.startsWith(`${base}references/`))
            .map(([name, content]) => ({ name, content })),
          { name: `${base}references/api.md`, content: resource.content },
          ...extra,
        ]);
      },
    })),
    {
      label: 'sidecar with unsupported fields',
      build: ({ spec }: Fixture) => {
        const files = unzipPackage(packageZip(spec));
        const sidecar = sidecarOf(files);
        return rawZip(
          [...files].map(([name, content]) => ({
            name,
            content:
              name === AGENT_PACKAGE_SIDECAR
                ? `${JSON.stringify({ ...sidecar, rules: [] })}\n`
                : content,
          })),
        );
      },
    },
    {
      label: 'duplicate child rule slugs',
      build: ({ spec }: Fixture) => {
        const target = structuredClone(spec);
        target.subAgents[0]!.rules = [
          { slug: 'guide', content: 'a', globs: '' },
          { slug: 'guide', content: 'b', globs: '' },
        ];
        return packageZip(target);
      },
    },
    {
      label: 'duplicate child style slugs',
      build: ({ spec }: Fixture) => {
        const target = structuredClone(spec);
        target.subAgents[0]!.outputStyles = [childStyle, { ...childStyle, isSelected: false }];
        return packageZip(target);
      },
    },
    {
      label: 'two selected child styles',
      build: ({ spec }: Fixture) => {
        const target = structuredClone(spec);
        target.subAgents[0]!.outputStyles = [childStyle, { ...childStyle, slug: 'second' }];
        return packageZip(target);
      },
    },
    {
      label: 'settings referencing a missing style',
      build: ({ spec }: Fixture) => {
        const files = unzipPackage(packageZip(spec));
        return rawZip(
          [...files].map(([name, content]) => ({
            name,
            content: name === '.claude/settings.json' ? '{"outputStyle":"nope"}\n' : content,
          })),
        );
      },
    },
    {
      label: 'unsupported settings key',
      build: ({ spec }: Fixture) => {
        const files = unzipPackage(packageZip(spec));
        return rawZip(
          [...files].map(([name, content]) => ({
            name,
            content:
              name === '.claude/settings.json'
                ? '{"outputStyle":"brief","permissions":{"allow":["Bash"]}}\n'
                : content,
          })),
        );
      },
    },
    {
      label: '51 root rules',
      build: ({ spec }: Fixture) => {
        const target = structuredClone(spec);
        target.rules = Array.from({ length: 51 }, (_, index) => ({
          slug: `rule-${index}`,
          content: '',
          globs: '',
        }));
        return packageZip(target);
      },
    },
    {
      label: '21 root styles',
      build: ({ spec }: Fixture) => {
        const target = structuredClone(spec);
        target.outputStyles = Array.from({ length: 21 }, (_, index) => ({
          slug: `style-${index}`,
          description: '',
          keepCodingInstructions: false,
          body: '',
          isSelected: false,
        }));
        return packageZip(target);
      },
    },
    {
      label: '51 skill resources',
      build: ({ spec }: Fixture) => {
        const target = structuredClone(spec);
        target.skills[0]!.files = Array.from({ length: 51 }, (_, index) => ({
          path: `references/file-${index}.md`,
          content: 'Resource.',
        }));
        return packageZip(target);
      },
    },
  ];

  it.each(invalidCases)('rejects $label without partial writes', async ({ build }) => {
    const value = fixture();
    const response = await importZip(build(value));
    expect(response.statusCode, response.body).toBe(400);
    expectProblem(response, 'INVALID_INPUT');
    await assertNothingWritten(value);
  });

  it('exports only official definition files and keeps the sidecar body-free', async () => {
    const value = fixture();
    const imported = await importSpec(value.spec);
    expect(imported.statusCode, imported.body).toBe(201);
    const files = await exportFiles(imported.json<{ agent: Agent }>().agent.id);

    expect([...files.keys()].sort()).toEqual(
      [
        'CLAUDE.md',
        '.mcp.json',
        '.claude/settings.json',
        '.claude/rules/guide.md',
        '.claude/output-styles/brief.md',
        `.claude/skills/${value.skill}/SKILL.md`,
        `.claude/skills/${value.skill}/references/api.md`,
        `.claude/agents/${value.child}.md`,
        AGENT_PACKAGE_SIDECAR,
      ].sort(),
    );
    expect(files.get('CLAUDE.md')).toContain('Canonical prompt.');
    const sidecarText = files.get(AGENT_PACKAGE_SIDECAR) ?? '';
    // 子定义的规则/风格没有官方存放位置，只能作为平台元数据留在侧车；正文本身不复制。
    for (const body of [
      'Canonical prompt.',
      'Canonical rule.',
      '# Canonical skill',
      'Child prompt.',
    ]) {
      expect(sidecarText).not.toContain(body);
    }
    expect(JSON.parse(files.get('.claude/settings.json') ?? '{}')).toEqual({
      env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_TASKS: '0' },
      outputStyle: 'brief',
    });
  });

  it('preserves resource spelling and content when only directory casing differs', async () => {
    const value = fixture();
    value.spec.skills[0]!.files = [
      { path: 'Refs/B.md', content: 'Uppercase directory.\n' },
      { path: 'refs/A.md', content: 'Mixed-case filename.\n' },
    ];
    const imported = await importSpec(value.spec);
    expect(imported.statusCode, imported.body).toBe(201);
    const files = await exportFiles(imported.json<{ agent: Agent }>().agent.id);
    const base = `.claude/skills/${value.skill}/`;
    expect(files.get(`${base}Refs/B.md`)).toBe('Uppercase directory.\n');
    expect(files.get(`${base}refs/A.md`)).toBe('Mixed-case filename.\n');
  });

  it('rejects unknown paths and derived previews instead of silently ignoring them', async () => {
    const value = fixture();
    const files = packageZip(value.spec);
    const entries = unzipPackage(files);
    const withPreview = rawZip([
      ...[...entries].map(([name, content]) => ({ name, content })),
      { name: 'workspace/claudeMd.md', content: 'UNTRUSTED preview prompt' },
    ]);
    expectProblem(await importZip(withPreview), 'INVALID_INPUT');

    const sidecar = sidecarOf(entries);
    const tampered = rawZip(
      [...entries].map(([name, content]) => ({
        name,
        content:
          name === AGENT_PACKAGE_SIDECAR
            ? `${JSON.stringify({ ...sidecar, workspace: { claudeMd: 'UNTRUSTED' } })}\n`
            : content,
      })),
    );
    expectProblem(await importZip(tampered), 'INVALID_INPUT');
    await assertNothingWritten(value);
  });

  it('rejects a package body over the ZIP limit before creating definitions', async () => {
    const value = fixture();
    const payload = Buffer.concat([packageZip(value.spec), Buffer.alloc(1_048_577, 0x50)]);
    expectProblem(await importZip(payload), 'PAYLOAD_TOO_LARGE');
    await assertNothingWritten(value);
  });

  it('rejects a legacy JSON body and an unsupported content type', async () => {
    const legacy = await inject(app, {
      method: 'POST',
      url: '/api/import/agents',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        format: 'agentport/agent@2',
        agent: { slug: unique('pkgv-json'), name: 'Legacy' },
      },
    });
    expectProblem(legacy, 'INVALID_INPUT');

    const plain = await inject(app, {
      method: 'POST',
      url: '/api/import/agents',
      headers: { cookie, 'content-type': 'text/plain' },
      payload: 'not a zip',
    });
    expectProblem(plain, 'INVALID_INPUT');
  });

  it('keeps sub-agent rules and styles attached to the child definition', async () => {
    const value = fixture();
    const imported = await importSpec(value.spec);
    expect(imported.statusCode, imported.body).toBe(201);
    const body = imported.json<{ agent: Agent; createdSubAgents: string[] }>();
    const childId = (
      await app.pool.query<{ id: string }>('select id from agents where slug = $1', [
        body.createdSubAgents[0],
      ])
    ).rows[0]?.id;
    const childRules = await app.pool.query<{ content: string }>(
      'select content from agent_rules where agent_id = $1',
      [childId],
    );
    expect(childRules.rows.map((row) => row.content)).toEqual(['Child rule.']);
    const childStyles = await app.pool.query<{ body: string; is_selected: boolean }>(
      'select body, is_selected from agent_output_styles where agent_id = $1',
      [childId],
    );
    expect(childStyles.rows).toEqual([{ body: 'Child style.', is_selected: true }]);

    const rootRules = await app.pool.query<{ content: string }>(
      'select content from agent_rules where agent_id = $1',
      [body.agent.id],
    );
    expect(rootRules.rows.map((row) => row.content)).toEqual(['Canonical rule.']);
  });
});
