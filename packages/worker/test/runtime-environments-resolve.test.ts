import type { ResolvedRuntimeEnvironment } from '@agentport/shared';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeEnvironmentResolver } from '../src/runtime-environments/resolve.js';

const identity: ResolvedRuntimeEnvironment = {
  environmentId: 'env_1',
  environmentName: '默认环境',
  versionId: 'ver_1',
  imageId: `sha256:${'a'.repeat(64)}`,
};

describe('runtime environment resolver', () => {
  it('passes the binding through and resolves once per real creation', async () => {
    const resolveOnline = vi.fn(async () => identity);
    const resolve = createRuntimeEnvironmentResolver(resolveOnline);

    await expect(resolve('env_1')).resolves.toEqual(identity);
    expect(resolveOnline).toHaveBeenCalledWith('env_1');
  });

  it('uses null for the platform default environment', async () => {
    const resolveOnline = vi.fn(async (_environmentId: string | null) => identity);
    const resolve = createRuntimeEnvironmentResolver(resolveOnline);

    await resolve(null);
    expect(resolveOnline).toHaveBeenCalledWith(null);
  });

  it('fails clearly for a missing online version and never fabricates one', async () => {
    const resolve = createRuntimeEnvironmentResolver(async () => null);

    await expect(resolve(null)).rejects.toThrow(/默认运行环境.*没有可用的线上版本/);
    await expect(resolve('env_custom')).rejects.toThrow(/env_custom.*没有可用的线上版本/);
  });
});
