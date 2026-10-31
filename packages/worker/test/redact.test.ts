import { publicRunQuestion, redactChatEvent, redactJson, redactSecrets } from '@agentport/shared';
import { describe, expect, it } from 'vitest';

describe('redactSecrets', () => {
  it('masks bearer tokens but keeps the scheme', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop1234')).toBe(
      'Authorization: Bearer abcd***',
    );
  });

  it('masks provider keys', () => {
    expect(redactSecrets('key sk-projAbCdEf0123456789xyz')).toBe('key sk-p***');
    expect(redactSecrets('ghp_abcdefghijklmnopqrstuvwx')).toBe('ghp_***');
  });

  it('masks KEY=value regardless of case', () => {
    expect(redactSecrets('DATABASE_PASSWORD=hunter2')).toBe('DATABASE_PASSWORD=hunt***');
    expect(redactSecrets('client_secret="abcdefgh"')).toBe('client_secret="abcd***"');
    expect(redactSecrets('MY_API_KEY=abc')).toBe('MY_API_KEY=***');
  });

  it('masks long random base64url strings', () => {
    const token = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF3gH5';
    expect(redactSecrets(`token: ${token}`)).toBe('token: aB3d***');
  });

  it('leaves UUIDs, hashes and normal text alone', () => {
    const text =
      'run 3f2c1a9e-8b7d-4c6e-9f0a-1b2c3d4e5f60 exited, sha 0123456789abcdef0123456789abcdef';
    expect(redactSecrets(text)).toBe(text);
  });

  it('masks every occurrence, not just the first', () => {
    expect(redactSecrets('sk-aaaaaaaaaaaaaaaaaaaa sk-bbbbbbbbbbbbbbbbbbbb')).toBe(
      'sk-a*** sk-b***',
    );
  });

  it('masks the token after a repeated Bearer word instead of consuming it', () => {
    expect(redactSecrets('Bearer Bearer abcdefgh')).toBe('Bearer Bearer abcd***');
    // 阈值不变：第二个词本身不足 8 位时仍原样保留。
    expect(redactSecrets('Bearer Bearer abcdefg')).toBe('Bearer Bearer abcdefg');
    // 只有 Bearer 的词类会吞下相邻前缀；provider 前缀不跨空白消费。
    expect(redactSecrets('sk- sk-abcdefghijklmnopqrst')).toBe('sk- sk-a***');
  });

  it('masks a multi-megabyte token behind a repeated Bearer word', () => {
    const chunk = 'x'.repeat(7_000_000);
    expect(redactSecrets(`Bearer Bearer ${chunk}`)).toBe('Bearer Bearer xxxx***');
  });

  it('handles multi-megabyte contiguous tokens without overflowing', () => {
    const chunk = 'x'.repeat(7_000_000);
    // 连续长串本身不是密钥：不能因为长度让整个脱敏抛栈溢出。
    expect(redactSecrets(chunk)).toBe(chunk);
    expect(redactSecrets(`Bearer ${chunk}`)).toBe('Bearer xxxx***');
    expect(redactSecrets(`sk-${chunk}`)).toBe('sk-x***');
    expect(redactSecrets(`aB3${chunk}`)).toBe('aB3x***');
  });

  it('is a no-op without secrets', () => {
    expect(redactSecrets('sandbox exited with code 1')).toBe('sandbox exited with code 1');
  });
});

describe('redactJson', () => {
  it('redacts string values without consuming the JSON closing quote', () => {
    const raw = JSON.stringify({ cmd: 'export PASSWORD=hunter2', list: ['TOKEN=abcdef'] });
    const redacted = redactJson(raw);
    expect(JSON.parse(redacted)).toEqual({
      cmd: 'export PASSWORD=hunt***',
      list: ['TOKEN=abcd***'],
    });
  });

  it('falls back to text redaction for truncated JSON', () => {
    expect(redactJson('{"cmd":"export PASSWORD=hunter2')).toBe('{"cmd":"export PASSWORD=hunt***');
  });
});

describe('redactChatEvent', () => {
  const secret = 'sk-abcdefghijklmnop';

  it('redacts every native text field', () => {
    expect(redactChatEvent({ type: 'assistant_text', text: `x ${secret}` })).toMatchObject({
      text: 'x sk-a***',
    });
    expect(redactChatEvent({ type: 'text_delta', text: `x ${secret}` })).toMatchObject({
      text: 'x sk-a***',
    });
    expect(redactChatEvent({ type: 'error', message: `x ${secret}` })).toMatchObject({
      message: 'x sk-a***',
    });
    expect(redactChatEvent({ type: 'run_unavailable', message: `x ${secret}` })).toMatchObject({
      message: 'x sk-a***',
    });
    expect(
      redactChatEvent({ type: 'run_finished', status: 'failed', error: `x ${secret}` }),
    ).toMatchObject({ error: 'x sk-a***' });
    expect(
      redactChatEvent({
        type: 'tool_result',
        toolUseId: 't',
        content: `x ${secret}`,
        todos: [{ content: `x ${secret}`, activeForm: `x ${secret}`, status: 'pending' }],
      }),
    ).toMatchObject({
      content: 'x sk-a***',
      todos: [{ content: 'x sk-a***', activeForm: 'x sk-a***' }],
    });
    const input = redactChatEvent({
      type: 'tool_input',
      toolUseId: 't',
      json: JSON.stringify({ question: `x ${secret}` }),
    });
    expect(input.type === 'tool_input' ? JSON.parse(input.json) : undefined).toEqual({
      question: 'x sk-a***',
    });
  });

  it('does not reproject an already public question', () => {
    const question = publicRunQuestion({
      requestId: 'req',
      runId: 'run',
      toolUseId: 'tool',
      questions: [
        {
          question: '原题',
          header: '标题',
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
          multiSelect: false,
        },
      ],
      status: 'answered',
      answers: { 原题: '答案' },
      createdAt: '2026-10-28T00:00:00.000Z',
      resolvedAt: '2026-10-28T00:01:00.000Z',
      expiresAt: '2026-10-28T00:10:00.000Z',
      closeReason: null,
    });
    const event = { type: 'question_updated' as const, question };
    expect(redactChatEvent(event)).toBe(event);
  });
});
