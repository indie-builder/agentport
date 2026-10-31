import { describe, expect, it } from 'vitest';
import {
  AGENT_MEMORY_MAX_BYTES,
  AGENT_MEMORY_MAX_LINES,
  MEMORY_FILE_MAX_BYTES,
  memoryContentSnapshotSchema,
  memoryFileNamePattern,
  memoryFileNameSchema,
  memoryIndexContentAfter,
  memoryReviewAfter,
  memoryReviewEvidenceSchema,
  memoryReviewHasChanges,
  memoryReviewTargetSchema,
  validateMemoryContent,
} from '../src/memory.js';

const themeTarget = (name: string) => ({ kind: 'agent_memory' as const, agentId: 'agent_1', name });
const themeSnapshot = (content: string | null, index: string | null) => ({
  content,
  globs: null,
  index: { content: index },
});

describe('memory file names', () => {
  it('accepts flat Markdown names and rejects traversal, hidden and non-Markdown names', () => {
    for (const name of ['MEMORY.md', 'topic.md', 'v1.2_notes-x.md', 'A.md']) {
      expect(memoryFileNameSchema.safeParse(name).success).toBe(true);
      expect(memoryFileNamePattern.test(name)).toBe(true);
    }
    for (const name of [
      '../x.md',
      'a/b.md',
      '.hidden.md',
      '-x.md',
      'a.txt',
      'a.md\n',
      '',
      '/a.md',
    ]) {
      expect(memoryFileNameSchema.safeParse(name).success).toBe(false);
      expect(memoryFileNamePattern.test(name)).toBe(false);
    }
  });

  it('requires a file name on agent_memory targets and keeps other targets unchanged', () => {
    expect(memoryReviewTargetSchema.safeParse({ kind: 'agent_memory', agentId: 'a' }).success).toBe(
      false,
    );
    expect(
      memoryReviewTargetSchema.parse({ kind: 'agent_memory', agentId: 'a', name: 'topic.md' }),
    ).toEqual({ kind: 'agent_memory', agentId: 'a', name: 'topic.md' });
    expect(
      memoryReviewTargetSchema.safeParse({
        kind: 'agent_memory',
        agentId: 'a',
        name: '../escape.md',
      }).success,
    ).toBe(false);
    expect(memoryReviewTargetSchema.parse({ kind: 'personal' })).toEqual({ kind: 'personal' });
    expect(
      memoryReviewTargetSchema.parse({ kind: 'agent_rule', agentId: 'a', slug: 'rule' }),
    ).toEqual({ kind: 'agent_rule', agentId: 'a', slug: 'rule' });
  });

  it('requires the companion index snapshot and evidence attribution kind', () => {
    expect(memoryContentSnapshotSchema.safeParse({ content: 'x', globs: null }).success).toBe(
      false,
    );
    expect(memoryContentSnapshotSchema.parse({ content: 'x', globs: null, index: null })).toEqual({
      content: 'x',
      globs: null,
      index: null,
    });
    expect(
      memoryContentSnapshotSchema.safeParse({
        content: 'x',
        globs: null,
        index: { content: '# index' },
      }).success,
    ).toBe(true);

    expect(memoryReviewEvidenceSchema.safeParse({ messageId: 'm', quote: 'q' }).success).toBe(
      false,
    );
    expect(
      memoryReviewEvidenceSchema.safeParse({ messageId: 'm', quote: 'q', kind: 'user_fact' })
        .success,
    ).toBe(true);
    expect(
      memoryReviewEvidenceSchema.safeParse({ messageId: 'm', quote: 'q', kind: 'fact' }).success,
    ).toBe(false);
  });
});

describe('memory index discovery link', () => {
  const body = 'topic body';

  it('leaves the index byte-for-byte unchanged when a plain or ./-prefixed link exists', () => {
    for (const index of [
      '# 主题\n\n- [Topic](topic.md)\n',
      '# 主题\n- [Topic](./topic.md)\n',
      '# 主题\n- [Topic](topic.md "说明")\n',
      "# 主题\n- [Topic](topic.md '说明')\n",
      '# 主题\n- [Topic](topic.md (说明))\n',
    ]) {
      expect(memoryIndexContentAfter('topic.md', body, index)).toBe(index);
    }
  });

  it('matches only the exact file name, not similar links', () => {
    const index = '# 主题\n- [Other](other-topic.md)\n- [Backup](topic.md.bak)\n';
    expect(memoryIndexContentAfter('topic.md', body, index)).toBe(
      `${index}- [topic.md](topic.md)\n`,
    );
  });

  it('adds a real link even when the same name only appears as plain text', () => {
    for (const index of ['# 主题\n- topic.md 是主题说明\n', '# 主题\n- 说明 ](topic.md)\n']) {
      expect(memoryIndexContentAfter('topic.md', body, index)).toBe(
        `${index}- [topic.md](topic.md)\n`,
      );
    }
  });

  it('does not treat image embeds as discovery links and still finds an adjacent real link', () => {
    const imageOnly = '# 主题\n![附件](topic.md)\n';
    expect(memoryIndexContentAfter('topic.md', body, imageOnly)).toBe(
      `${imageOnly}- [topic.md](topic.md)\n`,
    );
    const imageThenLink = '![附件](other.md)[topic](topic.md)\n';
    expect(memoryIndexContentAfter('topic.md', body, imageThenLink)).toBe(imageThenLink);
  });

  it('starts from an empty index and keeps existing content verbatim', () => {
    expect(memoryIndexContentAfter('topic.md', body, null)).toBe('- [topic.md](topic.md)\n');
    expect(memoryIndexContentAfter('topic.md', body, '')).toBe('- [topic.md](topic.md)\n');
    expect(memoryIndexContentAfter('topic.md', body, '# 主题')).toBe(
      '# 主题\n- [topic.md](topic.md)\n',
    );
  });

  it('does nothing when the target has no content or is the index file itself', () => {
    expect(memoryIndexContentAfter('topic.md', null, null)).toBeNull();
    expect(memoryIndexContentAfter('topic.md', null, '# 主题\n')).toBe('# 主题\n');
    expect(memoryIndexContentAfter('MEMORY.md', body, null)).toBeNull();
    expect(memoryIndexContentAfter('MEMORY.md', body, '# 主题\n')).toBe('# 主题\n');
  });
});

describe('review after snapshot and effective change', () => {
  const target = themeTarget('topic.md');
  const proposal = (proposedContent: string | null) => ({
    summary: 's',
    proposedContent,
    evidence: [],
  });

  it('returns before unchanged when the proposal has no content', () => {
    const before = themeSnapshot('old', null);
    expect(memoryReviewAfter(target, before, null)).toBe(before);
    expect(memoryReviewHasChanges(target, before, proposal(null))).toBe(false);
  });

  it('adds the companion index link while replacing the target content', () => {
    const before = themeSnapshot('old', '# 主题\n');
    expect(memoryReviewAfter(target, before, 'new')).toEqual({
      content: 'new',
      globs: null,
      index: { content: '# 主题\n- [topic.md](topic.md)\n' },
    });
  });

  it('treats the same body with an already linked index as no change', () => {
    const before = themeSnapshot('body', '- [topic.md](topic.md)\n');
    expect(memoryReviewAfter(target, before, 'body')).toEqual(before);
    expect(memoryReviewHasChanges(target, before, proposal('body'))).toBe(false);
  });

  it('treats the same body without a link as a change so the index can be completed', () => {
    const before = themeSnapshot('body', '# 主题\n');
    expect(memoryReviewHasChanges(target, before, proposal('body'))).toBe(true);
    expect(memoryReviewHasChanges(target, before, proposal('other'))).toBe(true);
  });

  it('does not add a companion index for personal, rule or MEMORY.md targets', () => {
    expect(
      memoryReviewAfter({ kind: 'personal' }, { content: 'a', globs: null, index: null }, 'b'),
    ).toEqual({ content: 'b', globs: null, index: null });
    expect(
      memoryReviewAfter(
        { kind: 'agent_rule', agentId: 'a', slug: 'rule' },
        { content: 'a', globs: 'src/**', index: null },
        'b',
      ),
    ).toEqual({ content: 'b', globs: 'src/**', index: null });
    const indexTarget = themeTarget('MEMORY.md');
    expect(
      memoryReviewAfter(indexTarget, { content: '#', globs: null, index: null }, '# 2'),
    ).toEqual({ content: '# 2', globs: null, index: null });
    expect(
      memoryReviewHasChanges(
        indexTarget,
        { content: '#', globs: null, index: null },
        proposal('#'),
      ),
    ).toBe(false);
  });
});

describe('memory content limits', () => {
  it('accepts a theme up to the 200000 UTF-8 byte file limit', () => {
    expect(validateMemoryContent('topic.md', 'a'.repeat(MEMORY_FILE_MAX_BYTES))).toBeNull();
    expect(validateMemoryContent('topic.md', 'a'.repeat(MEMORY_FILE_MAX_BYTES + 1))).not.toBeNull();
  });

  it('counts UTF-8 bytes, not characters', () => {
    const exact = `${'a'.repeat(MEMORY_FILE_MAX_BYTES - 3)}你`;
    expect(validateMemoryContent('topic.md', exact)).toBeNull();
    expect(validateMemoryContent('topic.md', `${exact}你`)).not.toBeNull();
  });

  it('reports the total byte limit before the stricter index limit', () => {
    const problem = validateMemoryContent('MEMORY.md', 'a'.repeat(MEMORY_FILE_MAX_BYTES + 1));
    expect(problem).toContain(String(MEMORY_FILE_MAX_BYTES));
    expect(problem).not.toContain(String(AGENT_MEMORY_MAX_BYTES));
  });

  it('enforces the 25 KiB and 200 line limits only for MEMORY.md', () => {
    expect(validateMemoryContent('MEMORY.md', 'a'.repeat(AGENT_MEMORY_MAX_BYTES))).toBeNull();
    expect(validateMemoryContent('MEMORY.md', 'a'.repeat(AGENT_MEMORY_MAX_BYTES + 1))).toContain(
      String(AGENT_MEMORY_MAX_BYTES),
    );
    expect(validateMemoryContent('MEMORY.md', 'x\n'.repeat(AGENT_MEMORY_MAX_LINES))).toBeNull();
    expect(validateMemoryContent('MEMORY.md', 'x\n'.repeat(AGENT_MEMORY_MAX_LINES + 1))).toContain(
      `${AGENT_MEMORY_MAX_LINES} 行`,
    );
    expect(validateMemoryContent('topic.md', 'x\n'.repeat(AGENT_MEMORY_MAX_LINES + 1))).toBeNull();
  });

  it('accepts empty memory files', () => {
    expect(validateMemoryContent('MEMORY.md', '')).toBeNull();
    expect(validateMemoryContent('MEMORY.md', '\n')).toBeNull();
    expect(validateMemoryContent('topic.md', '')).toBeNull();
  });
});
