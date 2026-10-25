import { describe, expect, it } from 'vitest';
import {
  NATIVE_PLUGIN_TIMEOUT_MS,
  NATIVE_PLUGIN_WAIT_TIMEOUT_MS,
  NATIVE_PLUGINS_QUEUE,
  nativePluginActionSchema,
  nativePluginImportInputSchema,
  nativePluginInstallInputSchema,
  nativePluginOutputSchema,
} from '../src/native-plugins.js';

describe('native plugin contracts', () => {
  it('keeps the wait budget above the container budget', () => {
    expect(NATIVE_PLUGINS_QUEUE).toBe('native-plugins');
    expect(NATIVE_PLUGIN_TIMEOUT_MS).toBe(120_000);
    expect(NATIVE_PLUGIN_WAIT_TIMEOUT_MS).toBeGreaterThan(NATIVE_PLUGIN_TIMEOUT_MS);
  });

  it('accepts only the three actions', () => {
    expect(nativePluginActionSchema.parse({ action: 'list' })).toEqual({ action: 'list' });
    expect(
      nativePluginActionSchema.parse({
        action: 'install',
        marketplace: 'owner/repo',
        plugin: 'my-plugin',
      }),
    ).toMatchObject({ action: 'install', plugin: 'my-plugin' });
    expect(
      nativePluginActionSchema.parse({ action: 'read', pluginId: 'my-plugin@owner-repo' }),
    ).toEqual({ action: 'read', pluginId: 'my-plugin@owner-repo' });
    expect(nativePluginActionSchema.safeParse({ action: 'run', command: 'rm -rf' }).success).toBe(
      false,
    );
  });

  it('restricts marketplace sources to GitHub owner/repo or https URLs', () => {
    for (const value of [
      'owner/repo',
      'https://github.com/owner/repo',
      'https://gitlab.example.com/group/repo.git',
    ]) {
      expect(
        nativePluginInstallInputSchema.safeParse({ marketplace: value, plugin: 'p' }).success,
      ).toBe(true);
    }
    for (const value of [
      '/local/path',
      'owner/repo extraneous',
      '-oProxyCommand=calc',
      'http://github.com/owner/repo',
      'https://user:pw@github.com/owner/repo',
      'https://github.com/owner/repo\u0000',
    ]) {
      expect(
        nativePluginInstallInputSchema.safeParse({ marketplace: value, plugin: 'p' }).success,
      ).toBe(false);
    }
  });

  it('requires bare kebab-case plugin names and name@marketplace ids', () => {
    const install = (plugin: string) =>
      nativePluginInstallInputSchema.safeParse({ marketplace: 'owner/repo', plugin }).success;
    expect(install('my-plugin')).toBe(true);
    expect(install('my-plugin@market')).toBe(false);
    expect(install('My_Plugin')).toBe(false);

    const read = (pluginId: string) =>
      nativePluginImportInputSchema.safeParse({ pluginId }).success;
    expect(read('my-plugin@market')).toBe(true);
    expect(read('my-plugin')).toBe(false);
    expect(read('my-plugin@')).toBe(false);
    expect(read('@market')).toBe(false);
  });

  it('parses list, read and failure outputs separately', () => {
    const installed = [{ pluginId: 'a@m', version: '1.0.0' }];
    expect(nativePluginOutputSchema.parse({ ok: true, installed })).toEqual({
      ok: true,
      installed,
    });
    expect(
      nativePluginOutputSchema.parse({
        ok: true,
        plugin: { pluginId: 'a@m', version: '1.0.0' },
        files: [{ path: '.claude-plugin/plugin.json', content: '{}' }],
      }),
    ).toMatchObject({
      ok: true,
      files: [{ path: '.claude-plugin/plugin.json', executable: false }],
    });
    expect(nativePluginOutputSchema.parse({ ok: false, error: 'not installed' })).toEqual({
      ok: false,
      error: 'not installed',
    });
    expect(nativePluginOutputSchema.safeParse({ ok: false, error: '' }).success).toBe(false);
  });

  it('rejects file paths that escape the plugin root', () => {
    const parse = (path: string) =>
      nativePluginOutputSchema.safeParse({
        ok: true,
        plugin: { pluginId: 'a@m', version: '' },
        files: [{ path, content: '' }],
      }).success;
    expect(parse('skills/x/SKILL.md')).toBe(true);
    expect(parse('../escape')).toBe(false);
    expect(parse('/etc/passwd')).toBe(false);
  });
});
