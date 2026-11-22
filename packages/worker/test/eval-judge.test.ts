import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  type GradeDeps,
  gradeCase,
  gradeTrajectory,
  type JudgeQueryFn,
  messagesForRun,
} from '../src/eval-runner.js';

let knowledgeDir = '';

beforeEach(async () => {
  knowledgeDir = await mkdtemp(join(tmpdir(), 'eval-judge-'));
});

afterEach(async () => {
  await rm(knowledgeDir, { recursive: true, force: true });
});

function replyQuery(result: string): JudgeQueryFn {
  return () =>
    (async function* (): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result,
      } as unknown as SDKMessage;
    })();
}

function deps(queryFn: JudgeQueryFn): GradeDeps {
  return { model: 'judge-test', knowledgeDir, anthropicBaseUrl: undefined, queryFn };
}

describe('gradeTrajectory', () => {
  it('通过：期望工具全部出现且没有禁止工具', () => {
    expect(
      gradeTrajectory(
        { expectedTools: ['Read', 'mcp__knowledge__search'], forbiddenTools: ['Bash'] },
        ['Read', 'mcp__knowledge__search', 'Write'],
      ),
    ).toEqual({ passed: true, reason: null });
  });

  it('不通过：缺少期望工具', () => {
    const result = gradeTrajectory({ expectedTools: ['Read', 'Bash'] }, ['Read']);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('缺少期望工具: Bash');
  });

  it('不通过：出现禁止工具', () => {
    const result = gradeTrajectory({ forbiddenTools: ['Bash'] }, ['Read', 'Bash']);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('出现禁止工具: Bash');
  });

  it('通过：未配置任何工具约束', () => {
    expect(gradeTrajectory({}, ['Bash'])).toEqual({ passed: true, reason: null });
    expect(gradeTrajectory({ expectedTools: [], forbiddenTools: [] }, ['Bash'])).toEqual({
      passed: true,
      reason: null,
    });
  });
});

describe('messagesForRun', () => {
  it('只保留当前 run 的消息，排除同会话后续轮次', () => {
    const messages = [
      { runId: 'run-a', role: 'assistant', content: { type: 'text', text: 'a' } },
      { runId: 'run-b', role: 'assistant', content: { type: 'text', text: 'b' } },
      { runId: 'run-a', role: 'tool', content: { type: 'tool_use', name: 'Read' } },
      { runId: 'run-b', role: 'tool', content: { type: 'tool_use', name: 'Bash' } },
      { runId: null, role: 'assistant', content: { type: 'text', text: 'legacy' } },
    ];
    expect(messagesForRun(messages, 'run-a')).toEqual([messages[0], messages[2]]);
  });
});

describe('gradeCase', () => {
  it('contains 模式沿用子串判定', async () => {
    const hit = await gradeCase(deps(replyQuery('')), {
      prompt: 'prompt',
      output: 'Hello World',
      expectation: 'hello',
      judgeMode: 'contains',
    });
    expect(hit).toEqual({ passed: true, reason: null });

    const miss = await gradeCase(deps(replyQuery('')), {
      prompt: 'prompt',
      output: 'Hello World',
      expectation: 'goodbye',
      judgeMode: 'contains',
    });
    expect(miss).toEqual({ passed: false, reason: null });
  });

  it('llm 模式使用模型结论与理由', async () => {
    const pass = await gradeCase(deps(replyQuery('```json\n{"pass":true,"reason":"ok"}\n```')), {
      prompt: 'prompt',
      output: 'answer',
      expectation: '通过条件',
      judgeMode: 'llm',
    });
    expect(pass).toEqual({ passed: true, reason: 'ok' });

    const fail = await gradeCase(deps(replyQuery('{"pass":false,"reason":"no"}')), {
      prompt: 'prompt',
      output: 'answer',
      expectation: '通过条件',
      judgeMode: 'llm',
    });
    expect(fail).toEqual({ passed: false, reason: 'no' });
  });

  it('llm 模式响应不是合法 JSON 时判为不通过并给出理由', async () => {
    const result = await gradeCase(deps(replyQuery('not json')), {
      prompt: 'prompt',
      output: 'answer',
      expectation: '通过条件',
      judgeMode: 'llm',
    });
    expect(result.passed).toBe(false);
    expect(result.reason?.length ?? 0).toBeGreaterThan(0);
  });

  it('llm 模式把判分提示词直接交给 SDK', async () => {
    let sent = '';
    const queryFn: JudgeQueryFn = (params) => {
      sent = params.prompt;
      return replyQuery('{"pass":true,"reason":"ok"}')(params);
    };
    const result = await gradeCase(deps(queryFn), {
      prompt: 'prompt',
      output: 'answer',
      expectation: '通过条件',
      judgeMode: 'llm',
    });
    expect(result).toEqual({ passed: true, reason: 'ok' });
    expect(sent).toContain('answer');
    expect(sent).toContain('通过条件');
  });

  it('llm 模式发送前对判分提示词脱敏', async () => {
    const secret = `sk-live-eval-judge-${crypto.randomUUID()}`;
    let sent = '';
    const queryFn: JudgeQueryFn = (params) => {
      sent = params.prompt;
      return replyQuery('{"pass":true,"reason":"ok"}')(params);
    };
    const result = await gradeCase(deps(queryFn), {
      prompt: `prompt ${secret}`,
      output: `answer ${secret}`,
      expectation: '通过条件',
      judgeMode: 'llm',
    });
    expect(result).toEqual({ passed: true, reason: 'ok' });
    expect(sent).not.toContain(secret);
    expect(sent).toContain('sk-l***');
  });

  it('flags an aborted judge as cancelled only when the caller signal aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await gradeCase(
      { ...deps(replyQuery('{"pass":true,"reason":"ok"}')), signal: controller.signal },
      {
        prompt: 'prompt',
        output: 'answer',
        expectation: '通过条件',
        judgeMode: 'llm',
      },
    );
    expect(result).toEqual({ passed: false, reason: '评判已取消' });
  });
});
