import { readFile } from 'node:fs/promises';
import type { Agent, Skill, WorkspaceFiles } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('child skills in the rendered workspace', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];
  const createdSkills: string[] = [];

  let parent: Agent;
  let child: Agent;
  let disabledChild: Agent;
  let rootSkill: Skill;
  let childSkill: Skill;
  let sharedSkill: Skill;
  let disabledSkill: Skill;

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);

    const createSkill = async (prefix: string): Promise<Skill> => {
      const slug = unique(prefix);
      createdSkills.push(slug);
      const res = await inject(app, {
        method: 'POST',
        url: '/api/skills',
        headers: { cookie },
        payload: { slug, name: `Skill ${slug}`, description: `${prefix} 描述`, body: '步骤' },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<Skill>();
    };

    rootSkill = await createSkill('root-only');
    childSkill = await createSkill('child-only');
    sharedSkill = await createSkill('child-shared');
    disabledSkill = await createSkill('disabled-only');

    const newAgent = async (prefix: string, skillIds: string[]): Promise<Agent> =>
      (
        await createAgent(app, cookie, {
          slug: unique(prefix),
          skillIds,
          track: createdAgents,
        })
      ).json<Agent>();

    child = await newAgent('child', [childSkill.id, sharedSkill.id]);
    disabledChild = await newAgent('disabled-child', [disabledSkill.id]);
    const disabled = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${disabledChild.id}`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);

    parent = await newAgent('parent', [rootSkill.id]);
    const bind = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${parent.id}`,
      headers: { cookie },
      payload: { subAgentIds: [child.id, disabledChild.id] },
    });
    expect(bind.statusCode, bind.body).toBe(200);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents, skillSlugs: createdSkills });
    await app.close();
  });

  const auth = () => ({ cookie });
  const preview = () =>
    inject(app, { method: 'GET', url: `/api/agents/${parent.id}/files`, headers: auth() });

  it('unions enabled child skills into the workspace files', async () => {
    const res = await preview();
    expect(res.statusCode, res.body).toBe(200);
    const files = res.json<WorkspaceFiles>();
    const slugs = files.skills.map((skill) => skill.slug);

    expect(slugs).toContain(rootSkill.slug);
    expect(slugs).toContain(childSkill.slug);
    expect(slugs).toContain(sharedSkill.slug);
    // 停用子智能体的技能不落盘。
    expect(slugs).not.toContain(disabledSkill.slug);
    // 根智能体自己的技能排在前面。
    expect(slugs[0]).toBe(rootSkill.slug);
  });

  it('lists only its own skills in the parent prompt', async () => {
    const files = (await preview()).json<WorkspaceFiles>();
    expect(files.claudeMd).toContain(`\`${rootSkill.slug}\``);
    expect(files.claudeMd).not.toContain(`\`${childSkill.slug}\``);
    expect(files.claudeMd).not.toContain(`\`${sharedSkill.slug}\``);
    expect(files.claudeMd).not.toContain(`\`${disabledSkill.slug}\``);
  });

  it('declares only the child’s own skills in its agent file', async () => {
    const files = (await preview()).json<WorkspaceFiles>();
    const rendered = files.subAgents.find((subAgent) => subAgent.slug === child.slug);
    expect(rendered).toBeDefined();
    if (!rendered) return;

    const expected = [childSkill.slug, sharedSkill.slug].sort();
    expect(rendered.content).toContain(
      `skills: [${expected.map((slug) => `"${slug}"`).join(', ')}]`,
    );
    expect(rendered.content).not.toContain(rootSkill.slug);
    expect(rendered.content).not.toContain(disabledSkill.slug);
    // 停用子智能体不渲染文件。
    expect(files.subAgents.map((subAgent) => subAgent.slug)).not.toContain(disabledChild.slug);
  });

  it('downloads the child file byte-for-byte as previewed', async () => {
    const files = (await preview()).json<WorkspaceFiles>();
    const rendered = files.subAgents.find((subAgent) => subAgent.slug === child.slug);

    const res = await inject(app, {
      method: 'GET',
      url: `/api/agents/${parent.id}/subagents/${child.id}/file`,
      headers: auth(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toBe(rendered?.content);
    expect(res.body).toContain(childSkill.slug);
  });

  it('keeps preview behind auth', async () => {
    expectProblem(
      await inject(app, { method: 'GET', url: `/api/agents/${parent.id}/files` }),
      'UNAUTHORIZED',
    );
  });

  it('keeps the worker runtime on root skills and enriches children', async () => {
    const source = await readFile(new URL('../../worker/src/index.ts', import.meta.url), 'utf8');
    // 运行时的 Skill 白名单只来自根智能体。
    expect(source).toContain('skills: skillRows.map((skill) => skill.slug)');
    // 子智能体技能通过批量查询补齐后交给工作区渲染。
    expect(source).toContain('getBoundSkillsByAgentIds');
  });
});
