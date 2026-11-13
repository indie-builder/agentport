import { describe, expect, it } from 'bun:test';
import type { MessageAttachment } from '@agentport/shared';
import { promptWithAttachments } from '../src/runs/attachments.js';

const attachment = (overrides: Partial<MessageAttachment> = {}): MessageAttachment => ({
  id: '11111111-1111-4111-8111-111111111111',
  filename: 'brief.pdf',
  mimeType: 'application/pdf',
  size: 1234,
  sha256: 'a'.repeat(64),
  ...overrides,
});

describe('promptWithAttachments', () => {
  it('leaves the prompt unchanged without attachments', () => {
    expect(promptWithAttachments('hello', [])).toBe('hello');
  });

  it('appends an ordered list with escaped names, paths, type and size', () => {
    const prompt = promptWithAttachments('分析一下', [
      attachment({ filename: 'brief.pdf', mimeType: 'application/pdf', size: 1234 }),
      attachment({
        id: '22222222-2222-4222-8222-222222222222',
        filename: 'report "final".csv',
        mimeType: 'text/csv',
        size: 7,
      }),
    ]);

    expect(prompt.startsWith('分析一下\n')).toBe(true);
    expect(prompt).toContain(
      '"brief.pdf"：/mnt/inputs/11111111-1111-4111-8111-111111111111.pdf（application/pdf，1234 bytes）',
    );
    expect(prompt).toContain(
      `"report \\"final\\".csv"：/mnt/inputs/22222222-2222-4222-8222-222222222222.csv（text/csv，7 bytes）`,
    );
    // 顺序与消息里的附件一致。
    expect(prompt.indexOf('11111111')).toBeLessThan(prompt.indexOf('22222222'));
    expect(prompt).toContain('先 Read 相关资料再分析；读取失败要明确说明');
    expect(prompt).toContain('输入只读，交付写 /mnt/outputs');
  });
});
