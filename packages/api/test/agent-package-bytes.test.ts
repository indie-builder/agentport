import { AGENT_PACKAGE_MAX_BYTES, serializeAgentPackage } from '@agentport/shared';
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

interface AgentExportFile {
  format: string;
  agent: { slug: string; systemPrompt: string };
  skills: Array<{ slug: string; name: string; description: string; body: string }>;
  workspace: { claudeMd: string; skills: Array<{ slug: string; content: string }> };
}

describe.skipIf(!ready)('agent package bytes', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];
  const createdSkills: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents, skillSlugs: createdSkills });
    await app.close();
  });

  const auth = () => ({ cookie });
  const exportAgent = (id: string) =>
    inject(app, { method: 'GET', url: `/api/export/agents/${id}`, headers: auth() });
  // payload 是原始字符串：这里要测的是 Fastify 在解析前按字节拒绝。
  const importRaw = (payload: string) =>
    inject(app, {
      method: 'POST',
      url: '/api/import/agents',
      headers: { ...auth(), 'content-type': 'application/json' },
      payload,
    });

  it('exports a pretty package that re-imports unchanged', async () => {
    const slug = unique('pkg-small');
    const skillSlug = unique('pkg-skill');
    const prompt = '你是助手。\n包含 "引号"、\\反斜杠 与 🚀\n第二行';

    const skill = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: auth(),
      payload: {
        slug: skillSlug,
        name: '包技能',
        description: '包含 "引号"',
        body: '# 步骤\n\n第一行 "x"\n第二行',
      },
    });
    expect(skill.statusCode, skill.body).toBe(201);
    createdSkills.push(skillSlug);

    const created = await createAgent(app, cookie, { slug, track: createdAgents });
    const agentId = created.json<{ id: string }>().id;
    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(),
      payload: { systemPrompt: prompt, skillIds: [skill.json<{ id: string }>().id] },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const exp = await exportAgent(agentId);
    expect(exp.statusCode, exp.body).toBe(200);
    expect(exp.headers['content-type']).toMatch(/^application\/json/);
    expect(exp.headers['content-disposition']).toBe(`attachment; filename="${slug}.agent.json"`);
    expect(exp.headers['cache-control']).toBe('no-store');
    expect(exp.headers['x-content-type-options']).toBe('nosniff');

    // 与浏览器下载到的字节一致：同一序列化函数，缩进不会让包体超出上限。
    expect(Buffer.byteLength(exp.body, 'utf8')).toBeLessThanOrEqual(AGENT_PACKAGE_MAX_BYTES);
    const file = JSON.parse(exp.body) as AgentExportFile;
    expect(exp.body).toBe(serializeAgentPackage(file));
    expect(file.agent.slug).toBe(slug);
    expect(file.agent.systemPrompt).toBe(prompt);
    expect(file.skills).toEqual([
      {
        slug: skillSlug,
        name: '包技能',
        description: '包含 "引号"',
        body: '# 步骤\n\n第一行 "x"\n第二行',
      },
    ]);
    // 工作区预览必须保留，不能为了压字节把它丢掉。
    expect(file.workspace.claudeMd).toContain(prompt);
    expect(file.workspace.skills.map((entry) => entry.slug)).toEqual([skillSlug]);

    // 原始导出字节直接回传（含 workspace，由导入 schema 丢弃）必须能再次导入。
    const reimport = await importRaw(exp.body);
    expect(reimport.statusCode, reimport.body).toBe(201);
    const result = reimport.json<{ agent: { slug: string }; warnings: string[] }>();
    createdAgents.push(result.agent.slug);
    expect(result.agent.slug).toBe(`${slug}-2`);
    expect(result.warnings.some((warning) => warning.includes(`导入为 "${slug}-2"`))).toBe(true);
  });

  it('rejects an export over 1 MiB instead of truncating it', async () => {
    const slug = unique('pkg-big');
    const created = await createAgent(app, cookie, { slug, track: createdAgents });
    // 600 KiB（UTF-8）的提示词会同时出现在 agent 与 workspace.claudeMd，导出约 1.2 MiB；
    // PATCH 本身仍在上限内，所以只能靠导出端拦截。
    const prompt = '提'.repeat(200_000);
    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${created.json<{ id: string }>().id}`,
      headers: auth(),
      payload: { systemPrompt: prompt },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const exp = await exportAgent(created.json<{ id: string }>().id);
    const problem = expectProblem(exp, 'CONFLICT');
    expect(problem.message).toBe('专家包超过 1 MiB，请减少提示词、技能或工具定义后重试');
  });

  it('accepts an import body of exactly 1 MiB and rejects one byte more', async () => {
    const exactSlug = unique('pkg-exact');
    const exactBase = JSON.stringify({
      format: 'agentport/agent@1',
      agent: { slug: exactSlug, name: 'Exact' },
    });
    // 顶层值之后的空白是合法 JSON，用来把字节数精确顶到上限。
    const exact = exactBase.padEnd(
      exactBase.length + AGENT_PACKAGE_MAX_BYTES - Buffer.byteLength(exactBase, 'utf8'),
      ' ',
    );
    expect(Buffer.byteLength(exact, 'utf8')).toBe(AGENT_PACKAGE_MAX_BYTES);

    const accepted = await importRaw(exact);
    expect(accepted.statusCode, accepted.body).toBe(201);
    createdAgents.push(accepted.json<{ agent: { slug: string } }>().agent.slug);

    const overSlug = unique('pkg-over');
    const overBase = JSON.stringify({
      format: 'agentport/agent@1',
      agent: { slug: overSlug, name: 'Over' },
    });
    const over = overBase.padEnd(
      overBase.length + AGENT_PACKAGE_MAX_BYTES + 1 - Buffer.byteLength(overBase, 'utf8'),
      ' ',
    );
    expect(Buffer.byteLength(over, 'utf8')).toBe(AGENT_PACKAGE_MAX_BYTES + 1);

    const rejected = await importRaw(over);
    expectProblem(rejected, 'PAYLOAD_TOO_LARGE');
    const rows = await app.pool.query('select 1 from agents where slug = $1', [overSlug]);
    expect(rows.rows).toHaveLength(0);
  });
});
