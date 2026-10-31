import { setTimeout as sleep } from 'node:timers/promises';
import { type Browser, test } from '@e2e-dev/web';
import { expect, type Screen } from 'e2e';
import {
  api,
  DATASET_ID,
  manifestExists,
  readManifest,
  writeManifest,
} from '../support/business-dataset.js';

/**
 * 青禾数据集的运行环境域：真实 UI 创建/保存/构建/发布，业务 API 只做查重与轮询。
 *
 * 固定对象（名称不随机）：
 * - 环境「【青禾演示】采购运行环境」，不作为平台默认环境；
 * - 正常版本：官方 SANDBOX_IMAGE 基座 + 原生 runner，构建成功并设为线上；
 * - 失败版本：同一基座上显式 `RUN ... && exit 1`，保留真实失败日志。
 *
 * 重跑语义：manifest 记录了版本 ID 后不再重新构建；queued/building 只轮询，
 * failed 默认不重试；仅 E2E_DEV_DATA_RETRY_RUNTIME_VERSION=失败版本ID 时显式重建正常版本并保留历史。
 * ID 不在（被删除/改名）或 Dockerfile 被外部修改时报冲突而不是覆盖。
 * E2E_DEV_DATA_VERIFY=1 时严格只读：不发任何写请求、不写 manifest。
 */

const ENVIRONMENT_NAME = '【青禾演示】采购运行环境';
const NORMAL_SCENARIO = 'normal-dockerfile';
const FAILURE_SCENARIO = 'run-exit-1';

/** 与 packages/shared/src/runtime-environment.ts 的 DEFAULT_RUNTIME_DOCKERFILE 一致，再带数据集标记。 */
const NORMAL_DOCKERFILE = `# syntax=docker/dockerfile:1
ARG RUNTIME_BASE_IMAGE=agentport/sandbox:dev
FROM \${RUNTIME_BASE_IMAGE}

USER root
# ${DATASET_ID}：正常运行版本，复用平台 SANDBOX_IMAGE 基座，不安装额外系统包。

USER node
WORKDIR /app
# ${DATASET_ID}：正常版本结束
`;

/** 失败验收：RUN 明确非零退出，构建必须失败且日志保留意图与 exit code。 */
const FAILURE_DOCKERFILE = `${NORMAL_DOCKERFILE}
RUN echo "qinghe-devdata-failure-marker" && exit 1
`;

const FAILURE_MARKER = 'qinghe-devdata-failure-marker';
const ACCEPTED_DOCKERFILES = new Set([NORMAL_DOCKERFILE, FAILURE_DOCKERFILE]);

const BUILD_POLL_TIMEOUT_MS = 31 * 60_000;
const STATE_POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;

interface RuntimeEnvironment {
  id: string;
  name: string;
  dockerfile: string;
  isDefault: boolean;
  onlineVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

type VersionStatus = 'queued' | 'building' | 'ready' | 'failed';

interface RuntimeEnvironmentVersionSummary {
  id: string;
  environmentId: string;
  baseImageId: string;
  status: VersionStatus;
  imageTag: string | null;
  imageId: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

interface RuntimeEnvironmentVersion extends RuntimeEnvironmentVersionSummary {
  dockerfile: string;
  buildLog: string;
  logTruncated: boolean;
}

interface VersionRecord {
  id: string;
  scenario: string;
  status: VersionStatus;
  recordedAt: string;
}

interface RuntimeManifest {
  dataset: string;
  section: 'runtime';
  source: { origin: string; via: 'e2e-ui'; updatedAt: string };
  environmentName: string;
  runtimeEnvironmentId: string;
  publishedVersionId: string | null;
  failedAttempts?: (VersionRecord & { error: string | null; baseImageId: string })[];
  versions: {
    success: VersionRecord | null;
    failure: VersionRecord | null;
  };
  relations: {
    environmentId: string;
    successVersionId: string | null;
    failureVersionId: string | null;
    publishedVersionId: string | null;
  };
  status: 'in_progress' | 'ready' | 'partial' | 'conflict';
  gaps: string[];
}

function conflict(message: string): never {
  throw new Error(
    `[${DATASET_ID}] 运行环境冲突：${message}。数据构建不会覆盖或改随机名，请人工确认后再处理。`,
  );
}

function gap(message: string): never {
  throw new Error(`[${DATASET_ID}] 运行环境缺口：${message}。未伪造构建结果。`);
}

function shortId(id: string): string {
  const underscore = id.indexOf('_');
  const body = underscore > 0 ? id.slice(underscore + 1) : id;
  return body.length > 8 ? body.slice(-8) : body;
}

async function loadManifest(): Promise<RuntimeManifest | null> {
  return readManifest<RuntimeManifest | null>('runtime', null);
}

function rvPath(environmentId: string, versionId: string): string {
  return `/api/runtime-environments/${encodeURIComponent(environmentId)}/versions/${encodeURIComponent(versionId)}`;
}

async function fetchEnvironment(browser: Browser, id: string): Promise<RuntimeEnvironment> {
  return api<RuntimeEnvironment>(browser, `/api/runtime-environments/${encodeURIComponent(id)}`);
}

async function fetchVersion(
  browser: Browser,
  environmentId: string,
  versionId: string,
): Promise<RuntimeEnvironmentVersion> {
  return api<RuntimeEnvironmentVersion>(browser, rvPath(environmentId, versionId));
}

/** 版本不存在说明固定对象被删除/替换；不静默重建。 */
async function fetchVersionOrConflict(
  browser: Browser,
  environmentId: string,
  versionId: string,
): Promise<RuntimeEnvironmentVersion> {
  try {
    return await fetchVersion(browser, environmentId, versionId);
  } catch {
    conflict(`manifest 记录的版本 ${versionId} 已不存在`);
  }
}

async function pollVersion(
  browser: Browser,
  environmentId: string,
  versionId: string,
  label: string,
): Promise<RuntimeEnvironmentVersion> {
  const deadline = Date.now() + BUILD_POLL_TIMEOUT_MS;
  for (;;) {
    const version = await fetchVersionOrConflict(browser, environmentId, versionId);
    if (version.status === 'ready' || version.status === 'failed') return version;
    if (Date.now() > deadline) {
      gap(
        `${label}版本 ${versionId} 在 ${BUILD_POLL_TIMEOUT_MS / 60_000} 分钟内未到终态（仍为 ${version.status}）；不重新提交，检查 worker/构建队列`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function waitForEnvironment(
  browser: Browser,
  id: string,
  matches: (environment: RuntimeEnvironment) => boolean,
  description: string,
): Promise<RuntimeEnvironment> {
  const deadline = Date.now() + STATE_POLL_TIMEOUT_MS;
  for (;;) {
    const environment = await fetchEnvironment(browser, id);
    if (matches(environment)) return environment;
    if (Date.now() > deadline)
      gap(`环境 ${id} 在 ${STATE_POLL_TIMEOUT_MS / 1000}s 内未满足：${description}`);
    await sleep(1_000);
  }
}

async function openEnvironment(
  app: { open(path: string): Promise<void> },
  screen: Screen,
  environmentId: string,
): Promise<void> {
  await app.open(`/runtime-environments/${encodeURIComponent(environmentId)}`);
  await expect(screen.getByRole('heading', { level: 1, name: ENVIRONMENT_NAME })).toBeVisible();
}

async function createEnvironment(browser: Browser, screen: Screen): Promise<string> {
  await screen.getByRole('button', '新建环境').first().tap();
  await browser.locator('#runtime-environment-name').fill(ENVIRONMENT_NAME);
  await browser.locator('#runtime-environment-dockerfile').fill(NORMAL_DOCKERFILE);
  await screen.getByRole('button', { name: '创建', exact: true }).tap();
  await expect(browser).toHaveURL(/\/runtime-environments\/rte_[^/?#]+/);
  const id = (await browser.url()).match(/\/runtime-environments\/([^/?#]+)/)?.[1];
  if (id === undefined) gap('创建环境后 URL 中没有环境 ID');
  return id;
}

/** 保存 Dockerfile 后按业务 API 确认，避免只凭 toast 判定。 */
async function saveDockerfile(
  browser: Browser,
  screen: Screen,
  environmentId: string,
  dockerfile: string,
): Promise<void> {
  await browser.locator('#runtime-environment-dockerfile').fill(dockerfile);
  await screen.getByRole('button', { name: '保存更改' }).tap();
  await expect(screen.getByText('已保存', { exact: true })).toBeVisible();
  await waitForEnvironment(
    browser,
    environmentId,
    (environment) => environment.dockerfile === dockerfile,
    'Dockerfile 保存未生效',
  );
}

async function ensureDockerfile(
  browser: Browser,
  screen: Screen,
  app: { open(path: string): Promise<void> },
  environmentId: string,
  dockerfile: string,
): Promise<void> {
  const environment = await fetchEnvironment(browser, environmentId);
  if (environment.dockerfile === dockerfile) return;
  await openEnvironment(app, screen, environmentId);
  await saveDockerfile(browser, screen, environmentId, dockerfile);
}

/** 点 UI「构建新版本」并从 202 响应里立刻拿版本 ID。 */
async function startBuild(
  browser: Browser,
  screen: Screen,
  environmentId: string,
): Promise<RuntimeEnvironmentVersion> {
  const responsePromise = browser.waitForResponse(
    new RegExp(`/api/runtime-environments/${environmentId}/versions$`),
  );
  await screen.getByRole('button', '构建新版本').first().tap();
  const response = await responsePromise;
  if (response.status !== 202) {
    const body = await response.text();
    gap(`提交构建失败（HTTP ${response.status}）：${body.slice(-500)}`);
  }
  return response.json<RuntimeEnvironmentVersion>();
}

async function publishVersion(
  browser: Browser,
  screen: Screen,
  app: { open(path: string): Promise<void> },
  environmentId: string,
  versionId: string,
): Promise<void> {
  await openEnvironment(app, screen, environmentId);
  const row = browser
    .locator('[data-slot="table-row"]')
    .filter({ hasText: shortId(versionId) })
    .first();
  await expect(row.getByRole('button', { name: '设为线上' })).toBeVisible();
  const responsePromise = browser.waitForResponse(
    new RegExp(`/api/runtime-environments/${environmentId}/online-version$`),
  );
  await row.getByRole('button', { name: '设为线上' }).tap();
  const response = await responsePromise;
  if (response.status !== 200) {
    gap(`发布版本 ${versionId} 失败（HTTP ${response.status}）`);
  }
  await waitForEnvironment(
    browser,
    environmentId,
    (environment) => environment.onlineVersionId === versionId,
    `线上指针未指向成功版本 ${versionId}`,
  );
}

function assertSuccessEvidence(version: RuntimeEnvironmentVersion): void {
  if (version.status !== 'ready') gap(`正常版本 ${version.id} 未就绪（${version.status}）`);
  if (version.imageId === null) gap(`正常版本 ${version.id} 没有真实镜像 ID`);
  // verify.ts 在只读、无网络、uid 1000 的容器里检查 bash 与 runner；这行是原生 sandbox 可用的证据。
  if (!version.buildLog.includes('verify: ok')) {
    gap(
      `正常版本 ${version.id} 构建日志缺少「verify: ok」，无法证明原生 sandbox（含 bash）校验通过`,
    );
  }
}

function assertFailureEvidence(version: RuntimeEnvironmentVersion): void {
  if (version.status !== 'failed')
    conflict(`失败验收版本 ${version.id} 实际状态为 ${version.status}，不是 failed`);
  if (version.error === null || version.error.trim() === '') {
    gap(`失败版本 ${version.id} 没有失败原因`);
  }
  if (
    !version.buildLog.includes(FAILURE_MARKER) ||
    !/exit code:\s*1|exit 1/.test(version.buildLog)
  ) {
    gap(`失败版本 ${version.id} 的日志缺少 RUN 非零退出证据，不能证明是预期失败`);
  }
}

function recordVersion(
  manifest: RuntimeManifest,
  key: 'success' | 'failure',
  version: RuntimeEnvironmentVersion,
  scenario: string,
): void {
  manifest.versions[key] = {
    id: version.id,
    scenario,
    status: version.status,
    recordedAt: new Date().toISOString(),
  };
  manifest.relations = {
    environmentId: manifest.runtimeEnvironmentId,
    successVersionId: manifest.versions.success?.id ?? null,
    failureVersionId: manifest.versions.failure?.id ?? null,
    publishedVersionId: manifest.publishedVersionId,
  };
}

function newManifest(origin: string, environmentId: string): RuntimeManifest {
  return {
    dataset: DATASET_ID,
    section: 'runtime',
    source: { origin, via: 'e2e-ui', updatedAt: new Date().toISOString() },
    environmentName: ENVIRONMENT_NAME,
    runtimeEnvironmentId: environmentId,
    publishedVersionId: null,
    versions: { success: null, failure: null },
    relations: {
      environmentId,
      successVersionId: null,
      failureVersionId: null,
      publishedVersionId: null,
    },
    status: 'in_progress',
    gaps: [],
  };
}

async function readReadyManifest(): Promise<RuntimeManifest> {
  if (!(await manifestExists('runtime'))) {
    gap('缺少 runtime manifest，请先执行 pnpm dev:data');
  }
  const manifest = await loadManifest();
  if (manifest === null) gap('缺少 runtime manifest，请先执行 pnpm dev:data');
  if (manifest.dataset !== DATASET_ID)
    conflict(`manifest dataset 为 ${manifest.dataset}，期望 ${DATASET_ID}`);
  if (typeof manifest.runtimeEnvironmentId !== 'string' || manifest.runtimeEnvironmentId === '')
    conflict('manifest 缺少 runtimeEnvironmentId');
  if (manifest.status !== 'ready') gap(`manifest 状态为 ${manifest.status}，不是 ready`);
  return manifest;
}

/** 纯读验收：只发 GET（通过业务 API）与页面导航，不写 manifest、不构建、不发布。 */
async function verifyDataset(browser: Browser): Promise<void> {
  const manifest = await readReadyManifest();
  const environment = await fetchEnvironment(browser, manifest.runtimeEnvironmentId);
  if (environment.name !== ENVIRONMENT_NAME) {
    conflict(`环境 ${environment.id} 名称为「${environment.name}」，期望「${ENVIRONMENT_NAME}」`);
  }
  if (environment.isDefault) conflict('数据集环境被设成了平台默认环境');
  if (environment.dockerfile !== NORMAL_DOCKERFILE) {
    conflict('数据集环境当前 Dockerfile 不是正常草稿');
  }
  if (manifest.publishedVersionId === null) gap('manifest 没有 publishedVersionId');
  if (environment.onlineVersionId !== manifest.publishedVersionId) {
    conflict(
      `线上指针为 ${environment.onlineVersionId}，与 manifest ${manifest.publishedVersionId} 不一致`,
    );
  }
  const successId = manifest.versions.success?.id;
  const failureId = manifest.versions.failure?.id;
  if (successId === undefined || failureId === undefined) gap('manifest 缺少成功或失败版本 ID');
  const success = await fetchVersion(browser, environment.id, successId);
  const failure = await fetchVersion(browser, environment.id, failureId);
  assertSuccessEvidence(success);
  assertFailureEvidence(failure);
}

test('dev data: 青禾采购运行环境（正常版本发布 + RUN 非零失败版本）', {
  session: 'admin',
  timeout: 75 * 60_000,
}, async ({ app, screen, browser }) => {
  test.skip(
    process.env.E2E_DEV_DATA !== '1',
    '专用数据构建用例：仅 E2E_DEV_DATA=1 时运行，普通回归不执行',
  );
  await app.open('/runtime-environments');
  if (process.env.E2E_DEV_DATA_VERIFY === '1') {
    await verifyDataset(browser);
    return;
  }
  const origin = new URL(await browser.url()).origin;

  const list = await api<RuntimeEnvironment[]>(browser, '/api/runtime-environments');
  let manifest = await loadManifest();
  if (manifest !== null) {
    if (manifest.dataset !== DATASET_ID) {
      conflict(`manifest dataset 为 ${manifest.dataset}，期望 ${DATASET_ID}`);
    }
    if (manifest.environmentName !== ENVIRONMENT_NAME) {
      conflict(`manifest 环境名称与固定名称不一致：${manifest.environmentName}`);
    }
    if (typeof manifest.runtimeEnvironmentId !== 'string' || manifest.runtimeEnvironmentId === '') {
      conflict('manifest 缺少 runtimeEnvironmentId');
    }
  }

  const named = list.filter((environment) => environment.name === ENVIRONMENT_NAME);
  let environment: RuntimeEnvironment;
  if (manifest !== null) {
    const byId = list.find((candidate) => candidate.id === manifest?.runtimeEnvironmentId);
    if (byId === undefined) {
      if (named.length > 0) {
        conflict(
          `manifest 记录的 ${manifest.runtimeEnvironmentId} 不存在，但同名环境 ${named[0]?.id} 存在（ID 不一致）`,
        );
      }
      conflict(`manifest 记录的环境 ${manifest.runtimeEnvironmentId} 已不存在`);
    }
    if (byId.name !== ENVIRONMENT_NAME) {
      conflict(
        `manifest 记录的环境 ${byId.id} 当前名称为「${byId.name}」，期望「${ENVIRONMENT_NAME}」`,
      );
    }
    if (named.length > 0 && named[0]?.id !== byId.id) {
      conflict(`固定名称被另一个环境 ${named[0]?.id} 占用`);
    }
    environment = byId;
    if (environment.isDefault) conflict('数据集环境被设成了平台默认环境');
    if (!ACCEPTED_DOCKERFILES.has(environment.dockerfile)) {
      conflict('数据集环境 Dockerfile 已被开发者修改，不是本数据集写入的正常/失败版本');
    }
    if (
      manifest.publishedVersionId !== null &&
      environment.onlineVersionId !== manifest.publishedVersionId
    ) {
      conflict(
        `线上指针已被改动（当前 ${environment.onlineVersionId}，manifest ${manifest.publishedVersionId}）`,
      );
    }
  } else if (named.length > 0) {
    // 无 manifest 时归属不明，不能按名称或 Dockerfile 推断；立即停止交人工确认。
    conflict(
      `已存在同名环境 ${named.map((candidate) => candidate.id).join('、')}，但 manifest 未记录其归属`,
    );
  } else {
    environment = await fetchEnvironment(browser, await createEnvironment(browser, screen));
  }

  if (manifest === null) {
    manifest = newManifest(origin, environment.id);
  }
  manifest.source = { origin, via: 'e2e-ui', updatedAt: new Date().toISOString() };
  manifest.runtimeEnvironmentId = environment.id;
  await writeManifest('runtime', manifest);

  // 只有显式指定当前失败版本才能重建；旧版本和真实错误先落历史，绝不重试新产生的失败。
  const success = manifest.versions.success;
  let successVersion =
    success === null ? null : await pollVersion(browser, environment.id, success.id, '成功');
  if (
    successVersion?.status === 'failed' &&
    process.env.E2E_DEV_DATA_RETRY_RUNTIME_VERSION === successVersion.id
  ) {
    manifest.failedAttempts ??= [];
    if (!manifest.failedAttempts.some((attempt) => attempt.id === successVersion?.id)) {
      manifest.failedAttempts.push({
        id: successVersion.id,
        scenario: NORMAL_SCENARIO,
        status: 'failed',
        error: successVersion.error,
        baseImageId: successVersion.baseImageId,
        recordedAt: new Date().toISOString(),
      });
    }
    await writeManifest('runtime', manifest);
    successVersion = null;
  }
  if (successVersion === null) {
    await openEnvironment(app, screen, environment.id);
    await ensureDockerfile(browser, screen, app, environment.id, NORMAL_DOCKERFILE);
    const queued = await startBuild(browser, screen, environment.id);
    recordVersion(manifest, 'success', queued, NORMAL_SCENARIO);
    await writeManifest('runtime', manifest);
    successVersion = await pollVersion(browser, environment.id, queued.id, '成功');
  }
  assertSuccessEvidence(successVersion);
  const beforePublish = await fetchEnvironment(browser, environment.id);
  if (beforePublish.onlineVersionId !== successVersion.id) {
    if (beforePublish.onlineVersionId !== null) {
      conflict(
        `线上指针已被外部改为 ${beforePublish.onlineVersionId}，不会覆盖为 ${successVersion.id}`,
      );
    }
    await publishVersion(browser, screen, app, environment.id, successVersion.id);
  }
  manifest.publishedVersionId = successVersion.id;
  recordVersion(manifest, 'success', successVersion, NORMAL_SCENARIO);
  await writeManifest('runtime', manifest);

  // 失败版本：同一基座上显式 RUN exit 1，只跑一次；重跑只读取已记录 ID。
  let failureVersion: RuntimeEnvironmentVersion;
  if (manifest.versions.failure !== null) {
    failureVersion = await pollVersion(
      browser,
      environment.id,
      manifest.versions.failure.id,
      '失败验收',
    );
  } else {
    await ensureDockerfile(browser, screen, app, environment.id, FAILURE_DOCKERFILE);
    const queued = await startBuild(browser, screen, environment.id);
    recordVersion(manifest, 'failure', queued, FAILURE_SCENARIO);
    await writeManifest('runtime', manifest);
    failureVersion = await pollVersion(browser, environment.id, queued.id, '失败验收');
  }
  assertFailureEvidence(failureVersion);
  recordVersion(manifest, 'failure', failureVersion, FAILURE_SCENARIO);
  await writeManifest('runtime', manifest);

  // 最终草稿恢复为正常 Dockerfile；失败构建只留版本记录，线上指针仍是成功版本。
  if (failureVersion.status === 'failed') {
    await ensureDockerfile(browser, screen, app, environment.id, NORMAL_DOCKERFILE);
  }
  const finalEnvironment = await waitForEnvironment(
    browser,
    environment.id,
    (candidate) =>
      candidate.onlineVersionId === successVersion.id && candidate.dockerfile === NORMAL_DOCKERFILE,
    `线上指针 ${successVersion.id} 或正常草稿未生效`,
  );
  if (finalEnvironment.isDefault) conflict('数据集环境不能是平台默认环境');
  if (finalEnvironment.onlineVersionId !== manifest.publishedVersionId) {
    conflict('最终线上指针与 manifest 不一致');
  }
  manifest.relations = {
    environmentId: environment.id,
    successVersionId: successVersion.id,
    failureVersionId: failureVersion.id,
    publishedVersionId: manifest.publishedVersionId,
  };
  manifest.status = manifest.gaps.length === 0 ? 'ready' : 'partial';
  manifest.source = { origin, via: 'e2e-ui', updatedAt: new Date().toISOString() };
  await writeManifest('runtime', manifest);
});

test('dev data verify: 青禾运行环境只读验收', { session: 'admin', tags: ['verify'] }, async ({
  app,
  browser,
}) => {
  test.skip(process.env.E2E_DEV_DATA !== '1', '专用数据验收用例：仅 pnpm dev:data:verify 时运行');
  await app.open('/runtime-environments');
  await verifyDataset(browser);
});
