import { describe, expect, it } from 'vitest';
import { encodePackage } from '../../api/src/features/agent-package-zip.js';
import { type PluginImportFile, parsePluginFiles } from '../src/features/plugins/parse.js';

const file = (path: string, content = 'x'): PluginImportFile => ({
  path,
  content,
  executable: false,
});

const manifest = (value: Record<string, unknown>): PluginImportFile =>
  file('.claude-plugin/plugin.json', JSON.stringify(value));

const parse = (files: PluginImportFile[], slug = 'demo') => parsePluginFiles({ files, slug });

describe('plugin import parsing', () => {
  it('collects skills, agents and hooks into capabilities', () => {
    const { input } = parse([
      manifest({ name: 'demo', version: '1.0.0' }),
      file('skills/review/SKILL.md'),
      file('agents/helper.md'),
      file('agents/nested/deep.md'),
      file('hooks/hooks.json'),
      file('scripts/run.sh'),
    ]);
    expect(input.runtimeName).toBe('demo');
    expect(input.capabilities.skills).toEqual(['review']);
    // 官方允许 agents/ 下再分子目录，不能漏掉。
    expect(input.capabilities.agents).toEqual(['helper', 'nested/deep']);
    expect(input.capabilities.hasHooks).toBe(true);
  });

  it('rejects components v1 does not support', () => {
    for (const path of [
      '.lsp.json',
      'workflows/a.js',
      'monitors/monitors.json',
      'bin/tool',
      'themes/x.json',
      'settings.json',
    ]) {
      expect(() => parse([manifest({ name: 'demo' }), file(path)])).toThrow();
    }
  });

  it('rejects manifest keys that could take over the session', () => {
    for (const key of ['settings', 'userConfig', 'channels', 'dependencies', 'lspServers']) {
      expect(() => parse([manifest({ name: 'demo', [key]: {} })])).toThrow();
    }
  });

  it('rejects unsafe or ambiguous paths', () => {
    for (const path of ['../escape.md', '/abs.md', 'a//b.md', 'a/./b.md', 'agents/']) {
      expect(() => parse([manifest({ name: 'demo' }), file(path)])).toThrow();
    }
  });

  it('rejects a plugin name that cannot be an SDK namespace', () => {
    expect(() => parse([manifest({ name: 'My Plugin' })])).toThrow();
  });

  it('rejects the array form of manifest mcpServers instead of silently dropping it', () => {
    expect(() =>
      parse([manifest({ name: 'demo', mcpServers: [{ fs: { command: 'npx' } }, './mcp.json'] })]),
    ).toThrow();
  });

  it('collects inline and .mcp.json server names', () => {
    const { input } = parse([
      manifest({ name: 'demo', mcpServers: { inline: { command: 'npx' } } }),
      file('.mcp.json', JSON.stringify({ mcpServers: { fs: { command: 'npx' } } })),
    ]);
    expect(input.capabilities.mcpServers.sort()).toEqual(['fs', 'inline']);
  });

  it('warns when the manifest is missing', () => {
    const { input, warnings } = parse([file('skills/s/SKILL.md')], 'bare-plugin');
    expect(input.runtimeName).toBe('bare-plugin');
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('plugin zip decoding', () => {
  it('round-trips a plugin directory through the shared zip codec', () => {
    const zip = encodePackage({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo' }),
      'skills/review/SKILL.md': 'body',
    });
    expect(zip.byteLength).toBeGreaterThan(0);
  });
});
