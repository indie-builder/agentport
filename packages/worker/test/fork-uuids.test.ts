import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readForkUuidMap } from '../src/fork-uuids.js';

const roots: string[] = [];

/** 写一份最小 transcript：只有 uuid 与 forkedFrom 参与映射。 */
async function transcript(lines: Array<{ uuid: string; from?: string }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fork-uuids-'));
  roots.push(root);
  const dir = join(root, 'projects', '-workspace');
  await mkdir(dir, { recursive: true });
  const body = lines
    .map(({ uuid, from }) =>
      JSON.stringify({
        uuid,
        ...(from === undefined ? {} : { forkedFrom: { messageUuid: from } }),
      }),
    )
    .join('\n');
  await writeFile(join(dir, 'new-session.jsonl'), `${body}\n`);
  return root;
}

afterEach(() => {
  roots.length = 0;
});

describe('readForkUuidMap', () => {
  it('uses forkedFrom rather than position, so reordered transcripts still map correctly', async () => {
    // 压缩后的会话顺序与来源不同：不能用下标对齐。
    const root = await transcript([
      { uuid: 'new-b', from: 'old-b' },
      { uuid: 'new-a', from: 'old-a' },
    ]);
    const map = await readForkUuidMap(root, 'new-session', new Set(['old-a', 'old-b']));
    expect(map).toEqual([
      { from: 'old-b', to: 'new-b' },
      { from: 'old-a', to: 'new-a' },
    ]);
  });

  it('only returns messages the page already has', async () => {
    const root = await transcript([
      { uuid: 'new-a', from: 'old-a' },
      { uuid: 'new-z', from: 'old-z' },
    ]);
    const map = await readForkUuidMap(root, 'new-session', new Set(['old-a']));
    expect(map).toEqual([{ from: 'old-a', to: 'new-a' }]);
  });

  it('ignores entries without a fork origin, invalid JSON, and identical uuids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fork-uuids-'));
    roots.push(root);
    const dir = join(root, 'projects', '-workspace');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'new-session.jsonl'),
      [
        '{"uuid":"plain"}',
        'not json',
        JSON.stringify({ uuid: 'same', forkedFrom: { messageUuid: 'same' } }),
        JSON.stringify({ uuid: 'new-a', forkedFrom: { messageUuid: 'old-a' } }),
      ].join('\n'),
    );
    const map = await readForkUuidMap(root, 'new-session', new Set(['plain', 'same', 'old-a']));
    expect(map).toEqual([{ from: 'old-a', to: 'new-a' }]);
  });

  it('returns an empty map when the session file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fork-uuids-'));
    roots.push(root);
    await mkdir(join(root, 'projects', '-workspace'), { recursive: true });
    expect(await readForkUuidMap(root, 'missing', new Set(['old-a']))).toEqual([]);
  });
});
