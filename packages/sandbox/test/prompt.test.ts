import { describe, expect, it } from 'vitest';
import { composePrompt } from '../src/prompt.js';

describe('composePrompt', () => {
  it('leaves the prompt untouched without history', () => {
    expect(composePrompt('hi')).toBe('hi');
    expect(composePrompt('hi', '')).toBe('hi');
  });

  it('wraps history before the current request', () => {
    const prompt = composePrompt('and now?', '用户：remember this\n\n助手：noted');
    expect(prompt).toBe(
      '之前的对话：\n用户：remember this\n\n助手：noted\n（以上为历史，仅供参考）\n\n当前请求：and now?',
    );
  });
});
