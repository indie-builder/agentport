import type { Logger } from 'pino';

/** 默认环境登记只需这两个 DB 能力；与 repo 的方法一一对应。 */
export interface DefaultEnvironmentStore {
  getDefault: () => Promise<{ id: string } | null>;
  register: (image: { imageTag: string; imageId: string }) => Promise<unknown>;
}

export interface DefaultEnvironmentDeps {
  store: DefaultEnvironmentStore;
  /** 复用 DockerSandboxProvider.ensureImage：缺失时拉取，不另造一套。 */
  ensureImage: (image: string, signal: AbortSignal) => Promise<void>;
  resolveImageId: (image: string) => Promise<string | null>;
  sandboxImage: string;
  signal: AbortSignal;
  logger: Logger;
}

export const DEFAULT_ENVIRONMENT_RETRY_MS = 60_000;

/**
 * 只在默认环境不存在时确保基座本地可用（缺失则 pull）并用真实 image ID 登记。
 * 已存在时完全不 inspect/pull：启动配置不是发布，不推进线上指针。
 */
export async function ensureDefaultEnvironment(
  deps: DefaultEnvironmentDeps,
): Promise<'exists' | 'registered'> {
  if ((await deps.store.getDefault()) !== null) return 'exists';
  // 首次部署远程基座本地没有时，必须先拉取，否则登记出的环境无法创建容器。
  await deps.ensureImage(deps.sandboxImage, deps.signal);
  const imageId = await deps.resolveImageId(deps.sandboxImage);
  if (imageId === null) {
    throw new Error(`sandbox image ${deps.sandboxImage} is not present locally after pull`);
  }
  await deps.store.register({ imageTag: deps.sandboxImage, imageId });
  deps.logger.info({ image: deps.sandboxImage, imageId }, 'default runtime environment registered');
  return 'registered';
}

/**
 * 启动登记失败后按固定间隔重试，直到成功或关闭；不把失败伪装成可用。
 * 基座拉取失败通常是 daemon/registry 暂时不可用，重启 worker 也能恢复。
 */
export function startDefaultEnvironmentRetry(
  deps: DefaultEnvironmentDeps,
  retryMs: number = DEFAULT_ENVIRONMENT_RETRY_MS,
): () => Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let stopped = false;
  const attempt = (): void => {
    if (stopped || deps.signal.aborted) return;
    inFlight = ensureDefaultEnvironment(deps).then(
      () => undefined,
      (err: unknown) => {
        deps.logger.error(
          { err, image: deps.sandboxImage },
          'default runtime environment registration failed; retrying',
        );
        if (stopped || deps.signal.aborted) return;
        timer = setTimeout(attempt, retryMs);
        timer.unref();
      },
    );
  };
  timer = setTimeout(attempt, retryMs);
  timer.unref();
  return async () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    // 关闭时等仍在进行的拉取/登记收尾（abort 会结束拉取），避免关池后还有查询。
    await inFlight;
  };
}
