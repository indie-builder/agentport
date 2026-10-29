import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  type DefaultEnvironmentDeps,
  ensureDefaultEnvironment,
  startDefaultEnvironmentRetry,
} from '../src/runtime-environments/default.js';

const IMAGE = 'agentport/sandbox:dev';
const IMAGE_ID = `sha256:${'c'.repeat(64)}`;

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

function fakeDeps(
  options: {
    exists?: boolean;
    ensureError?: () => Error | undefined;
    imageId?: string | null;
  } = {},
): {
  deps: DefaultEnvironmentDeps;
  calls: string[];
  registered: Array<{ imageTag: string; imageId: string }>;
} {
  const calls: string[] = [];
  const registered: Array<{ imageTag: string; imageId: string }> = [];
  const deps: DefaultEnvironmentDeps = {
    store: {
      getDefault: async () => {
        calls.push('getDefault');
        return options.exists === true ? { id: 'rte_test' } : null;
      },
      register: async (image) => {
        calls.push('register');
        registered.push(image);
      },
    },
    ensureImage: async (image, signal) => {
      calls.push(`ensureImage:${image}:${signal.aborted}`);
      const error = options.ensureError?.();
      if (error !== undefined) throw error;
    },
    resolveImageId: async (image) => {
      calls.push(`resolveImageId:${image}`);
      return options.imageId === undefined ? IMAGE_ID : options.imageId;
    },
    sandboxImage: IMAGE,
    signal: new AbortController().signal,
    logger: quiet,
  };
  return { deps, calls, registered };
}

describe('ensureDefaultEnvironment', () => {
  it('默认环境已存在时不 inspect、不 pull、不登记', async () => {
    const { deps, calls, registered } = fakeDeps({ exists: true });

    await expect(ensureDefaultEnvironment(deps)).resolves.toBe('exists');
    expect(calls).toEqual(['getDefault']);
    expect(registered).toEqual([]);
  });

  it('默认环境不存在时先确保基座存在（缺失则 pull），再用真实 ID 登记', async () => {
    const { deps, calls, registered } = fakeDeps();

    await expect(ensureDefaultEnvironment(deps)).resolves.toBe('registered');
    expect(calls).toEqual([
      'getDefault',
      `ensureImage:${IMAGE}:false`,
      `resolveImageId:${IMAGE}`,
      'register',
    ]);
    expect(registered).toEqual([{ imageTag: IMAGE, imageId: IMAGE_ID }]);
  });

  it('基座拉取失败时明确抛错且不登记，不假装环境可用', async () => {
    const { deps, calls, registered } = fakeDeps({
      ensureError: () => new Error('registry unavailable'),
    });

    await expect(ensureDefaultEnvironment(deps)).rejects.toThrow(/registry unavailable/);
    expect(calls).toEqual(['getDefault', `ensureImage:${IMAGE}:false`]);
    expect(registered).toEqual([]);
  });

  it('ensureImage 声称完成后仍读不到镜像 ID 时报错且不登记', async () => {
    const { deps, registered } = fakeDeps({ imageId: null });

    await expect(ensureDefaultEnvironment(deps)).rejects.toThrow(/not present locally/);
    expect(registered).toEqual([]);
  });
});

describe('startDefaultEnvironmentRetry', () => {
  it('启动登记失败后按间隔重试，成功后不再重试', async () => {
    let pulls = 0;
    const { deps, registered } = fakeDeps({
      ensureError: () => {
        pulls += 1;
        return pulls === 1 ? new Error('registry unavailable') : undefined;
      },
    });

    const stop = startDefaultEnvironmentRetry(deps, 5);
    await vi.waitFor(() => expect(registered).toHaveLength(1));
    await stop();

    expect(pulls).toBe(2);
    expect(registered).toEqual([{ imageTag: IMAGE, imageId: IMAGE_ID }]);
  });
});
