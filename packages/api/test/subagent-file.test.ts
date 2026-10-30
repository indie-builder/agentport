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

describe.skipIf(!ready)('subagent file download', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];

  const parentPrompt = 'PARENT-ONLY: orchestrate the children.';
  const childPrompt = 'LITERAL CHILD PROMPT: answer with the child answer.';

  let parent: Agent;
  let child: Agent;
  let foreignParent: Agent;
  let foreignChild: Agent;
  let disabledParent: Agent;
  let disabledChild: Agent;
  let standalone: Agent;

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);

    const auth = () => ({ cookie });
    const create = async (prefix: string, systemPrompt: string): Promise<Agent> => {
      const slug = unique(prefix);
      createdAgents.push(slug);
      const res = await inject(app, {
        method: 'POST',
        url: '/api/agents',
        headers: auth(),
        payload: { slug, name: `Agent ${slug}`, systemPrompt },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<Agent>();
    };
    const bind = async (owner: Agent, subAgentIds: string[]): Promise<void> => {
      const res = await inject(app, {
        method: 'PATCH',
        url: `/api/agents/${owner.id}`,
        headers: auth(),
        payload: { subAgentIds },
      });
      expect(res.statusCode, res.body).toBe(200);
    };

    parent = await create('parent', parentPrompt);
    child = await create('child', childPrompt);
    await bind(parent, [child.id]);

    foreignParent = await create('foreign-parent', 'foreign parent');
    foreignChild = await create('foreign-child', 'foreign child');
    await bind(foreignParent, [foreignChild.id]);

    disabledParent = await create('disabled-parent', 'disabled parent');
    disabledChild = await create('disabled-child', 'disabled child');
    await bind(disabledParent, [disabledChild.id]);
    const disabled = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${disabledChild.id}`,
      headers: auth(),
      payload: { enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);

    standalone = await create('standalone', 'standalone prompt');
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents });
    await app.close();
  });

  const auth = () => ({ cookie });
  const download = (parentId: string, childId: string, headers: Record<string, string> = auth()) =>
    inject(app, {
      method: 'GET',
      url: `/api/agents/${parentId}/subagents/${childId}/file`,
      headers,
    });

  it('returns the exact child file rendered for the parent workspace', async () => {
    const files = await inject(app, {
      method: 'GET',
      url: `/api/agents/${parent.id}/files`,
      headers: auth(),
    });
    expect(files.statusCode, files.body).toBe(200);
    const workspace = files.json<WorkspaceFiles>();
    const rendered = workspace.subAgents.find((subAgent) => subAgent.slug === child.slug);
    expect(rendered).toBeDefined();

    const res = await download(parent.id, child.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toBe(rendered?.content);

    // 内容来自子智能体自身定义：包含它的提示词与 slug，且没有父提示词。
    expect(res.body).toContain(childPrompt);
    expect(res.body).toContain(`name: "${child.slug}"`);
    expect(res.body).toContain('"Agent"');
    expect(res.body).toContain('memory: project');
    for (const tool of ['"Read"', '"Write"', '"Edit"']) expect(res.body).not.toContain(tool);
    expect(res.body).not.toContain(parentPrompt);
  });

  it('sets download headers for a quoted, schema-safe filename', async () => {
    const res = await download(parent.id, child.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${child.slug}.md"`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not mutate the stored agent', async () => {
    expect((await download(parent.id, child.id)).statusCode).toBe(200);
    const res = await inject(app, {
      method: 'GET',
      url: `/api/agents/${child.id}`,
      headers: auth(),
    });
    expect(res.json<Agent>()).toMatchObject({ slug: child.slug, systemPrompt: childPrompt });
  });

  it('requires auth', async () => {
    expectProblem(await download(parent.id, child.id, {}), 'UNAUTHORIZED');
  });

  it('returns 404 for missing, foreign, root and unrendered child ids', async () => {
    // 子智能体不存在
    expectProblem(await download(parent.id, 'agt_missing'), 'AGENT_NOT_FOUND');
    // 子智能体属于其他父智能体
    expectProblem(await download(parent.id, foreignChild.id), 'AGENT_NOT_FOUND');
    // childId 是父智能体自己
    expectProblem(await download(parent.id, parent.id), 'AGENT_NOT_FOUND');
    // 存在但没有被这个父智能体绑定
    expectProblem(await download(parent.id, standalone.id), 'AGENT_NOT_FOUND');
    // 绑定了，但工作区渲染里没有该文件（已停用的子智能体）
    expectProblem(await download(disabledParent.id, disabledChild.id), 'AGENT_NOT_FOUND');
    // 父智能体本身不存在
    expectProblem(await download('agt_missing', child.id), 'AGENT_NOT_FOUND');
  });

  it('imports a single official child file with project memory and renders it back', async () => {
    const importedSlug = unique('imported-child');
    createdAgents.push(importedSlug);
    const prompt = 'IMPORTED CHILD PROMPT: answer from the child.';
    const markdown = [
      '---',
      `name: ${importedSlug}`,
      'description: Imported child',
      'model: claude-sonnet-5-5',
      'memory: project',
      '---',
      '',
      prompt,
    ].join('\n');

    const imported = await inject(app, {
      method: 'POST',
      url: '/api/agents/import-file',
      headers: auth(),
      payload: { agentMd: markdown },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const importedAgent = imported.json<{ agent: Agent }>().agent;

    const bound = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${parent.id}`,
      headers: auth(),
      payload: { subAgentIds: [child.id, importedAgent.id] },
    });
    expect(bound.statusCode, bound.body).toBe(200);

    const res = await download(parent.id, importedAgent.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain(prompt);
    expect(res.body).toContain('memory: project');
  });

  it('rejects user/local memory scopes on single-file import', async () => {
    for (const scope of ['user', 'local']) {
      const res = await inject(app, {
        method: 'POST',
        url: '/api/agents/import-file',
        headers: auth(),
        payload: {
          agentMd: [
            '---',
            `name: ${unique(`memory-${scope}`)}`,
            'description: Scoped child',
            'model: claude-sonnet-5-5',
            `memory: ${scope}`,
            '---',
            '',
            'prompt',
          ].join('\n'),
        },
      });
      expectProblem(res, 'INVALID_INPUT');
    }
  });
});
