import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageAttachment } from '@agentport/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conversationInputsMount, promptWithAttachments } from '../src/attachments.js';

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

describe('conversationInputsMount', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'conversation-inputs-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const identity = () => ({
    workspacesDir: root,
    hostWorkspacesDir: join(root, 'host-view'),
    slug: 'demo',
    conversationId: 'conv_01',
  });

  it('returns no mount when the conversation has no inputs directory', async () => {
    expect(await conversationInputsMount(identity())).toBeNull();
  });

  it('mounts an existing real directory read-only at /mnt/inputs', async () => {
    await mkdir(join(root, 'demo', 'conversation-inputs', 'conv_01'), { recursive: true });
    expect(await conversationInputsMount(identity())).toEqual({
      hostPath: join(root, 'host-view', 'demo', 'conversation-inputs', 'conv_01'),
      containerPath: '/mnt/inputs',
      readonly: true,
    });
  });

  it('rejects a symlinked or non-directory inputs path', async () => {
    const base = join(root, 'demo', 'conversation-inputs');
    await mkdir(base, { recursive: true });
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), join(base, 'conv_01'));
    await expect(conversationInputsMount(identity())).rejects.toThrow('real directory');

    await rm(join(base, 'conv_01'));
    await writeFile(join(base, 'conv_01'), 'not a directory');
    await expect(conversationInputsMount(identity())).rejects.toThrow('real directory');
  });
});
