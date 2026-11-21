import { describe, expect, it } from 'bun:test';
import { createRuntimeEnvironmentResolver } from '../src/runtime-environments/resolve.js';

describe('runtime environment resolver', () => {
  it('fails clearly for a missing online version and never fabricates one', async () => {
    const resolve = createRuntimeEnvironmentResolver(async () => null);

    await expect(resolve(null)).rejects.toThrow(/默认运行环境.*没有可用的线上版本/);
    await expect(resolve('env_custom')).rejects.toThrow(/env_custom.*没有可用的线上版本/);
  });
});
