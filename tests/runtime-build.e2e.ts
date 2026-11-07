import { randomUUID } from 'node:crypto';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import {
  registerRuntimeBuild,
  requireExecutionStack,
  runtimeBuildTag,
} from './support/execution-stack.js';

await requireExecutionStack();

interface RuntimeEnvironment {
  id: string;
  name: string;
  dockerfile: string;
  isDefault: boolean;
  onlineVersionId: string | null;
}

interface RuntimeVersion {
  id: string;
  environmentId: string;
  baseImageId: string;
  status: 'queued' | 'building' | 'ready' | 'failed';
  imageTag: string | null;
  imageId: string | null;
  buildLog: string;
  error: string | null;
}

async function apiJson<T>(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await browserFetch(browser, method, path, body);
  if (response.status < 200 || response.status >= 300)
    throw new Error(`${path} ${response.status}: ${response.text}`);
  return (response.text === '' ? null : JSON.parse(response.text)) as T;
}

test('builds and publishes a runtime environment through worker and Docker', {
  session: 'admin',
  timeout: 15 * 60_000,
}, async ({ app, screen, browser }) => {
  const contract = await requireExecutionStack();
  await app.open('/');
  expect(await browser.evaluate(() => location.origin)).toBe(contract.appUrl);
  const suffix = randomUUID().slice(0, 8);
  const name = `E2E 运行环境 ${suffix}`;
  const dockerfile = `# syntax=docker/dockerfile:1
ARG RUNTIME_BASE_IMAGE=agentport/sandbox:dev
FROM \${RUNTIME_BASE_IMAGE}

USER root
RUN echo "e2e-runtime-build-${suffix}" > /opt/e2e-runtime-marker

USER node
WORKDIR /app
`;

  const environment = await apiJson<RuntimeEnvironment>(
    browser,
    'POST',
    '/api/runtime-environments',
    { name, dockerfile },
  );
  try {
    expect(environment).toMatchObject({ name, dockerfile, isDefault: false });

    const queued = await apiJson<RuntimeVersion>(
      browser,
      'POST',
      `/api/runtime-environments/${environment.id}/versions`,
    );
    registerRuntimeBuild({
      environmentId: environment.id,
      versionId: queued.id,
      imageTag: runtimeBuildTag(queued.baseImageId, queued.id),
    });
    expect(queued.status).toBe('queued');

    let version = queued;
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      version = await apiJson<RuntimeVersion>(
        browser,
        'GET',
        `/api/runtime-environments/${environment.id}/versions/${queued.id}`,
      );
      if (version.status === 'ready' || version.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    expect(version.status, JSON.stringify(version)).toBe('ready');
    expect(
      process.env.E2E_RUNTIME_FAIL_AFTER_READY,
      '注入 ready 后断言失败，验证 finally 清理',
    ).not.toBe('1');
    expect(version.error).toBeNull();
    expect(version.imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(version.imageTag).toBe(runtimeBuildTag(queued.baseImageId, queued.id));
    expect(version.buildLog).toContain('verify: ok');
    expect(version.buildLog).toContain(`e2e-runtime-build-${suffix}`);

    const published = await apiJson<RuntimeEnvironment>(
      browser,
      'PUT',
      `/api/runtime-environments/${environment.id}/online-version`,
      { versionId: version.id },
    );
    expect(published.onlineVersionId).toBe(version.id);

    await app.open(`/runtime-environments/${environment.id}`);
    await expect(screen.getByRole('heading', { level: 1, name })).toBeVisible();
  } finally {
    const versions = await apiJson<RuntimeVersion[]>(
      browser,
      'GET',
      `/api/runtime-environments/${environment.id}/versions`,
    );
    for (const version of versions) {
      registerRuntimeBuild({
        environmentId: environment.id,
        versionId: version.id,
        imageTag: version.imageTag ?? runtimeBuildTag(contract.sandboxImage, version.id),
      });
    }
    await apiJson(browser, 'DELETE', `/api/runtime-environments/${environment.id}`);
    await expect
      .poll(async () => {
        const list = await apiJson<RuntimeEnvironment[]>(
          browser,
          'GET',
          '/api/runtime-environments',
        );
        return list.some((item) => item.id === environment.id);
      })
      .toBe(false);
  }
});
