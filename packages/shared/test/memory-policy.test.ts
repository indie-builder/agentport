import { describe, expect, it } from 'bun:test';
import {
  countMemoryLines,
  DEFAULT_MEMORY_POLICY,
  memoryIndexLinksFile,
  memoryPolicySchema,
  resolveMemoryPolicy,
} from '../src/memory.js';

describe('memory policy', () => {
  it('exposes the documented defaults', () => {
    expect(DEFAULT_MEMORY_POLICY).toEqual({
      enabled: true,
      writeMode: 'native_auto',
      injectPersonalMemory: true,
      injectRules: true,
      topicLimit: 20,
    });
    expect(memoryPolicySchema.parse({})).toEqual(DEFAULT_MEMORY_POLICY);
  });

  it('merges partial values with the defaults', () => {
    expect(resolveMemoryPolicy({ topicLimit: 3 })).toEqual({
      ...DEFAULT_MEMORY_POLICY,
      topicLimit: 3,
    });
    expect(resolveMemoryPolicy({ enabled: false, writeMode: 'proposal_only' })).toEqual({
      ...DEFAULT_MEMORY_POLICY,
      enabled: false,
      writeMode: 'proposal_only',
    });
  });

  it('falls back to the defaults for missing or invalid values', () => {
    expect(resolveMemoryPolicy(undefined)).toEqual(DEFAULT_MEMORY_POLICY);
    expect(resolveMemoryPolicy(null)).toEqual(DEFAULT_MEMORY_POLICY);
    // 只校验失败的部分不生效，整体回落默认值，避免半套策略进入运行期。
    expect(resolveMemoryPolicy({ topicLimit: 2 })).toEqual(DEFAULT_MEMORY_POLICY);
    expect(resolveMemoryPolicy({ topicLimit: 49 })).toEqual(DEFAULT_MEMORY_POLICY);
    expect(resolveMemoryPolicy({ topicLimit: 3.5 })).toEqual(DEFAULT_MEMORY_POLICY);
    expect(resolveMemoryPolicy({ writeMode: 'read_only' })).toEqual(DEFAULT_MEMORY_POLICY);
    expect(resolveMemoryPolicy({ enabled: 'yes' })).toEqual(DEFAULT_MEMORY_POLICY);
    expect(resolveMemoryPolicy('native_auto')).toEqual(DEFAULT_MEMORY_POLICY);
    // strict：未知字段同样视为非法，不静默忽略。
    expect(resolveMemoryPolicy({ unknown: true })).toEqual(DEFAULT_MEMORY_POLICY);
  });
});

describe('countMemoryLines', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['a\n', 1],
    ['a\n\n', 2],
    ['\n', 1],
    ['a\nb', 2],
    ['a\r\nb\r\n', 2],
  ])('counts %p as %p lines', (content, lines) => {
    expect(countMemoryLines(content)).toBe(lines);
  });
});

describe('memoryIndexLinksFile', () => {
  it('accepts plain and ./-prefixed relative links', () => {
    expect(memoryIndexLinksFile('- [topic.md](topic.md)\n', 'topic.md')).toBe(true);
    expect(memoryIndexLinksFile('- [topic.md](./topic.md)\n', 'topic.md')).toBe(true);
    expect(memoryIndexLinksFile('- [说明](topic.md "标题")\n', 'topic.md')).toBe(true);
  });

  it('rejects images, missing links and other files', () => {
    expect(memoryIndexLinksFile('- ![topic.md](topic.md)\n', 'topic.md')).toBe(false);
    expect(memoryIndexLinksFile('- [other.md](other.md)\n', 'topic.md')).toBe(false);
    expect(memoryIndexLinksFile('', 'topic.md')).toBe(false);
  });
});
