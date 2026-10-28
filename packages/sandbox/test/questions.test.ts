import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { createQuestionChannel } from '../src/questions.js';

const questions = [
  {
    question: '用哪种语言？',
    header: '语言',
    options: [
      { label: 'TypeScript', description: '默认选择' },
      { label: 'Python', description: '数据脚本' },
    ],
    multiSelect: false,
  },
];

/** 可控的 stdin 行队列：push 供测试写入，eof 模拟宿主关闭管道。 */
function stdin() {
  const lines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  return {
    readLine: (): Promise<string | null> =>
      new Promise((resolve) => {
        const line = lines.shift();
        if (line !== undefined) resolve(line);
        else if (closed) resolve(null);
        else waiters.push(resolve);
      }),
    push: (command: unknown): void => {
      const line = JSON.stringify(command);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    },
    eof: (): void => {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter(null);
    },
  };
}

function channel() {
  const input = stdin();
  const requested: Array<{ requestId: string; toolUseId: string; questions: unknown }> = [];
  const closed: string[] = [];
  const bridge = createQuestionChannel({
    readLine: input.readLine,
    events: {
      requested: (event) => requested.push(event),
      closed: (requestId) => closed.push(requestId),
    },
    log: () => undefined,
  });
  return { input, bridge, requested, closed };
}

function ask(
  canUseTool: CanUseTool,
  toolName = 'AskUserQuestion',
  toolInput: Record<string, unknown> = { questions },
  overrides: Partial<{
    requestId: string;
    toolUseID: string;
    agentID: string;
    signal: AbortSignal;
  }> = {},
) {
  const signal = overrides.signal ?? new AbortController().signal;
  return canUseTool(toolName, toolInput, {
    signal,
    toolUseID: overrides.toolUseID ?? 'tool-1',
    requestId: overrides.requestId ?? 'req-1',
    ...(overrides.agentID === undefined ? {} : { agentID: overrides.agentID }),
  });
}

describe('sandbox question channel', () => {
  it('surfaces the main-session question and returns answers with the original questions', async () => {
    const { input, bridge, requested, closed } = channel();
    const pending = ask(bridge.canUseTool);

    expect(requested).toEqual([{ requestId: 'req-1', toolUseId: 'tool-1', questions }]);
    input.push({
      type: 'question_response',
      requestId: 'req-1',
      response: { answers: { '用哪种语言？': 'TypeScript' } },
    });

    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { questions, answers: { '用哪种语言？': 'TypeScript' } },
    });
    // 已回答不是关闭：界面据 question_updated 更新，不需要关闭事件。
    expect(closed).toEqual([]);
    expect(bridge.pendingCount()).toBe(0);
  });

  it('fails closed for every tool that is not AskUserQuestion', async () => {
    const { bridge, requested } = channel();
    await expect(ask(bridge.canUseTool, 'Bash', { command: 'rm -rf /' })).resolves.toMatchObject({
      behavior: 'deny',
    });
    expect(requested).toEqual([]);
  });

  it('refuses questions from sub-agents', async () => {
    const { bridge, requested } = channel();
    await expect(
      ask(bridge.canUseTool, 'AskUserQuestion', { questions }, { agentID: 'sub' }),
    ).resolves.toMatchObject({ behavior: 'deny' });
    expect(requested).toEqual([]);
  });

  it('rejects a malformed question payload without surfacing it', async () => {
    const { bridge, requested } = channel();
    for (const toolInput of [
      { questions: [] },
      { questions: [{ ...questions[0], options: [{ label: '只有一个', description: '' }] }] },
      { questions: 'nope' },
    ]) {
      await expect(ask(bridge.canUseTool, 'AskUserQuestion', toolInput)).resolves.toMatchObject({
        behavior: 'deny',
      });
    }
    expect(requested).toEqual([]);
  });

  it('maps a decline to a deny and closes the card', async () => {
    const { input, bridge, closed } = channel();
    const pending = ask(bridge.canUseTool);
    input.push({ type: 'question_response', requestId: 'req-1', response: { decline: true } });

    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(closed).toEqual(['req-1']);
  });

  it.each([
    { label: 'missing keys', answers: { 别的问题: 'TypeScript' } },
    { label: 'extra keys', answers: { '用哪种语言？': 'TypeScript', 附加: 'x' } },
  ])('fails closed for answers that do not match the questions: $label', async ({ answers }) => {
    const { input, bridge, closed } = channel();
    const pending = ask(bridge.canUseTool);
    input.push({ type: 'question_response', requestId: 'req-1', response: { answers } });

    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(closed).toEqual(['req-1']);
  });

  it('ignores duplicate and late responses without touching a newer pending question', async () => {
    const { input, bridge, requested, closed } = channel();
    const first = ask(bridge.canUseTool);
    input.push({
      type: 'question_response',
      requestId: 'req-1',
      response: { answers: { '用哪种语言？': 'Python' } },
    });
    await first;

    // 迟到 / 重复：请求已结束，不能再触发事件或影响下一次提问。
    input.push({
      type: 'question_response',
      requestId: 'req-1',
      response: { answers: { '用哪种语言？': 'TypeScript' } },
    });
    const second = ask(bridge.canUseTool, 'AskUserQuestion', { questions }, { requestId: 'req-2' });
    expect(requested).toHaveLength(2);
    input.push({
      type: 'question_response',
      requestId: 'req-2',
      response: { answers: { '用哪种语言？': 'Python' } },
    });
    await expect(second).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { '用哪种语言？': 'Python' } },
    });
    expect(closed).toEqual([]);
  });

  it('closes a pending question when the SDK aborts it', async () => {
    const { bridge, closed } = channel();
    const controller = new AbortController();
    const pending = ask(
      bridge.canUseTool,
      'AskUserQuestion',
      { questions },
      {
        signal: controller.signal,
      },
    );
    controller.abort();

    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(closed).toEqual(['req-1']);
    expect(bridge.pendingCount()).toBe(0);
  });

  it('closes pending questions on stdin EOF so the tool never hangs', async () => {
    const { input, bridge, closed } = channel();
    const pending = ask(bridge.canUseTool);
    input.eof();

    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(closed).toEqual(['req-1']);
  });

  it('closes pending questions on final cleanup', async () => {
    const { bridge, closed } = channel();
    const pending = ask(bridge.canUseTool);
    bridge.close();

    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(closed).toEqual(['req-1']);
    // 关闭后不再接受新提问。
    await expect(
      ask(bridge.canUseTool, 'AskUserQuestion', { questions }, { requestId: 'req-2' }),
    ).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('ignores malformed stdin lines and keeps waiting for a valid response', async () => {
    const { input, bridge } = channel();
    const pending = ask(bridge.canUseTool);
    input.push({ type: 'question_response', requestId: 'req-1' });
    input.push({
      type: 'question_response',
      requestId: 'req-1',
      response: { answers: { '用哪种语言？': 'TypeScript' } },
    });

    await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
  });
});
