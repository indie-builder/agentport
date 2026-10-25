import { describe, expect, it } from 'vitest';
import { renderPlugin } from '../src/plugin-render.js';

const manifest = {
  path: '.claude-plugin/plugin.json',
  content: JSON.stringify({
    name: 'demo',
    version: '1.0.0',
    hooks: './hooks/hooks.json',
    mcpServers: { inline: { command: 'npx' } },
  }),
  executable: false,
};

const files = [
  manifest,
  { path: 'hooks/hooks.json', content: '{}', executable: false },
  { path: '.mcp.json', content: '{"mcpServers":{"fs":{}}}', executable: false },
  { path: 'skills/review/SKILL.md', content: '# review', executable: false },
  { path: 'agents/helper.md', content: '# helper', executable: false },
  { path: 'scripts/run.sh', content: 'echo', executable: true },
];

const render = (allowHooks: boolean, allowMcp: boolean) =>
  renderPlugin({ slug: 'demo', runtimeName: 'demo', allowHooks, allowMcp, files });

describe('renderPlugin', () => {
  it('strips hooks and MCP when unauthorized', () => {
    const plugin = render(false, false);
    expect(plugin.files.map((file) => file.path)).toEqual([
      manifest.path,
      'skills/review/SKILL.md',
      'agents/helper.md',
      'scripts/run.sh',
    ]);
    const content = plugin.files[0]?.content ?? '';
    expect(content).not.toContain('hooks');
    expect(content).not.toContain('mcpServers');
    expect(JSON.parse(content)).toMatchObject({ name: 'demo', version: '1.0.0' });
    expect(plugin.skillNames).toEqual(['review']);
    expect(plugin.mcpServerNames).toEqual([]);
    expect(plugin.hasAgents).toBe(true);
  });

  it('keeps authorized components', () => {
    const plugin = render(true, true);
    expect(plugin.files).toHaveLength(files.length);
    expect(plugin.mcpServerNames.sort()).toEqual(['fs', 'inline']);
    expect(plugin.files[0]).toEqual(manifest);
  });

  it('aligns the manifest name with the runtime name', () => {
    const plugin = renderPlugin({
      slug: 'demo',
      runtimeName: 'renamed',
      allowHooks: true,
      allowMcp: true,
      files: [manifest],
    });
    expect(JSON.parse(plugin.files[0]?.content ?? '{}').name).toBe('renamed');
  });

  it('leaves a manifest-free plugin untouched', () => {
    const plugin = renderPlugin({
      slug: 'bare',
      runtimeName: 'bare',
      allowHooks: false,
      allowMcp: false,
      files: [{ path: 'skills/s/SKILL.md', content: '# s', executable: false }],
    });
    expect(plugin.files).toHaveLength(1);
    expect(plugin.skillNames).toEqual(['s']);
    expect(plugin.hasAgents).toBe(false);
  });

  it('detects agents nested in subdirectories', () => {
    const plugin = renderPlugin({
      slug: 'nested',
      runtimeName: 'nested',
      allowHooks: false,
      allowMcp: false,
      files: [{ path: 'agents/team/reviewer.md', content: '# reviewer', executable: false }],
    });
    expect(plugin.hasAgents).toBe(true);
    expect(plugin.files.map((file) => file.path)).toEqual(['agents/team/reviewer.md']);
  });
});
