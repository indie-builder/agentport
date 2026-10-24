import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// 装好的 SDK 会 fork 一个 Claude Code 子进程；这里只把那个子进程换成假 Node 脚本，
// SDK 模块本身走真实代码，断言的是真实的 argv 与 initialize 控制帧，而不是中间层参数。
// shortcoming: 只覆盖 CLI 边界；模型调用、技能发现与 Skill 工具执行都在子进程侧，未验证。
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Boundary {
  argv: string[];
  initialize: Record<string, unknown>;
}

/**
 * SDK 对 .js/.mjs/.ts 结尾的可执行路径会拼成 `node <script> ...`，
 * 否则直接当原生二进制 spawn（无法注入假实现），所以假脚本必须带 .mjs 后缀。
 */
async function boundary(skills?: string[]): Promise<Boundary> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const dir = await mkdtemp(join(tmpdir(), 'sdk-skills-'));
  dirs.push(dir);
  const record = join(dir, 'record.jsonl');
  const fake = join(dir, 'fake-claude.mjs');
  await writeFile(
    fake,
    `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const record = ${JSON.stringify(record)};
const log = (entry) => appendFileSync(record, JSON.stringify(entry) + '\\n');
log({ argv: process.argv.slice(2) });
let exit;
const exited = new Promise((resolve) => { exit = resolve; });
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const message = JSON.parse(line);
  log({ stdin: message });
  if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } }) + '\\n');
  } else if (message.type === 'user') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake', mcp_servers: [] }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'fake', total_cost_usd: 0, modelUsage: {} }) + '\\n');
    rl.close();
    exit();
  }
}
await exited;
`,
  );

  const messages: unknown[] = [];
  for await (const message of query({
    prompt: 'hi',
    options: {
      cwd: dir,
      pathToClaudeCodeExecutable: fake,
      settingSources: [],
      allowedTools: [],
      disallowedTools: ['Read'],
      ...(skills === undefined ? {} : { skills }),
    },
  })) {
    messages.push(message);
  }
  expect(messages).toContainEqual(expect.objectContaining({ type: 'result', subtype: 'success' }));

  const entries = (await readFile(record, 'utf8'))
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as { argv?: string[]; stdin?: { request?: Record<string, unknown> } },
    );
  const argv = entries.find((entry) => entry.argv)?.argv ?? [];
  const initialize =
    entries.find((entry) => entry.stdin?.request?.subtype === 'initialize')?.stdin?.request ?? {};
  return { argv, initialize };
}

describe('installed SDK skills boundary', () => {
  it('turns an explicit skill into an exact Skill(name) rule and initialize allowlist', async () => {
    const { argv, initialize } = await boundary(['bound-skill']);

    expect(argv).toContain('--allowedTools=Skill(bound-skill)');
    expect(initialize).toMatchObject({ skills: ['bound-skill'] });
    expect(JSON.stringify({ argv, initialize })).not.toContain('Skill(*)');
    expect(JSON.stringify({ argv, initialize })).not.toContain('"Skill"');
  });

  it('keeps an empty list empty: no wildcard, no invented skill', async () => {
    const { argv, initialize } = await boundary([]);

    expect(argv.some((arg) => arg.includes('Skill'))).toBe(false);
    expect(initialize.skills).toEqual([]);
    expect(JSON.stringify({ argv, initialize })).not.toContain('bound-skill');
  });

  it('omits rules entirely when skills are not requested', async () => {
    const { argv, initialize } = await boundary();

    expect(argv.some((arg) => arg.includes('Skill'))).toBe(false);
    expect(initialize).not.toHaveProperty('skills');
  });
});
