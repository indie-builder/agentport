import type { Agent, WorkspaceFiles } from '@agentport/shared';
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

interface AgentMdImportResult {
  agent: Agent;
  warnings: string[];
}

describe.skipIf(!ready)('agent.md import', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents });
    await app.close();
  });

  const auth = () => ({ cookie });
  const importFile = (agentMd: string) =>
    inject(app, {
      method: 'POST',
      url: '/api/agents/import-file',
      headers: auth(),
      payload: { agentMd },
    });

  const agentMd = (slug: string, extra: string[] = []) =>
    [
      '---',
      `name: ${slug}`,
      'description: Reviews pull requests',
      ...extra,
      '---',
      '',
      '# Reviewer',
      '',
      'You review pull requests carefully.',
      '',
      '## Rules',
      '',
      '1. Read the diff first.',
    ].join('\n');

  const agentSlugs = async (): Promise<string[]> => {
    const res = await inject(app, { method: 'GET', url: '/api/agents', headers: auth() });
    expect(res.statusCode).toBe(200);
    return res.json<Agent[]>().map((agent) => agent.slug);
  };

  it('imports a role definition as a standalone agent with platform defaults', async () => {
    const slug = unique('md-import');
    createdAgents.push(slug);

    const res = await importFile(agentMd(slug));
    expect(res.statusCode, res.body).toBe(201);
    const { agent, warnings } = res.json<AgentMdImportResult>();

    // 正文整段保留（含 H1），不做技能式的标题剥离。
    const systemPrompt =
      '# Reviewer\n\nYou review pull requests carefully.\n\n## Rules\n\n1. Read the diff first.';
    expect(agent).toMatchObject({
      slug,
      name: slug,
      description: 'Reviews pull requests',
      systemPrompt,
      model: 'claude-sonnet-5-5',
      maxTurns: 20,
      permissionMode: 'dontAsk',
      serverIds: [],
      skillIds: [],
      subAgentIds: [],
      parentId: null,
    });
    expect(warnings.length).toBeGreaterThan(0);

    const versions = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/versions`,
      headers: auth(),
    });
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json<Array<{ version: number }>>().map((v) => v.version)).toEqual([1]);

    const files = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/files`,
      headers: auth(),
    });
    expect(files.statusCode, files.body).toBe(200);
    const rendered = files.json<WorkspaceFiles>();
    expect(rendered.claudeMd).toContain(systemPrompt);
  });

  it('rejects a duplicate slug and leaves the original unchanged', async () => {
    const slug = unique('md-duplicate');
    createdAgents.push(slug);

    const first = await importFile(agentMd(slug));
    expect(first.statusCode, first.body).toBe(201);
    const original = first.json<AgentMdImportResult>().agent;

    const duplicate = await importFile(agentMd(slug, ['maxTurns: 3']));
    expectProblem(duplicate, 'CONFLICT');

    const loaded = await inject(app, {
      method: 'GET',
      url: `/api/agents/${original.id}`,
      headers: auth(),
    });
    expect(loaded.statusCode, loaded.body).toBe(200);
    expect(loaded.json<Agent>().systemPrompt).toBe(original.systemPrompt);
  });

  it('rejects malformed, unsupported or risky definitions without inserting anything', async () => {
    const rejectedSlugs = [
      unique('md-hooks'),
      unique('md-tools'),
      unique('md-inherit'),
      unique('md-nodesc'),
      unique('md-nobody'),
      unique('md-big'),
    ];
    const [hooks, tools, inherit, nodesc, nobody, big] = rejectedSlugs as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const cases: Array<[string, string]> = [
      ['missing frontmatter', '# Reviewer\n\nJust markdown.'],
      ['invalid yaml', '---\nname: [unclosed\ndescription: x\n---\n\nBody'],
      ['hooks field', agentMd(hooks, ['hooks:', '  PreToolUse:', '    - command: rm -rf /'])],
      ['tools field', agentMd(tools, ['tools: Bash, Read'])],
      ['inherit model', agentMd(inherit, ['model: inherit'])],
      ['missing description', `---\nname: ${nodesc}\n---\n\nBody`],
      ['missing name', '---\ndescription: no name\n---\n\nBody'],
      ['empty body', `---\nname: ${nobody}\ndescription: no body\n---\n\n`],
      ['oversize', `${agentMd(big)}\n${'x'.repeat(131_072)}`],
    ];
    for (const [label, markdown] of cases) {
      const res = await importFile(markdown);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(400);
      expectProblem(res, 'INVALID_INPUT');
    }
    // 只断言这些文件里的 slug 没落库：并行测试文件会同时创建其他智能体。
    const listed = await agentSlugs();
    expect(listed.filter((slug) => rejectedSlugs.includes(slug))).toEqual([]);
  });

  it('requires auth to import', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/agents/import-file',
      payload: { agentMd: agentMd(unique('md-anon')) },
    });
    expectProblem(res, 'UNAUTHORIZED');
  });
});
