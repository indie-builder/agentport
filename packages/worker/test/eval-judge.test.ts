import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { type GradeDeps, gradeCase, type JudgeQueryFn } from '../src/eval-runner.js';

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
